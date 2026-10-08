//! App-managed SSH key store. Key metadata (name, fingerprint) is plain JSON; the private key
//! and its passphrase live only inside the encrypted vault.

use crate::{store, vault};
use anyhow::{bail, Context, Result};
use russh::keys::{decode_secret_key, ssh_key::HashAlg, PrivateKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

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
    let pem = Zeroizing::new(pem.context("key not found in vault")?);
    let pass = passphrase.or(saved.as_deref());
    decode_secret_key(&pem, pass).map_err(|e| anyhow::anyhow!("cannot unlock key: {e}"))
}

/// True if the key needs a passphrase that the vault doesn't have.
pub fn needs_passphrase(id: &str) -> Result<bool> {
    let mut v = vault::global();
    Ok(list()?.iter().any(|k| k.id == id && k.encrypted) && !v.contains(&vault::passphrase_account(id))?)
}

pub fn import(name: &str, pem: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
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
    let mut all = list()?;
    all.push(info.clone());
    store::write_json("keys.json", &all)?;
    Ok(info)
}

pub fn delete(id: &str) -> Result<()> {
    valid_id(id)?;
    {
        let mut v = vault::global();
        v.delete(&vault::key_account(id))?;
        v.delete(&vault::passphrase_account(id))?;
    }
    let mut all = list()?;
    all.retain(|k| k.id != id);
    store::write_json("keys.json", &all)
}
