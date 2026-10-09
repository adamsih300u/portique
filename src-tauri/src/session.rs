//! Session plumbing shared by every protocol: the event stream to the frontend,
//! control messages from it, and a tiny prompt-matching auto-login helper.

use crate::store::{Profile, Protocol};
use serde_json::json;
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Frames sent to the frontend: first byte 0 = terminal data, 1 = JSON status.
#[derive(Clone)]
pub struct Emitter(Channel<InvokeResponseBody>);

impl Emitter {
    pub fn new(c: Channel<InvokeResponseBody>) -> Self {
        Self(c)
    }
    pub fn data(&self, d: &[u8]) {
        let mut v = Vec::with_capacity(d.len() + 1);
        v.push(0);
        v.extend_from_slice(d);
        let _ = self.0.send(InvokeResponseBody::Raw(v));
    }
    /// state: connecting | connected | vault-locked | closed | lost | error | need-password | need-passphrase | tunnels
    /// Like `status`, but `message` is a JSON document the frontend parses itself.
    pub fn status_json(&self, state: &str, message: serde_json::Value) {
        self.status(state, &message.to_string());
    }
    pub fn status(&self, state: &str, message: &str) {
        let mut v = vec![1u8];
        v.extend_from_slice(json!({ "state": state, "message": message }).to_string().as_bytes());
        let _ = self.0.send(InvokeResponseBody::Raw(v));
    }
}

pub enum Ctl {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// Raised by protocol code when it needs a secret the user hasn't saved.
#[derive(Debug)]
pub struct NeedsInput(pub &'static str);
impl std::fmt::Display for NeedsInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} required", self.0)
    }
}
impl std::error::Error for NeedsInput {}

/// The transport died underneath a session that had been working (network drop, keepalive
/// timeout), as opposed to the user or the server ending it. The UI may reconnect on its own.
#[derive(Debug)]
pub struct ConnectionLost;
impl std::fmt::Display for ConnectionLost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "connection lost")
    }
}
impl std::error::Error for ConnectionLost {}

#[derive(Default, Clone)]
pub struct Sessions {
    map: Arc<Mutex<HashMap<String, UnboundedSender<Ctl>>>>,
    hosts: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
}

impl Sessions {
    pub fn send(&self, id: &str, c: Ctl) -> bool {
        self.map.lock().unwrap().get(id).is_some_and(|t| t.send(c).is_ok())
    }

    /// Register a pending host-key question for session `id`; the receiver yields the user's answer.
    pub fn ask_host(&self, id: &str) -> tokio::sync::oneshot::Receiver<bool> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.hosts.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    pub fn answer_host(&self, id: &str, accept: bool) {
        if let Some(tx) = self.hosts.lock().unwrap().remove(id) {
            let _ = tx.send(accept);
        }
    }
}

#[derive(Default)]
pub struct Params {
    /// Filled in by `start`: the session id and a handle for asking the user questions.
    pub sid: String,
    pub sessions: Sessions,
    pub cols: u16,
    pub rows: u16,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    /// Open an SFTP file browser instead of a shell (SSH profiles only).
    pub sftp: bool,
    /// Offer a local SOCKS5 proxy through the server instead of a shell (SSH profiles only).
    pub proxy: bool,
}

pub fn start(
    sessions: &Sessions,
    profile: Profile,
    mut params: Params,
    emitter: Emitter,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = unbounded_channel();
    params.sid = id.clone();
    params.sessions = sessions.clone();
    sessions.map.lock().unwrap().insert(id.clone(), tx.clone());
    let em = emitter.clone();
    let sessions = sessions.clone();
    let sid = id.clone();
    tauri::async_runtime::spawn(async move {
        // A shell on this computer needs nothing from the vault.
        if profile.protocol != Protocol::Local && !crate::vault::global().is_unlocked() {
            em.status("vault-locked", "Vault is locked");
            sessions.map.lock().unwrap().remove(&sid);
            return;
        }
        em.status("connecting", &format!("Connecting to {}…", profile.name));
        let res = match profile.protocol {
            Protocol::Ssh if params.sftp => crate::ssh::run_sftp(&profile, params, em.clone(), rx).await,
            Protocol::Ssh if params.proxy => crate::ssh::run_proxy(&profile, params, em.clone(), rx).await,
            Protocol::Ssh => crate::ssh::run(&profile, params, em.clone(), rx).await,
            Protocol::Telnet => crate::telnet::run(&profile, params, em.clone(), rx, tx).await,
            Protocol::Serial => crate::serial::run(&profile, params, em.clone(), rx, tx).await,
            Protocol::Local => crate::local::run(&profile, params, em.clone(), rx).await,
            Protocol::Api => Err(anyhow::anyhow!("an API connection has no terminal session; open it from the sidebar to send requests")),
        };
        match res {
            Ok(()) => em.status("closed", "Session closed"),
            Err(e) if crate::vault::is_locked_error(&e) => em.status("vault-locked", "Vault is locked"),
            Err(e) if e.is::<ConnectionLost>() => em.status("lost", "Connection lost"),
            Err(e) => match e.downcast_ref::<NeedsInput>() {
                Some(NeedsInput("password")) => em.status("need-password", "Password required"),
                Some(_) => em.status("need-passphrase", "Key passphrase required"),
                None => em.status("error", &format!("{e:#}")),
            },
        }
        sessions.map.lock().unwrap().remove(&sid);
        sessions.hosts.lock().unwrap().remove(&sid);
    });
    id
}

/// Watches output for `login:` / `password:` style prompts and types saved credentials once each.
pub struct AutoLogin {
    username: Option<String>,
    password: Option<String>,
    tail: Vec<u8>,
    deadline: std::time::Instant,
}

/// Credentials are only typed during the login phase; later prompts are left to the user.
const AUTOLOGIN_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

impl AutoLogin {
    pub fn new(username: Option<String>, password: Option<String>) -> Self {
        Self {
            username: username.filter(|s| !s.is_empty()),
            password: password.filter(|s| !s.is_empty()),
            tail: Vec::new(),
            deadline: std::time::Instant::now() + AUTOLOGIN_WINDOW,
        }
    }

    /// Returns bytes to send if the latest output ends in a recognised prompt.
    pub fn scan(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        if (self.username.is_none() && self.password.is_none()) || std::time::Instant::now() > self.deadline {
            self.username = None;
            self.password = None;
            return None;
        }
        self.tail.extend_from_slice(data);
        if self.tail.len() > 128 {
            let cut = self.tail.len() - 128;
            self.tail.drain(..cut);
        }
        let text = String::from_utf8_lossy(&self.tail).to_lowercase();
        let t = text.trim_end();
        if self.username.is_some() && (t.ends_with("login:") || t.ends_with("username:") || t.ends_with("user name:")) {
            self.tail.clear();
            return Some(format!("{}\r", self.username.take().unwrap()).into_bytes());
        }
        if self.password.is_some() && t.ends_with("password:") {
            self.tail.clear();
            return Some(format!("{}\r", self.password.take().unwrap()).into_bytes());
        }
        None
    }
}

pub fn saved_password(p: &Profile, override_pw: &Option<String>) -> Option<String> {
    override_pw
        .clone()
        .or_else(|| crate::vault::global().get(&crate::vault::password_account(&p.id)).ok().flatten())
}
