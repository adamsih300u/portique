//! Agent access: lets an AI agent open terminals in Portique and use them, over the Model Context Protocol.
//!
//! The server lives in the app (`server.rs`), so an agent works with the same sessions, saved logins and
//! host-key questions as the person does, and the person watches it work in an ordinary tab. A small
//! command (`portique mcp`, `shim.rs`) bridges the stdio transport some agent programs expect to the running app.
//!
//! What an agent can do is bounded here, in one place:
//! - nothing, until the settings switch it on, and then only on profiles the person marked (`window::AgentMode`);
//! - only on sessions it opened itself; it never reaches the person's own tabs;
//! - with the person's yes where the mode says so, shown as the exact text that would run (`approval.rs`);
//! - never with a secret: it names a profile and Portique signs in, and the vault stays closed to it.

mod approval;
mod exec;
mod mcp;
mod ops;
mod server;
mod session;
pub mod shim;
mod transcript;

pub use approval::Decision;
pub use session::Info as SessionInfo;

use crate::{
    session::Sessions,
    store::{Profile, Protocol},
    window::{AgentMode, Settings},
};
use serde::Serialize;
use session::{AgentSession, Phase};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Sessions an agent may have live at once.
pub const MAX_SESSIONS: usize = 8;
/// Entries the activity log keeps.
const AUDIT_KEPT: usize = 500;
/// An ended session stays readable this long.
const KEEP_ENDED: Duration = Duration::from_secs(600);

/// What the agent code needs from the app around it. `AppHost` is the real one; tests bring their own.
pub trait Host: Send + Sync + 'static {
    /// Tells the page something happened (a question to answer, a session to show).
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Draws the person's eye to the window (a question is waiting).
    fn attention(&self) {}
    fn settings(&self) -> Settings;
    /// The saved profiles.
    fn saved_profiles(&self) -> anyhow::Result<Vec<Profile>>;
    /// The local terminals the settings turn on.
    fn local_profiles(&self) -> Vec<Profile>;
    /// One profile to start a session from, by id.
    fn profile(&self, id: &str) -> anyhow::Result<Profile>;
    /// Whether the vault is open, which a session on a saved login needs.
    fn vault_unlocked(&self) -> bool;
    /// Portique's data folder, where the server publishes its address.
    fn data_dir(&self) -> anyhow::Result<std::path::PathBuf>;
}

/// A refusal or failure, worded for the agent that will read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError(pub String);

impl From<&str> for ToolError {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}
impl From<String> for ToolError {
    fn from(s: String) -> Self {
        Self(s)
    }
}

pub type ToolResult<T> = Result<T, ToolError>;

/// One line of the activity log. It lives in memory only: a command can carry a secret the agent chose to type, and a
/// file on disk would keep it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    /// Milliseconds since 1970.
    pub at: u64,
    pub client: String,
    pub profile: String,
    pub session: String,
    /// `open`, `run`, `input`, `close`, `refused`, `took-control`, `handed-back`.
    pub action: String,
    pub text: String,
    pub outcome: String,
}

struct Shared {
    host: Arc<dyn Host>,
    sessions: Sessions,
    registry: Mutex<HashMap<String, Arc<AgentSession>>>,
    approvals: approval::Approvals,
    audit: Mutex<VecDeque<Audit>>,
    patience: Duration,
    server: Mutex<Option<server::Running>>,
}

#[derive(Clone)]
pub struct Agents(Arc<Shared>);

/// A profile an agent may use, as `list_profiles` shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    pub group: String,
    pub protocol: Protocol,
    pub host: String,
    /// `ask` (the person approves each step) or `allow`.
    pub access: &'static str,
}

/// Where the server listens, for the settings pane and the copyable configuration.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub url: String,
    pub port: u16,
}

impl Agents {
    pub fn new(host: Arc<dyn Host>, sessions: Sessions) -> Self {
        Self::with_patience(host, sessions, approval::PATIENCE)
    }

    fn with_patience(host: Arc<dyn Host>, sessions: Sessions, patience: Duration) -> Self {
        Self(Arc::new(Shared {
            host,
            sessions,
            registry: Mutex::default(),
            approvals: approval::Approvals::default(),
            audit: Mutex::default(),
            patience,
            server: Mutex::default(),
        }))
    }

    fn settings(&self) -> Settings {
        self.0.host.settings()
    }

    /// The settings, or the refusal an agent gets while access is switched off.
    fn enabled(&self) -> ToolResult<Settings> {
        let s = self.settings();
        if s.agent.enabled {
            Ok(s)
        } else {
            Err("Agent access is switched off in Portique. Ask the user to turn it on in Settings.".into())
        }
    }

    // ---- registry ---------------------------------------------------------------------

    fn registry(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AgentSession>>> {
        self.0.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn get(&self, id: &str) -> ToolResult<Arc<AgentSession>> {
        self.registry().get(id).cloned().ok_or_else(|| ToolError("No such session. Call list_sessions to see the open ones.".into()))
    }

    /// The sessions, oldest first. Ended ones are dropped once they are old.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut reg = self.registry();
        reg.retain(|_, s| s.ended_for().is_none_or(|d| d < KEEP_ENDED));
        let mut all: Vec<SessionInfo> = reg.values().map(|s| s.info()).collect();
        all.sort_by_key(|i| std::cmp::Reverse(i.age_secs));
        all
    }

    fn live(&self) -> usize {
        self.registry().values().filter(|s| s.phase() != Phase::Ended).count()
    }

    // ---- policy -----------------------------------------------------------------------

    /// The profiles an agent may see: not switched off, and something that has a terminal.
    pub fn profiles(&self) -> ToolResult<Vec<ProfileInfo>> {
        let settings = self.enabled()?;
        let mut all = self.0.host.saved_profiles().map_err(|e| ToolError(format!("cannot read the profiles: {e:#}")))?;
        all.extend(self.0.host.local_profiles());
        Ok(all
            .into_iter()
            .filter(|p| p.protocol != Protocol::Api)
            .filter_map(|p| {
                let access = match settings.agent.mode(&p.id) {
                    AgentMode::Off => return None,
                    AgentMode::Ask => "ask",
                    AgentMode::Allow => "allow",
                };
                let host = match p.protocol {
                    Protocol::Ssh | Protocol::Telnet => format!("{}:{}", p.host, p.port),
                    Protocol::Serial => p.serial.port.clone(),
                    _ => String::new(),
                };
                Some(ProfileInfo { id: p.id, name: p.name, group: p.group, protocol: p.protocol, host, access })
            })
            .collect())
    }

    /// Applies a change of settings: sessions on a profile that is now off are closed, and with access off nothing stays open.
    pub fn policy_changed(&self) {
        let settings = self.settings();
        if !settings.agent.enabled {
            self.0.approvals.deny_all();
        }
        let doomed: Vec<Arc<AgentSession>> = self
            .registry()
            .values()
            .filter(|s| s.phase() != Phase::Ended && (!settings.agent.enabled || settings.agent.mode(&s.profile_id) == AgentMode::Off))
            .cloned()
            .collect();
        for s in doomed {
            self.log(&s, "close", "", "access withdrawn");
            self.0.sessions.send(s.id(), crate::session::Ctl::Close);
        }
    }

    // ---- the person's hand on a session -------------------------------------------------

    /// The person typed into a session's tab. The agent stops until it is handed back.
    pub fn took_control(&self, id: &str) {
        if let Some(s) = self.registry().get(id).cloned() {
            if !s.paused() {
                s.set_paused(true);
                self.log(&s, "took-control", "", "the agent is paused");
            }
        }
    }

    pub fn handed_back(&self, id: &str) {
        if let Some(s) = self.registry().get(id).cloned() {
            if s.paused() {
                s.set_inflight(None);
                s.set_paused(false);
                self.log(&s, "handed-back", "", "the agent may type again");
            }
        }
    }

    /// Whether a session belongs to an agent, and if so whether the person holds the keyboard.
    #[cfg(test)]
    pub fn controller(&self, id: &str) -> Option<&'static str> {
        self.registry().get(id).map(|s| if s.paused() { "user" } else { "agent" })
    }

    /// Shows a session in a tab: replays what it printed and then streams what comes.
    pub fn attach(&self, id: &str, tab: crate::session::Emitter) -> bool {
        self.registry().get(id).is_some_and(|s| {
            s.attach(tab);
            true
        })
    }

    pub fn resized(&self, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.registry().get(id) {
            s.resize(cols, rows);
        }
    }

    /// The person's answer to a question the page showed.
    pub fn answer(&self, id: &str, decision: Decision) -> bool {
        self.0.approvals.answer(id, decision)
    }

    // ---- activity log -----------------------------------------------------------------

    fn log(&self, s: &AgentSession, action: &str, text: &str, outcome: &str) {
        self.record(Audit {
            at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            client: s.client.clone(),
            profile: s.name.clone(),
            session: s.id().to_string(),
            action: action.into(),
            text: text.chars().take(500).collect(),
            outcome: outcome.into(),
        });
    }

    fn record(&self, entry: Audit) {
        let mut log = self.0.audit.lock().unwrap_or_else(|p| p.into_inner());
        if log.len() >= AUDIT_KEPT {
            log.pop_front();
        }
        log.push_back(entry);
    }

    /// The activity log, newest last.
    pub fn activity(&self) -> Vec<Audit> {
        self.0.audit.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
    }

    // ---- the server -------------------------------------------------------------------

    /// Starts listening if agent access is on and the server is not already up; stops it if access is off.
    pub async fn apply(&self) -> anyhow::Result<Option<Endpoint>> {
        self.policy_changed();
        if self.settings().agent.enabled {
            if let Some(e) = self.endpoint() {
                return Ok(Some(e));
            }
            let running = server::start(self.clone()).await?;
            let endpoint = running.endpoint();
            *self.0.server.lock().unwrap_or_else(|p| p.into_inner()) = Some(running);
            Ok(Some(endpoint))
        } else {
            self.stop();
            Ok(None)
        }
    }

    pub fn stop(&self) {
        if let Some(r) = self.0.server.lock().unwrap_or_else(|p| p.into_inner()).take() {
            r.stop();
        }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.0.server.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(server::Running::endpoint)
    }

    /// The text to give an agent program so it can reach the server. `stdio` carries no secret; `http` carries the token.
    pub fn config(&self, kind: &str) -> ToolResult<String> {
        let running = self.0.server.lock().unwrap_or_else(|p| p.into_inner());
        let running = running.as_ref().ok_or_else(|| ToolError("Agent access is off".into()))?;
        server::config(running, kind).ok_or_else(|| ToolError(format!("unknown configuration \"{kind}\"")))
    }
}

/// The real thing: reads and writes through the running app.
pub struct AppHost(pub tauri::AppHandle);

impl Host for AppHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = tauri::Emitter::emit(&self.0, event, payload);
    }
    fn attention(&self) {
        if let Some(w) = tauri::Manager::get_webview_window(&self.0, "main") {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
    fn settings(&self) -> Settings {
        crate::window::load()
    }
    fn saved_profiles(&self) -> anyhow::Result<Vec<Profile>> {
        crate::store::load_profiles()
    }
    fn local_profiles(&self) -> Vec<Profile> {
        let s = crate::window::load();
        if !s.local_terminals {
            return Vec::new();
        }
        let shells = crate::local::detect();
        s.local_shells.iter().filter_map(|id| shells.iter().find(|x| &x.id == id)).map(|x| crate::local::profile_of(x, &s)).collect()
    }
    fn profile(&self, id: &str) -> anyhow::Result<Profile> {
        crate::store::get_profile(id)
    }
    fn vault_unlocked(&self) -> bool {
        crate::vault::global().is_unlocked()
    }
    fn data_dir(&self) -> anyhow::Result<std::path::PathBuf> {
        crate::store::data_dir()
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A stand-in for the app: settings and profiles are plain values, and events are collected.
    #[derive(Default)]
    pub struct FakeHost {
        pub settings: Mutex<Settings>,
        pub saved: Mutex<Vec<Profile>>,
        pub local: Mutex<Vec<Profile>>,
        pub events: Mutex<Vec<(String, serde_json::Value)>>,
        /// Answers every question the moment it is shown (set by tests that want a person who always says yes or no).
        pub auto: Mutex<Option<(Agents, Decision)>>,
        pub vault_open: Mutex<bool>,
        pub data: Mutex<Option<std::path::PathBuf>>,
    }

    impl FakeHost {
        pub fn events(&self, name: &str) -> Vec<serde_json::Value> {
            self.events.lock().unwrap().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
        }
    }

    impl Host for FakeHost {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events.lock().unwrap().push((event.into(), payload.clone()));
            if event == "agent-approval" {
                if let Some((agents, d)) = self.auto.lock().unwrap().clone() {
                    agents.answer(payload["id"].as_str().unwrap(), d);
                }
            }
        }
        fn settings(&self) -> Settings {
            self.settings.lock().unwrap().clone()
        }
        fn saved_profiles(&self) -> anyhow::Result<Vec<Profile>> {
            Ok(self.saved.lock().unwrap().clone())
        }
        fn local_profiles(&self) -> Vec<Profile> {
            self.local.lock().unwrap().clone()
        }
        fn profile(&self, id: &str) -> anyhow::Result<Profile> {
            self.saved
                .lock()
                .unwrap()
                .iter()
                .chain(self.local.lock().unwrap().iter())
                .find(|p| p.id == id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("no profile {id}"))
        }
        fn vault_unlocked(&self) -> bool {
            *self.vault_open.lock().unwrap()
        }
        fn data_dir(&self) -> anyhow::Result<std::path::PathBuf> {
            self.data.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("no data folder in this test"))
        }
    }
}
