//! Password-protected vault: every secret Portique stores (saved passwords, key passphrases,
//! imported private keys) lives in one portable file, `vault.bin`.
//!
//! Format: JSON envelope `{version, kdf, nonce, ciphertext}`. The master password is stretched
//! with Argon2id; the payload is sealed with XChaCha20-Poly1305 (random 192-bit nonce per save)
//! and the envelope's version + KDF parameters are authenticated as associated data.
//! The payload also carries a `generation` that rises with every save. Each computer records the
//! highest one it has opened in a small file outside the portable set (`vault.seen`), so a
//! restored older `vault.bin` is noticed instead of silently decrypting.
//! While unlocked, each secret is kept sealed in memory under a random per-unlock key and is
//! opened one at a time, for as long as it is being used, then zeroized. Both keys (the file key
//! and that per-unlock key) live in locked pages of their own (see `memguard`), so they are not
//! swapped out or written to a core dump.
//! Only symmetric primitives are used, so there is nothing for Shor's algorithm to break;
//! Grover's algorithm leaves a 256-bit key with ~128 bits of strength.

use crate::{memguard::LockedKey, store};
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
/// Lowest zxcvbn score (0-4) a master password may have. 4 means at least 10^10 guesses.
pub const MIN_SCORE: u8 = 4;
const VERSION: u32 = 1;

/// Error text the frontend matches on to trigger its unlock prompt.
pub const LOCKED_MSG: &str = "vault is locked";
/// Start of the error `unlock` returns for a vault older than the last one this computer opened.
pub const OLDER_MSG: &str = "vault is older than";

/// How hard a candidate master password is to guess, with zxcvbn's advice on improving it.
#[derive(Serialize)]
pub struct Strength {
    pub score: u8,
    pub ok: bool,
    pub advice: String,
}

/// Rates `password`. Only the first 128 characters are scored, which keeps the estimator fast on pasted text.
pub fn assess(password: &str) -> Strength {
    let head: Zeroizing<String> = Zeroizing::new(password.chars().take(128).collect());
    let est = zxcvbn::zxcvbn(&head, &["portique", "termix", "vault"]);
    let score = u8::from(est.score());
    let advice = est
        .feedback()
        .map(|f| {
            let mut parts = Vec::new();
            if let Some(w) = f.warning() {
                parts.push(w.to_string());
            }
            parts.extend(f.suggestions().iter().map(|s| s.to_string()));
            parts.join(" ")
        })
        .unwrap_or_default();
    let ok = password.chars().count() >= MIN_PASSWORD_LEN && score >= MIN_SCORE;
    Strength { score, ok, advice }
}

fn require_strong(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        bail!("master password must be at least {MIN_PASSWORD_LEN} characters");
    }
    let s = assess(password);
    if s.score < MIN_SCORE {
        bail!("master password is too easy to guess. {}", if s.advice.is_empty() { "Try several unrelated words." } else { &s.advice });
    }
    Ok(())
}

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
    /// Counts saves. Vaults written before it existed read as 0.
    #[serde(default)]
    generation: u64,
}

impl Drop for Data {
    fn drop(&mut self) {
        for (_, mut v) in self.secrets.drain() {
            v.zeroize();
        }
    }
}

/// The secrets while the vault is unlocked: every value is sealed (XChaCha20-Poly1305, fresh
/// nonce, the secret's name as associated data) under `shield`, a random key made at unlock that
/// never touches disk. Only the secret being used is ever plain text, and only briefly.
struct Secrets {
    shield: LockedKey,
    /// name -> nonce followed by ciphertext.
    items: HashMap<String, Vec<u8>>,
}

impl Secrets {
    fn new() -> Result<Self> {
        Ok(Self { shield: LockedKey::random()?, items: HashMap::new() })
    }

    /// Seals every value of `data`; the plain copies are zeroized when `data` drops.
    fn from_data(mut data: Data) -> Result<Self> {
        let mut me = Self::new()?;
        for (name, mut value) in data.secrets.drain() {
            let sealed = me.insert(&name, &value);
            value.zeroize();
            sealed?;
        }
        Ok(me)
    }

    fn insert(&mut self, name: &str, value: &str) -> Result<()> {
        let nonce = XNonce::generate();
        let ct = XChaCha20Poly1305::new(self.shield.as_array().into())
            .encrypt(&nonce, Payload { msg: value.as_bytes(), aad: name.as_bytes() })
            .map_err(|_| anyhow!("encryption failed"))?;
        let mut blob = nonce.to_vec();
        blob.extend(ct);
        self.items.insert(name.to_string(), blob);
        Ok(())
    }

    /// Opens one secret. The caller holds the only plain copy and it is zeroized on drop.
    fn open(&self, name: &str) -> Result<Option<Zeroizing<String>>> {
        let Some(blob) = self.items.get(name) else { return Ok(None) };
        let corrupt = || anyhow!("a secret held in memory is corrupt");
        if blob.len() < 24 {
            return Err(corrupt());
        }
        let (nonce, ct) = blob.split_at(24);
        let nonce = XNonce::try_from(nonce).map_err(|_| corrupt())?;
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new(self.shield.as_array().into())
                .decrypt(&nonce, Payload { msg: ct, aad: name.as_bytes() })
                .map_err(|_| corrupt())?,
        );
        Ok(Some(Zeroizing::new(String::from_utf8(plain.to_vec()).map_err(|_| corrupt())?)))
    }

    /// Every secret in plain text, for writing the file. Short-lived: it zeroizes on drop.
    fn to_data(&self, generation: u64) -> Result<Data> {
        let mut data = Data { secrets: HashMap::new(), generation };
        for name in self.items.keys() {
            if let Some(v) = self.open(name)? {
                data.secrets.insert(name.clone(), (*v).clone());
            }
        }
        Ok(data)
    }
}

struct Unlocked {
    key: LockedKey,
    kdf: Kdf,
    salt: Vec<u8>,
    secrets: Secrets,
    generation: u64,
    last_used: Instant,
}

pub struct Vault {
    path: PathBuf,
    /// Where the highest generation opened on this computer is kept.
    seen: PathBuf,
    state: Option<Unlocked>,
    /// How many times this process has opened the vault. Not saved: it only tells "still the same unlock" from "locked and opened again".
    unlocks: u64,
}

fn derive(password: &str, salt: &[u8], kdf: &Kdf) -> Result<LockedKey> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| anyhow!("bad KDF parameters: {e}"))?;
    let mut key = LockedKey::new();
    // Written straight into the locked page, never staged in an ordinary buffer.
    key.fill(|out| {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), salt, out)
            .map_err(|e| anyhow!("key derivation failed: {e}"))
    })?;
    Ok(key)
}

impl Unlocked {
    /// Says so on stderr if a key could not be pinned in RAM; the vault works either way.
    fn note_if_unpinned(&self) {
        if !(self.key.is_locked() && self.secrets.shield.is_locked()) {
            eprintln!("note: could not lock the vault's keys in memory; they may be swapped out under pressure");
        }
    }
}

impl Vault {
    pub fn new(path: PathBuf, seen: PathBuf) -> Self {
        Self { path, seen, state: None, unlocks: 0 }
    }

    /// The highest generation this computer has opened; 0 if none is recorded (or the note is unreadable).
    fn last_seen(&self) -> u64 {
        std::fs::read_to_string(&self.seen).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }

    /// Best effort: a failure here only weakens rollback detection, so it never blocks the vault.
    fn record_seen(&self, generation: u64) {
        if let Some(dir) = self.seen.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.seen.with_extension("tmp");
        if std::fs::write(&tmp, generation.to_string()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, &self.seen);
        }
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
        require_strong(password)?;
        let mut salt = vec![0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| anyhow!("no randomness available: {e}"))?;
        let key = derive(password, &salt, &kdf)?;
        let st = Unlocked { key, kdf, salt, secrets: Secrets::new()?, generation: 0, last_used: Instant::now() };
        st.note_if_unpinned();
        self.state = Some(st);
        self.unlocks += 1;
        self.save()?;
        // A new vault starts a new history, whatever an earlier one left behind.
        let generation = self.unlocked()?.generation;
        self.record_seen(generation);
        Ok(())
    }

    /// Decrypts the file. Does not look at rollback or change `self`.
    fn read(&self, password: &str) -> Result<Unlocked> {
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
        let cipher = XChaCha20Poly1305::new(key.as_array().into());
        let aad = Envelope::aad(env.version, &env.kdf, &salt);
        let plain = Zeroizing::new(
            cipher
                .decrypt(&nonce, Payload { msg: &ct, aad: &aad })
                .map_err(|_| anyhow!("wrong master password (or the vault file was modified)"))?,
        );
        let data: Data = serde_json::from_slice(&plain).context("vault contents are corrupt")?;
        let generation = data.generation;
        Ok(Unlocked { key, kdf: env.kdf, salt, secrets: Secrets::from_data(data)?, generation, last_used: Instant::now() })
    }

    /// Opens the vault. A file whose generation is below the last one this computer opened was
    /// probably restored from an older copy; that fails with `OLDER_MSG` unless `accept_older`.
    pub fn unlock(&mut self, password: &str, accept_older: bool) -> Result<()> {
        let st = self.read(password)?;
        let (found, seen) = (st.generation, self.last_seen());
        if found < seen && !accept_older {
            bail!(
                "{OLDER_MSG} the last one opened on this computer (saved {found} times, was {seen}). \
                 It may be a restored backup or a swapped file, and anything changed since then is missing."
            );
        }
        self.record_seen(found);
        st.note_if_unpinned();
        self.state = Some(st);
        self.unlocks += 1;
        Ok(())
    }

    /// Checks a password against the vault file without changing whether it is open. It costs a full key derivation.
    pub fn verify(&self, password: &str) -> Result<()> {
        self.read(password).map(drop)
    }

    /// Which opening of the vault this is, or `None` while it is locked. A value held earlier is the same unlock only if it matches.
    pub fn epoch(&self) -> Option<u64> {
        self.state.is_some().then_some(self.unlocks)
    }

    pub fn lock(&mut self) {
        self.state = None; // Drop zeroizes the key and every secret.
    }

    pub fn change_password(&mut self, old: &str, new: &str) -> Result<()> {
        require_strong(new)?;
        let kdf = self.unlocked()?.kdf;
        // Re-verify the old password against the file rather than trusting the unlocked session.
        self.read(old)?;
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

    /// Opens one secret; the returned copy zeroizes itself when dropped.
    pub fn get(&mut self, name: &str) -> Result<Option<Zeroizing<String>>> {
        self.unlocked()?.secrets.open(name)
    }

    pub fn contains(&mut self, name: &str) -> Result<bool> {
        Ok(self.unlocked()?.secrets.items.contains_key(name))
    }

    pub fn set(&mut self, name: &str, value: &str) -> Result<()> {
        self.unlocked()?.secrets.insert(name, value)?;
        self.save()
    }

    pub fn delete(&mut self, name: &str) -> Result<()> {
        if self.unlocked()?.secrets.items.remove(name).is_some() {
            self.save()?;
        }
        Ok(())
    }

    fn save(&mut self) -> Result<()> {
        let st = self.state.as_mut().ok_or_else(|| anyhow!(LOCKED_MSG))?;
        st.generation += 1;
        let result = self.write_file();
        if result.is_err() {
            if let Some(st) = self.state.as_mut() {
                st.generation -= 1;
            }
        }
        result
    }

    fn write_file(&self) -> Result<()> {
        let st = self.state.as_ref().ok_or_else(|| anyhow!(LOCKED_MSG))?;
        let plain = Zeroizing::new(serde_json::to_vec(&st.secrets.to_data(st.generation)?)?);
        let nonce = XNonce::generate();
        let aad = Envelope::aad(VERSION, &st.kdf, &st.salt);
        let ct = XChaCha20Poly1305::new(st.key.as_array().into())
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
        self.record_seen(st.generation);
        Ok(())
    }
}

static VAULT: LazyLock<Mutex<Vault>> = LazyLock::new(|| {
    let dir = store::data_dir().unwrap_or_else(|_| PathBuf::from("."));
    // The note of the newest vault opened lives in the machine-local data folder, not next to
    // `vault.bin`, so copying or syncing the portable files never carries it along.
    let seen = dirs::data_local_dir().map(|d| d.join("portique")).unwrap_or_else(|| dir.clone()).join("vault.seen");
    Mutex::new(Vault::new(dir.join("vault.bin"), seen))
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
    const PW: &str = "pylon-quartz-marmot-velvet-9";
    const PW2: &str = "tundra gimlet orbit saffron 41";

    fn vault() -> (tempfile::TempDir, Vault) {
        let d = tempfile::tempdir().unwrap();
        let v = again(&d);
        (d, v)
    }

    /// A second handle on the same vault file and the same "seen" note, like a restart.
    fn again(d: &tempfile::TempDir) -> Vault {
        Vault::new(d.path().join("vault.bin"), d.path().join("local").join("vault.seen"))
    }

    #[test]
    fn round_trip_and_persistence() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "s3cret").unwrap();
        v.lock();
        assert_eq!(v.get("a").unwrap_err().to_string(), LOCKED_MSG);
        let mut v2 = again(&d);
        v2.unlock(PW, false).unwrap();
        assert_eq!(v2.get("a").unwrap().as_ref().map(|v| v.as_str()), Some("s3cret"));
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
        assert!(v.unlock("pylon-quartz-marmot-velvet-8", false).is_err());
        assert!(!v.is_unlocked());
    }

    #[test]
    fn restored_older_vault_is_refused_until_accepted() {
        let (d, mut v) = vault();
        let file = d.path().join("vault.bin");
        v.create(PW, FAST).unwrap();
        v.set("a", "1").unwrap();
        let backup = std::fs::read(&file).unwrap();
        v.set("b", "2").unwrap();
        v.lock();
        // Same computer, older file put back.
        std::fs::write(&file, &backup).unwrap();
        let e = v.unlock(PW, false).unwrap_err().to_string();
        assert!(e.starts_with(OLDER_MSG), "{e}");
        assert!(!v.is_unlocked());
        // The user says yes: it opens, and the note drops to match.
        v.unlock(PW, true).unwrap();
        assert!(v.contains("a").unwrap() && !v.contains("b").unwrap());
        v.lock();
        again(&d).unlock(PW, false).unwrap();
    }

    #[test]
    fn rollback_past_a_password_change_is_caught() {
        let (d, mut v) = vault();
        let file = d.path().join("vault.bin");
        v.create(PW, FAST).unwrap();
        let before = std::fs::read(&file).unwrap();
        v.change_password(PW, PW2).unwrap();
        v.lock();
        // An attacker who learned the old password restores the old file.
        std::fs::write(&file, &before).unwrap();
        assert!(v.unlock(PW, false).unwrap_err().to_string().starts_with(OLDER_MSG));
    }

    #[test]
    fn a_new_computer_trusts_the_file_and_then_tracks_it() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "1").unwrap();
        v.lock();
        // Copy only the portable file to a machine with no note.
        let d2 = tempfile::tempdir().unwrap();
        std::fs::copy(d.path().join("vault.bin"), d2.path().join("vault.bin")).unwrap();
        let mut w = again(&d2);
        w.unlock(PW, false).unwrap();
        w.set("b", "2").unwrap();
        w.lock();
        w.unlock(PW, false).unwrap();
        assert!(w.contains("b").unwrap());
    }

    #[test]
    fn verify_checks_the_password_without_opening_or_closing_anything() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        assert!(v.verify(PW).is_ok());
        assert!(v.verify("not the password at all").is_err());
        assert!(v.is_unlocked(), "a check leaves it open");
        v.lock();
        assert!(v.verify(PW).is_ok());
        assert!(!v.is_unlocked(), "and leaves it shut");
    }

    #[test]
    fn the_epoch_tells_one_unlock_from_the_next() {
        let (_d, mut v) = vault();
        assert_eq!(v.epoch(), None);
        v.create(PW, FAST).unwrap();
        let first = v.epoch().unwrap();
        v.set("a", "1").unwrap();
        assert_eq!(v.epoch(), Some(first), "saving is not a new unlock");
        v.lock();
        assert_eq!(v.epoch(), None);
        v.unlock(PW, false).unwrap();
        assert_ne!(v.epoch(), Some(first));
        let second = v.epoch().unwrap();
        assert!(v.unlock("wrong password here", false).is_err());
        assert_eq!(v.epoch(), Some(second), "a failed attempt changes nothing");
    }

    #[test]
    fn generation_rises_on_every_save_and_failed_saves_do_not_count() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        let seen = || std::fs::read_to_string(d.path().join("local").join("vault.seen")).unwrap();
        assert_eq!(seen(), "1");
        v.set("a", "1").unwrap();
        v.set("a", "2").unwrap();
        assert_eq!(seen(), "3");
        v.delete("a").unwrap();
        assert_eq!(seen(), "4");
        // Make the next write fail: a directory where the temporary file would go.
        std::fs::create_dir(d.path().join("vault.tmp")).unwrap();
        assert!(v.set("b", "1").is_err());
        assert_eq!(seen(), "4");
        std::fs::remove_dir(d.path().join("vault.tmp")).unwrap();
        v.set("b", "1").unwrap();
        assert_eq!(seen(), "5");
    }

    #[test]
    fn payloads_written_before_the_counter_still_load() {
        let old: Data = serde_json::from_str(r#"{"secrets":{"a":"1"}}"#).unwrap();
        assert_eq!(old.generation, 0);
        assert_eq!(old.secrets["a"], "1");
    }

    #[test]
    fn a_missing_note_is_trusted() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "1").unwrap();
        v.lock();
        // Wipe the note, as on a computer that has never seen this vault.
        std::fs::remove_file(d.path().join("local").join("vault.seen")).unwrap();
        v.unlock(PW, false).unwrap();
        assert!(v.contains("a").unwrap());
    }

    fn sealed(v: &Vault) -> &Secrets {
        &v.state.as_ref().unwrap().secrets
    }

    #[test]
    fn secrets_are_sealed_in_memory() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("acct", "UNIQUE-PLAINTEXT-MARKER").unwrap();
        let marker = b"UNIQUE-PLAINTEXT-MARKER";
        assert!(!sealed(&v).items["acct"].windows(marker.len()).any(|w| w == marker));
        assert_eq!(&**v.get("acct").unwrap().unwrap(), "UNIQUE-PLAINTEXT-MARKER");
        // Reopening from disk seals again.
        v.lock();
        v.unlock(PW, false).unwrap();
        assert!(!sealed(&v).items["acct"].windows(marker.len()).any(|w| w == marker));
        assert_eq!(&**v.get("acct").unwrap().unwrap(), "UNIQUE-PLAINTEXT-MARKER");
    }

    #[test]
    fn a_sealed_secret_is_bound_to_its_name() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "first").unwrap();
        v.set("b", "second").unwrap();
        let st = v.state.as_mut().unwrap();
        let (a, b) = (st.secrets.items["a"].clone(), st.secrets.items["b"].clone());
        st.secrets.items.insert("a".into(), b);
        st.secrets.items.insert("b".into(), a);
        assert!(v.get("a").is_err() && v.get("b").is_err());
    }

    #[test]
    fn a_damaged_sealed_secret_is_an_error_not_garbage() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "first").unwrap();
        v.state.as_mut().unwrap().secrets.items.get_mut("a").unwrap().truncate(10);
        assert!(v.get("a").is_err());
    }

    #[test]
    fn each_unlock_uses_a_fresh_shield_and_a_password_change_keeps_secrets() {
        let (_d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "first").unwrap();
        let shield = *sealed(&v).shield.as_array();
        v.lock();
        v.unlock(PW, false).unwrap();
        assert_ne!(shield, *sealed(&v).shield.as_array());
        let blob = sealed(&v).items["a"].clone();
        v.change_password(PW, PW2).unwrap();
        assert_eq!(sealed(&v).items["a"], blob, "a password change should not touch sealed secrets");
        assert_eq!(&**v.get("a").unwrap().unwrap(), "first");
    }

    #[test]
    fn overwriting_and_deleting_secrets_persist() {
        let (d, mut v) = vault();
        v.create(PW, FAST).unwrap();
        v.set("a", "1").unwrap();
        v.set("a", "2").unwrap();
        v.set("b", "3").unwrap();
        v.delete("b").unwrap();
        v.lock();
        let mut w = again(&d);
        w.unlock(PW, false).unwrap();
        assert_eq!(&**w.get("a").unwrap().unwrap(), "2");
        assert!(w.get("b").unwrap().is_none() && !w.contains("b").unwrap());
    }

    #[test]
    fn weak_passwords_are_refused_with_advice() {
        let (_d, mut v) = vault();
        for weak in ["passwordpassword", "123456789012", "qwertyuiopasdf", "portiquevault123"] {
            let e = v.create(weak, FAST).unwrap_err().to_string();
            assert!(e.contains("too easy to guess"), "{weak}: {e}");
            assert!(!v.exists());
        }
        assert!(assess(PW).ok && assess(PW2).ok);
        assert!(!assess("short").ok);
        assert!(!assess("passwordpassword").ok);
        v.create(PW, FAST).unwrap();
        let e = v.change_password(PW, "passwordpassword").unwrap_err().to_string();
        assert!(e.contains("too easy to guess"));
    }

    #[test]
    fn very_long_input_is_scored_quickly() {
        let t = Instant::now();
        let _ = assess(&"a1b2c3 ".repeat(5000));
        assert!(t.elapsed() < Duration::from_secs(2));
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
        assert!(v.unlock(PW, false).is_err());
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
        assert!(v.change_password("wrong wrong wrong", PW2).is_err());
        v.change_password(PW, PW2).unwrap();
        let mut v2 = again(&d);
        assert!(v2.unlock(PW, false).is_err());
        v2.unlock(PW2, false).unwrap();
        assert_eq!(v2.get("a").unwrap().as_ref().map(|v| v.as_str()), Some("b"));
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
        assert!(v.unlock(PW, false).unwrap_err().to_string().contains("unreasonable"));
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
