//! JSON persistence for profiles, themes, keys and known hosts.

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::PathBuf;

pub fn data_dir() -> Result<PathBuf> {
    resolve_dir(&dirs::config_dir().context("no config directory available")?)
}

fn resolve_dir(base: &std::path::Path) -> Result<PathBuf> {
    let dir = base.join("portique");
    // Carry data over from the app's former name (Termix) on first launch.
    let legacy = base.join("termix");
    if !dir.exists() && legacy.is_dir() {
        let _ = std::fs::rename(&legacy, &dir);
    }
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

pub fn read_json<T: DeserializeOwned + Default>(name: &str) -> Result<T> {
    let path = data_dir()?.join(name);
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(T::default()),
        Ok(s) => serde_json::from_str(&s).with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn write_json<T: Serialize>(name: &str, value: &T) -> Result<()> {
    let path = data_dir()?.join(name);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Ssh,
    Telnet,
    Serial,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    /// Password (falls back to keyboard-interactive).
    #[default]
    Password,
    /// Private key only.
    Key,
    /// Private key, then password (servers using `AuthenticationMethods publickey,password`).
    KeyAndPassword,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    /// Listen locally, connect to `dest` through the server (ssh -L).
    #[default]
    Local,
    /// Listen on the server, connect to `dest` from this machine (ssh -R).
    Remote,
    /// Local SOCKS5 proxy that dials through the server (ssh -D).
    Dynamic,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Forward {
    pub kind: ForwardKind,
    pub listen_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SerialSettings {
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    /// "none" | "odd" | "even"
    pub parity: String,
    /// 1 | 2
    pub stop_bits: u8,
    /// "none" | "software" | "hardware"
    pub flow: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub font_family: String,
    pub font_size: f32,
    pub theme_id: String,
    /// "block" | "underline" | "bar"
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    /// Join programming-font ligatures (needs a font that has them).
    pub ligatures: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            font_family: "Cascadia Mono, Consolas, 'DejaVu Sans Mono', monospace".into(),
            font_size: 14.0,
            theme_id: "portique-nuit".into(),
            cursor_style: "block".into(),
            cursor_blink: true,
            scrollback: 10_000,
            ligatures: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub group: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Id of an imported key (see `keys.rs`).
    pub key_id: Option<String>,
    pub serial: SerialSettings,
    pub appearance: Appearance,
    /// SSH only: id of another SSH profile to tunnel through (ProxyJump).
    pub jump_host: Option<String>,
    /// SSH only: reconnect by itself (with back-off) when the connection drops.
    #[serde(default = "yes")]
    pub auto_reconnect: bool,
    /// SSH only: port forwards that live as long as the session.
    pub forwards: Vec<Forward>,
    /// SSH only: where this profile's file browser starts on this computer (empty: the global setting).
    pub local_dir: String,
    /// SSH only: where it starts on the server (empty: the login folder).
    pub remote_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection: String,
    /// 16 entries: 8 normal followed by 8 bright.
    pub ansi: Vec<String>,
    /// Optional font that comes with the theme (e.g. SGI's screen font).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f32>,
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl Theme {
    /// Colours end up in CSS/canvas on the frontend, so accept only `#rrggbb`.
    pub fn valid(&self) -> bool {
        let font_ok = self.font_family.as_deref().is_none_or(|f| {
            f.len() <= 200 && !f.chars().any(|c| c.is_control() || "<>{};\\@".contains(c))
        }) && self.font_size.is_none_or(|s| (6.0..=48.0).contains(&s));
        font_ok
            && self.ansi.len() == 16
            && [&self.background, &self.foreground, &self.cursor, &self.selection]
                .into_iter()
                .chain(self.ansi.iter())
                .all(|c| is_hex_color(c))
    }
}

pub fn load_profiles() -> Result<Vec<Profile>> {
    read_json("profiles.json")
}

pub fn save_profiles(p: &Vec<Profile>) -> Result<()> {
    write_json("profiles.json", p)
}

pub fn get_profile(id: &str) -> Result<Profile> {
    load_profiles()?
        .into_iter()
        .find(|p| p.id == id)
        .with_context(|| format!("profile {id} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme {
            id: "t".into(), name: "t".into(), background: "#000000".into(), foreground: "#ffffff".into(),
            cursor: "#ffffff".into(), selection: "#333333".into(), ansi: vec!["#123456".into(); 16],
            font_family: Some("'Irix Screen Mono 15', monospace".into()), font_size: Some(15.0),
        }
    }

    #[test]
    fn legacy_termix_dir_is_migrated() {
        let base = std::env::temp_dir().join(format!("portique-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("termix")).unwrap();
        std::fs::write(base.join("termix").join("vault.bin"), b"secret").unwrap();
        let dir = resolve_dir(&base).unwrap();
        assert_eq!(dir, base.join("portique"));
        assert_eq!(std::fs::read(dir.join("vault.bin")).unwrap(), b"secret");
        assert!(!base.join("termix").exists());
        // A second launch must not touch an existing portique dir.
        std::fs::create_dir_all(base.join("termix")).unwrap();
        resolve_dir(&base).unwrap();
        assert!(base.join("termix").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn theme_validation() {
        assert!(theme().valid());
        let mut t = theme();
        t.font_family = Some("x; background:url(//evil)".into());
        assert!(!t.valid());
        let mut t = theme();
        t.background = "red".into();
        assert!(!t.valid());
        let mut t = theme();
        t.font_size = Some(500.0);
        assert!(!t.valid());
        let mut t = theme();
        t.ansi.pop();
        assert!(!t.valid());
    }
}
