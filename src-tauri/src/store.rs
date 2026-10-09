//! JSON persistence for profiles, themes, keys and known hosts.

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

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
    /// An HTTP API endpoint: opens the API client, not a terminal. Its settings are in `Profile::api`.
    Api,
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
    /// API only: base address, default sign-in and headers, and options. Opaque here: the frontend owns the shape.
    pub api: serde_json::Value,
    /// Commands offered in the palette while a tab for this profile is on screen. Opaque here: the frontend owns the shape.
    /// Plain data like the host name, so nothing secret belongs in one.
    pub commands: serde_json::Value,
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

/// Prefix of the ids given to quick-connect profiles, which exist only in memory.
pub const QUICK_PREFIX: &str = "quick:";

fn quick_profiles() -> &'static Mutex<HashMap<String, Profile>> {
    static QUICK: OnceLock<Mutex<HashMap<String, Profile>>> = OnceLock::new();
    QUICK.get_or_init(Default::default)
}

/// Remembers a profile for the life of the app so a session can start from it by id. It is never written
/// to `profiles.json`. Only a plain host: no jump host, forwards or API settings are carried over.
pub fn add_quick(p: Profile) -> Result<Profile> {
    if !matches!(p.protocol, Protocol::Ssh | Protocol::Telnet) {
        anyhow::bail!("quick connect handles SSH and Telnet only");
    }
    let host = p.host.trim();
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        anyhow::bail!("not a valid host name");
    }
    if p.port == 0 {
        anyhow::bail!("not a valid port");
    }
    let q = Profile {
        id: format!("{QUICK_PREFIX}{}", uuid::Uuid::new_v4()),
        host: host.to_string(),
        group: String::new(),
        key_id: None,
        jump_host: None,
        forwards: Vec::new(),
        api: serde_json::Value::Null,
        commands: serde_json::Value::Null,
        ..p
    };
    quick_profiles().lock().unwrap().insert(q.id.clone(), q.clone());
    Ok(q)
}

pub fn get_profile(id: &str) -> Result<Profile> {
    if let Some(p) = quick_profiles().lock().unwrap().get(id) {
        return Ok(p.clone());
    }
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
    fn saved_commands_round_trip_untouched_and_older_profiles_have_none() {
        let old: Profile = serde_json::from_str(r#"{"id":"a","name":"srv","protocol":"ssh","host":"h","port":22}"#).unwrap();
        assert!(old.commands.is_null());

        let cmds = serde_json::json!([{ "id": "1", "name": "Disk", "text": "df -h", "mode": "run" }]);
        let p = Profile { commands: cmds.clone(), ..Default::default() };
        let back: Profile = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.commands, cmds);
    }

    #[test]
    fn quick_profiles_resolve_by_id_and_keep_to_a_plain_host() {
        let q = add_quick(Profile {
            name: "10.0.0.5".into(), host: " 10.0.0.5 ".into(), port: 22, protocol: Protocol::Ssh,
            group: "g".into(), jump_host: Some("j".into()), key_id: Some("k".into()),
            forwards: vec![Forward { kind: ForwardKind::Dynamic, listen_port: 1, dest_host: String::new(), dest_port: 0 }],
            ..Default::default()
        })
        .unwrap();
        assert!(q.id.starts_with(QUICK_PREFIX));
        assert_eq!(q.host, "10.0.0.5");
        assert!(q.jump_host.is_none() && q.key_id.is_none() && q.forwards.is_empty() && q.group.is_empty());
        assert_eq!(get_profile(&q.id).unwrap().host, "10.0.0.5");

        let api = Profile { protocol: Protocol::Api, host: "h".into(), port: 80, ..Default::default() };
        assert!(add_quick(api).is_err());
        assert!(add_quick(Profile { host: "a b".into(), port: 22, ..Default::default() }).is_err());
        assert!(add_quick(Profile { host: "a".into(), port: 0, ..Default::default() }).is_err());
    }

    #[test]
    fn api_connections_round_trip_and_older_profiles_still_load() {
        // A profile saved before API connections existed has no `api` field and a protocol we already knew.
        let old: Profile = serde_json::from_str(r#"{"id":"a","name":"srv","protocol":"ssh","host":"h","port":22}"#).unwrap();
        assert_eq!(old.protocol, Protocol::Ssh);
        assert!(old.api.is_null());

        // The frontend owns the shape of `api`; the backend must hand back exactly what it was given.
        let json = r#"{"id":"b","name":"Orders","protocol":"api","host":"https://x.test/v1","api":{"baseUrl":"https://x.test/v1","via":"a","headers":[{"key":"X","value":"1","on":true}],"timeout":30}}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(p.protocol, Protocol::Api);
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["protocol"], "api");
        assert_eq!(back["api"]["baseUrl"], "https://x.test/v1");
        assert_eq!(back["api"]["headers"][0]["key"], "X");
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
