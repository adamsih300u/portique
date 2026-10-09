//! Password-protected vault: every secret Portique stores (saved passwords, key passphrases,
//! imported private keys) lives in one portable file, `vault.bin`.
//!
//! Format: JSON envelope `{version, kdf, nonce, ciphertext}`. The master password is stretched
//! with Argon2id; the payload is sealed with XChaCha20-Poly1305 (random 192-bit nonce per save)
//! and the envelope's version + KDF parameters are authenticated as associated data.
//! Only symmetric primitives are used, so there is nothing for Shor's algorithm to break;
//! Grover's algorithm leaves a 256-bit key with ~128 bits of strength.

use crate::store;
use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, Generate, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

pub const MIN_PASSWORD_LEN: usize = 12;
const VERSION: u32 = 1;

/// Error text the frontend matches on to trigger its unlock prompt.
pub const LOCKED_MSG: &str = "vault is locked";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Kdf {
    /// Memory in KiB.
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

impl Kdf {
    pub const DEFAULT: Kdf = Kdf { m: 128 * 1024, t: 3, p: 4 };
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u32,
    kdf: Kdf,
    salt: String,
    nonce: String,
    ciphertext: String,
}

impl Envelope {
    /// Authenticated header: tampering with version or KDF parameters fails decryption.
    fn aad(version: u32, kdf: &Kdf, salt: &[u8]) -> Vec<u8> {
        // Frozen format identifier from before the rename: it is authenticated data inside existing vault files.
        let mut a = b"termix-vault".to_vec();
        for n in [version, kdf.m, kdf.t, kdf.p] {
            a.extend(n.to_le_bytes());
        }
        a.extend(salt);
        a
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Data {
    secrets: HashMap<String, String>,
}

impl Drop for Data {
    fn drop(&mut self) {
        for (_, mut v) in self.secrets.drain() {
            v.zeroize();
        }
    }
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    kdf: Kdf,
    salt: Vec<u8>,
    data: Data,
    last_used: Instant,
}

pub struct Vault {
    path: PathBuf,
    state: Option<Unlocked>,
}

fn derive(password: &str, salt: &[u8], kdf: &Kdf) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| anyhow!("bad KDF parameters: {e}"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|e| anyhow!("key derivation failed: {e}"))?;
    Ok(key)
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, state: None }
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    pub fn is_unlocked(&self) -> bool {
        self.state.is_some()
    }

    pub fn create(&mut self, password: &str, kdf: Kdf) -> Result<()> {
        if self.exists() {
            bail!("a vault already exists");
        }
        if password.chars().count() < MIN_PASSWORD_LEN {
            bail!("master password must be at least {MIN_PASSWORD_LEN} characters");
        }
        let mut salt = vec![0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| anyhow!("no randomness available: {e}"))?;
        let key = derive(password, &salt, &kdf)?;
        self.state = Some(Unlocked { key, kdf, salt, data: Data::default(), last_used: Instant::now() });
        self.save()
    }

    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let env: Envelope = serde_json::from_slice(&std::fs::read(&self.path).context("cannot read vault")?)
            .context("vault file is corrupt")?;
        if env.version != VERSION {
            bail!("unsupported vault version {}", env.version);
        }
        // The header is untrusted until decryption succeeds: bound the cost it can demand.
        let k = env.kdf;
        if k.m == 0 || k.m > 1024 * 1024 || k.t == 0 || k.t > 32 || k.p == 0 || k.p > 32 {
            bail!("vault file has unreasonable key-derivation parameters (corrupt or tampered)");
        }
        let salt = B64.decode(&env.salt)?;
        let nonce_bytes = B64.decode(&env.nonce)?;
        let nonce = XNonce::try_from(nonce_bytes.as_slice()).map_err(|_| anyhow!("vault file is corrupt"))?;
        let ct = B64.decode(&env.ciphertext)?;
        let key = derive(password, &salt, &env.kdf)?;
        let cipher = XChaCha20Poly1305::new((&*key).into());
        let aad = Envelope::aad(env.version, &env.kdf, &salt);
        let plain = Zeroizing::new(
            cipher
                .decrypt(&nonce, Payload { msg: &ct, aad: &aad })
                .map_err(|_| anyhow!("wrong master password (or the vault file was modified)"))?,
        );
        let data: Data = serde_json::from_slice(&plain).context("vault contents are corrupt")?;
        self.state = Some(Unlocked { key, kdf: env.kdf, salt, data, last_used: Instant::now() });
        Ok(())
    }

    pub fn lock(&mut self) {
        self.state = None; // Drop zeroizes the key and every secret.
    }

    pub fn change_password(&mut self, old: &str, new: &str) -> Result<()> {
        if new.chars().count() < MIN_PASSWORD_LEN {
            bail!("master password must be at least {MIN_PASSWORD_LEN} characters");
        }
        let kdf = self.unlocked()?.kdf;
        // Re-verify the old password against the file rather than trusting the unlocked session.
        let mut probe = Vault::new(self.path.clone());
        probe.unlock(old)?;
        let mut salt = vec![0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| anyhow!("no randomness available: {e}"))?;
        let key = derive(new, &salt, &kdf)?;
        let st = self.unlocked()?;
        let (old_key, old_salt) = (std::mem::replace(&mut st.key, key), std::mem::replace(&mut st.salt, salt));
        if let Err(e) = self.save() {
            // Keep memory consistent with the file that is still on disk.
            let st = self.unlocked()?;
            st.key = old_key;
            st.salt = old_salt;
            return Err(e);
        }
        Ok(())
    }

    fn unlocked(&mut self) -> Result<&mut Unlocked> {
        let st = self.state.as_mut().ok_or_else(|| anyhow!(LOCKED_MSG))?;
        st.last_used = Instant::now();
        Ok(st)
    }

    pub fn touch(&mut self) {
        if let Some(s) = self.state.as_mut() {
            s.last_used = Instant::now();
        }
    }

    /// Locks if idle too long; returns true if it did.
    pub fn lock_if_idle(&mut self, idle: Duration) -> bool {
        if self.state.as_ref().is_some_and(|s| s.last_used.elapsed() > idle) {
            self.lock();
            return true;
        }
        false
    }

    pub fn get(&mut self, name: &str) -> Result<Option<String>> {
        Ok(self.unlocked()?.data.secrets.get(name).cloned())
    }

    pub fn contains(&mut self, name: &str) -> Result<bool> {
        Ok(self.unlocked()?.data.secrets.contains_key(name))
    }

    pub fn set(&mut self, name: &str, value: &str) -> Result<()> {
        self.unlocked()?.data.secrets.insert(name.to_string(), value.to_string());
        self.save()
    }

    pub fn delete(&mut self, name: &str) -> Result<()> {
        if let Some(mut v) = self.unlocked()?.data.secrets.remove(name) {
            v.zeroize();
            self.save()?;
        }
        Ok(())
    }

    fn save(&mut self) -> Result<()> {
        let st = self.state.as_ref().ok_or_else(|| anyhow!(LOCKED_MSG))?;
        let plain = Zeroizing::new(serde_json::to_vec(&st.data)?);
        let nonce = XNonce::generate();
        let aad = Envelope::aad(VERSION, &st.kdf, &st.salt);
        let ct = XChaCha20Poly1305::new((&*st.key).into())
            .encrypt(&nonce, Payload { msg: &plain, aad: &aad })
            .map_err(|_| anyhow!("encryption failed"))?;
        let env = Envelope {
            version: VERSION,
            kdf: st.kdf,
            salt: B64.encode(&st.salt),
            nonce: B64.encode(nonce.as_slice()),
            ciphertext: B64.encode(ct),
        };
        // Write-then-rename so a crash never leaves a truncated vault.
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&env)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

static VAULT: LazyLock<Mutex<Vault>> = LazyLock::new(|| {
    let dir = store::data_dir().unwrap_or_else(|_| PathBuf::from("."));
    Mutex::new(Vault::new(dir.join("vault.bin")))
});

pub fn global() -> MutexGuard<'static, Vault> {
    VAULT.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn password_account(profile_id: &str) -> String {
    format!("profile:{profile_id}:password")
}
pub fn passphrase_account(key_id: &str) -> String {
    format!("key:{key_id}:passphrase")
}
pub fn key_account(key_id: &str) -> String {
    format!("key:{key_id}:private")
}

pub fn is_locked_error(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.to_string() == LOCKED_MSG)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: Kdf = Kdf { m: 64, t: 1, p: 1 };
    const PW: &str = "correct horse battery";

    fn vault() -> (tempfile::TempDir, Vault) {
        let d = tempfile::tempdir().unwrap();
        let v = Vault::new(d.path().join("vault.bin"));
        (d, v)
    }

    #[test]
    fn round_trip_and_persistence() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "s3cret").unwrap();
        v.lock();
        assert_eq!(v.get("a").unwrap_err().to_string(), LOCKED_MSG);
        let mut v2 = Vault::new(d.path().join("vault.bin"));
        v2.unlock(PW).unwrap();
        assert_eq!(v2.get("a").unwrap().as_deref(), Some("s3cret"));
    }

    #[test]
    fn file_does_not_contain_plaintext() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("host-pw", "UNIQUE-PLAINTEXT-MARKER").unwrap();
        let raw = std::fs::read_to_string(d.path().join("vault.bin")).unwrap();
        assert!(!raw.contains("UNIQUE-PLAINTEXT-MARKER") && !raw.contains("host-pw"));
    }

    #[test]
    fn wrong_password_and_short_password_rejected() {
        let (_d, mut v) = vault();
        assert!(v.create("short", FAST).is_err());
        v.create(PW, FAST).unwrap();
        v.lock();
        assert!(v.unlock("incorrect horse battery").is_err());
        assert!(!v.is_unlocked());
    }

    #[test]
    fn tampering_is_detected() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "b").unwrap();
        v.lock();
        let p = d.path().join("vault.bin");
        // Flip KDF params (authenticated as AAD) -> must fail even with the right password.
        let mut env: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        env["kdf"]["t"] = 2.into();
        std::fs::write(&p, serde_json::to_vec(&env).unwrap()).unwrap();
        assert!(v.unlock(PW).is_err());
    }

    #[test]
    fn nonce_is_fresh_each_save() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        let read = || std::fs::read_to_string(d.path().join("vault.bin")).unwrap();
        let a = read();
        v.set("x", "1").unwrap();
        let (ea, eb): (serde_json::Value, serde_json::Value) = (serde_json::from_str(&a).unwrap(), serde_json::from_str(&read()).unwrap());
        assert_ne!(ea["nonce"], eb["nonce"]);
    }

    #[test]
    fn change_password() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "b").unwrap();
        assert!(v.change_password("wrong wrong wrong", "another long password").is_err());
        v.change_password(PW, "another long password").unwrap();
        let mut v2 = Vault::new(d.path().join("vault.bin"));
        assert!(v2.unlock(PW).is_err());
        v2.unlock("another long password").unwrap();
        assert_eq!(v2.get("a").unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn hostile_kdf_parameters_are_refused_before_deriving() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.lock();
        let p = d.path().join("vault.bin");
        let mut env: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        env["kdf"]["m"] = 4_000_000_000u64.into();
        std::fs::write(&p, serde_json::to_vec(&env).unwrap()).unwrap();
        let t = Instant::now();
        assert!(v.unlock(PW).unwrap_err().to_string().contains("unreasonable"));
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn idle_lock() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        assert!(!v.lock_if_idle(Duration::from_secs(60)));
        assert!(v.lock_if_idle(Duration::ZERO));
        assert!(!v.is_unlocked());
    }
}
