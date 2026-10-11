//! App-managed SSH key store. Key metadata (name, fingerprint) is plain JSON; the private key
//! and its passphrase live only inside the encrypted vault.

use crate::{store, vault};
use anyhow::{bail, Context, Result};
use russh::keys::{
    decode_secret_key,
    ssh_key::{private::Ed25519Keypair, HashAlg, LineEnding},
    PrivateKey,
};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

/// Held across every change to the key list, so two at once can't both read the old list and each write theirs.
static CHANGING: Mutex<()> = Mutex::new(());

fn changing() -> MutexGuard<'static, ()> {
    CHANGING.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub id: String,
    pub name: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub encrypted: bool,
}

pub fn list() -> Result<Vec<KeyInfo>> {
    store::read_json("keys.json")
}

fn valid_id(id: &str) -> Result<()> {
    if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { Ok(()) } else { bail!("invalid key id") }
}

/// Load a stored key from the vault, using `passphrase` or else the one saved with it.
pub fn load(id: &str, passphrase: Option<&str>) -> Result<PrivateKey> {
    valid_id(id)?;
    let (pem, saved) = {
        let mut v = vault::global();
        (v.get(&vault::key_account(id))?, v.get(&vault::passphrase_account(id))?)
    };
    let pem = pem.context("key not found in vault")?;
    let pass = passphrase.or(saved.as_ref().map(|s| s.as_str()));
    decode_secret_key(&pem, pass).map_err(|e| anyhow::anyhow!("cannot unlock key: {e}"))
}

/// True if the key needs a passphrase that the vault doesn't have.
pub fn needs_passphrase(id: &str) -> Result<bool> {
    let mut v = vault::global();
    Ok(list()?.iter().any(|k| k.id == id && k.encrypted) && !v.contains(&vault::passphrase_account(id))?)
}

/// Imports a key under any name, even one in use: the integration tests' way in. The window uses `import_checked`.
#[cfg(test)]
pub fn import(name: &str, pem: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
    let _g = changing();
    store_key(name, pem, passphrase)
}

/// Imports a key under a name that is free (see `new_name`), which is what the window's import does.
pub fn import_checked(name: &str, pem: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
    let _g = changing();
    let name = new_name(name, &list()?)?;
    store_key(&name, pem, passphrase)
}

/// Does the work of an import. The caller holds `changing()`.
fn store_key(name: &str, pem: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
    let pem = Zeroizing::new(pem.trim().replace("\r\n", "\n") + "\n");
    let encrypted = decode_secret_key(&pem, None).is_err();
    let key = decode_secret_key(&pem, passphrase).map_err(|e| {
        if encrypted && passphrase.is_none() {
            anyhow::anyhow!("key is passphrase-protected; supply the passphrase")
        } else {
            anyhow::anyhow!("not a usable private key: {e}")
        }
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut v = vault::global();
        v.set(&vault::key_account(&id), &pem)?;
        if let (true, Some(p)) = (encrypted, passphrase) {
            v.set(&vault::passphrase_account(&id), p)?;
        }
    }
    let info = KeyInfo {
        id,
        name: name.to_string(),
        algorithm: key.algorithm().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        encrypted,
    };
    let saved = list().and_then(|mut all| {
        all.push(info.clone());
        store::write_json("keys.json", &all)
    });
    if let Err(e) = saved {
        // No entry for the key means nothing could ever use or delete it: don't leave its secret in the vault.
        let mut v = vault::global();
        let _ = v.delete(&vault::key_account(&info.id));
        let _ = v.delete(&vault::passphrase_account(&info.id));
        return Err(e);
    }
    Ok(info)
}

/// A name for a new key: trimmed, and not in use (case aside), because the palette picks keys by name.
fn new_name(name: &str, existing: &[KeyInfo]) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("give the key a name");
    }
    if name.chars().count() > 64 || name.chars().any(char::is_control) {
        bail!("a key name is at most 64 characters, with no control characters");
    }
    if existing.iter().any(|k| k.name.to_lowercase() == name.to_lowercase()) {
        bail!("there is already a key called \"{name}\"; choose another name");
    }
    Ok(name.to_string())
}

fn fresh_key() -> Result<PrivateKey> {
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut seed[..]).map_err(|e| anyhow::anyhow!("no randomness available: {e}"))?;
    Ok(PrivateKey::from(Ed25519Keypair::from_seed(&seed)))
}

/// Makes a new Ed25519 key and keeps it in the vault, like an imported one. The private key is never returned or
/// shown: the caller gets its name, fingerprint and id, and asks for the public half separately. It has no passphrase
/// of its own, since the vault already encrypts it and would hold the passphrase beside it.
pub fn generate(name: &str) -> Result<KeyInfo> {
    let _g = changing();
    let name = new_name(name, &list()?)?;
    let pem = fresh_key()?.to_openssh(LineEnding::LF).context("cannot write the new key")?;
    store_key(&name, &pem, None)
}

pub fn delete(id: &str) -> Result<()> {
    valid_id(id)?;
    let _g = changing();
    {
        let mut v = vault::global();
        v.delete(&vault::key_account(id))?;
        v.delete(&vault::passphrase_account(id))?;
    }
    let mut all = list()?;
    all.retain(|k| k.id != id);
    store::write_json("keys.json", &all)
}

/// The public half of a stored key, as one `authorized_keys` field pair, and its fingerprint.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicKey {
    /// `algorithm base64`, with no comment: the caller adds its own.
    pub key: String,
    pub fingerprint: String,
}

fn public_of(key: &PrivateKey) -> Result<PublicKey> {
    let line = key.public_key().to_openssh().context("cannot write the public key")?;
    let mut fields = line.split_whitespace();
    let (Some(algorithm), Some(data)) = (fields.next(), fields.next()) else { bail!("cannot read the public key") };
    Ok(PublicKey { key: format!("{algorithm} {data}"), fingerprint: key.fingerprint(HashAlg::Sha256).to_string() })
}

/// The public key of a stored key. The private key and its passphrase never leave this module.
pub fn public(id: &str) -> Result<PublicKey> {
    if needs_passphrase(id)? {
        bail!("this key is passphrase-protected and the vault doesn't have its passphrase; save the passphrase with the key first");
    }
    public_of(&load(id, None)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::private::Ed25519Keypair;

    fn key(seed: u8) -> PrivateKey {
        PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
    }

    #[test]
    fn public_key_is_two_fields_with_no_comment() {
        let p = public_of(&key(7)).unwrap();
        let fields: Vec<&str> = p.key.split(' ').collect();
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0], "ssh-ed25519");
        assert!(fields[1].starts_with("AAAAC3NzaC1lZDI1NTE5AAAAI"));
        assert!(p.fingerprint.starts_with("SHA256:"));
    }

    fn info(name: &str) -> KeyInfo {
        KeyInfo { id: "x".into(), name: name.into(), algorithm: "ssh-ed25519".into(), fingerprint: "SHA256:x".into(), encrypted: false }
    }

    #[test]
    fn a_new_key_name_is_trimmed_and_must_be_free() {
        assert_eq!(new_name("  work laptop ", &[]).unwrap(), "work laptop");
        assert!(new_name("   ", &[]).is_err());
        assert!(new_name("a\nb", &[]).is_err());
        assert!(new_name(&"x".repeat(65), &[]).is_err());
        let err = new_name("Work", &[info("work")]).unwrap_err().to_string();
        assert!(err.contains("already a key called"), "{err}");
        assert!(new_name("home", &[info("work")]).is_ok());
    }

    #[test]
    fn fresh_keys_are_ed25519_and_never_repeat() {
        let (a, b) = (fresh_key().unwrap(), fresh_key().unwrap());
        assert_eq!(a.algorithm().to_string(), "ssh-ed25519");
        assert_ne!(public_of(&a).unwrap(), public_of(&b).unwrap());
    }

    #[test]
    fn a_new_key_survives_the_openssh_round_trip_it_is_stored_in() {
        let k = fresh_key().unwrap();
        let pem = k.to_openssh(LineEnding::LF).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let back = decode_secret_key(&pem, None).unwrap();
        assert_eq!(public_of(&k).unwrap(), public_of(&back).unwrap());
    }

    #[test]
    fn public_key_matches_its_key_and_only_its_key() {
        assert_eq!(public_of(&key(7)).unwrap(), public_of(&key(7)).unwrap());
        assert_ne!(public_of(&key(7)).unwrap(), public_of(&key(8)).unwrap());
    }
}
