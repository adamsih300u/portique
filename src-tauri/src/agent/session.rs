//! One terminal session an agent opened: what it printed, where it stands, and who is in control.

use super::{exec::Dialect, transcript::Transcript};
use crate::{session::Emitter, store::Protocol};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

/// Where a session is, as far as an agent needs to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Connecting or logging in.
    Starting,
    /// Waiting for the person (a host key to confirm).
    AwaitingUser,
    /// Connected; the shell is up.
    Ready,
    /// Closed, lost, or failed. It never comes back.
    Ended,
}

/// The session states that move a session between phases; others (`tunnels`, `proxy`) only inform the page.
fn phase_of(state: &str) -> Option<Phase> {
    Some(match state {
        "connecting" => Phase::Starting,
        "confirm-host" => Phase::AwaitingUser,
        "connected" => Phase::Ready,
        "closed" | "lost" | "error" | "need-password" | "need-passphrase" | "vault-locked" => Phase::Ended,
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct Status {
    pub phase: Phase,
    pub state: String,
    pub message: String,
}

/// A command whose end marker has not been seen yet.
#[derive(Clone, Debug)]
pub struct Inflight {
    pub nonce: String,
    /// Offset of the transcript when the command was typed.
    pub from: u64,
}

struct Inner {
    transcript: Transcript,
    status: Status,
    /// The latest phase-changing status frame, replayed to a tab that attaches later.
    status_frame: Option<Vec<u8>>,
    attached: Option<Emitter>,
    inflight: Option<Inflight>,
    ended: Option<Instant>,
}

pub struct AgentSession {
    id: OnceLock<String>,
    pub profile_id: String,
    pub name: String,
    pub host: String,
    pub protocol: Protocol,
    pub dialect: Option<Dialect>,
    /// The agent that opened it, as that agent named itself.
    pub client: String,
    opened: Instant,
    inner: Mutex<Inner>,
    tick: watch::Sender<u64>,
    /// The person typed into the tab: the agent may not type until they hand it back.
    paused: AtomicBool,
    /// The person said the agent may type here without asking again.
    free: AtomicBool,
    /// One command runs at a time.
    pub run: tokio::sync::Mutex<()>,
    /// Where `read_output` goes on from when the agent gives no offset.
    read_cursor: AtomicU64,
    /// The vault opening (plus one; 0 for none) under which the person entered the master password for this session.
    proof: AtomicU64,
}

/// What a tool reports about a session.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub session: String,
    pub profile: String,
    pub name: String,
    pub host: String,
    pub protocol: Protocol,
    pub phase: Phase,
    pub state: String,
    pub message: String,
    /// `agent`, or `user` while the person holds the keyboard.
    pub controller: &'static str,
    pub cols: u16,
    pub rows: u16,
    /// A full-screen program (an editor, a pager) is showing; commands cannot be typed as lines.
    pub full_screen: bool,
    /// `run_command` works here (a POSIX shell); otherwise use `send_input` with `wait_for`.
    pub can_run_commands: bool,
    pub client: String,
    pub age_secs: u64,
}

/// A snapshot of the emulated screen.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub text: String,
    pub cols: u16,
    pub rows: u16,
    /// Zero-based row and column.
    pub cursor: (u16, u16),
    pub full_screen: bool,
}

impl AgentSession {
    pub fn new(profile_id: &str, name: &str, host: &str, protocol: Protocol, client: &str, cols: u16, rows: u16) -> Self {
        Self {
            id: OnceLock::new(),
            profile_id: profile_id.into(),
            name: name.into(),
            host: host.into(),
            protocol,
            dialect: Dialect::of(protocol, profile_id),
            client: client.into(),
            opened: Instant::now(),
            inner: Mutex::new(Inner {
                transcript: Transcript::new(cols, rows),
                status: Status { phase: Phase::Starting, state: "connecting".into(), message: String::new() },
                status_frame: None,
                attached: None,
                inflight: None,
                ended: None,
            }),
            tick: watch::channel(0).0,
            paused: AtomicBool::new(false),
            free: AtomicBool::new(false),
            run: tokio::sync::Mutex::new(()),
            read_cursor: AtomicU64::new(0),
            proof: AtomicU64::new(0),
        }
    }

    pub fn set_id(&self, id: String) {
        let _ = self.id.set(id);
    }

    pub fn id(&self) -> &str {
        self.id.get().map_or("", String::as_str)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Receives every frame the session emits (see `Emitter::sink`).
    pub fn on_frame(&self, frame: Vec<u8>) {
        let Some((&kind, body)) = frame.split_first() else { return };
        {
            let mut g = self.lock();
            if kind == 0 {
                g.transcript.push(body);
            } else if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) {
                let state = v["state"].as_str().unwrap_or_default();
                if let Some(phase) = phase_of(state) {
                    // Once ended, a session stays ended, whatever else it reports on the way out.
                    if g.status.phase != Phase::Ended {
                        g.status = Status { phase, state: state.into(), message: v["message"].as_str().unwrap_or_default().into() };
                        g.status_frame = Some(frame.clone());
                        if phase == Phase::Ended {
                            g.ended = Some(Instant::now());
                        }
                    }
                }
            }
            if let Some(tab) = &g.attached {
                tab.frame(frame);
            }
        }
        self.tick.send_modify(|t| *t = t.wrapping_add(1));
    }

    /// A receiver that changes whenever the session prints something or changes state.
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.tick.subscribe()
    }

    pub fn status(&self) -> Status {
        self.lock().status.clone()
    }

    pub fn phase(&self) -> Phase {
        self.lock().status.phase
    }

    /// Shows the session in a tab: replays what it printed, its current status, then keeps sending what comes.
    pub fn attach(&self, tab: Emitter) {
        let mut g = self.lock();
        let (history, _) = g.transcript.since(0);
        for chunk in history.chunks(64 * 1024) {
            tab.data(chunk);
        }
        if let Some(f) = g.status_frame.clone() {
            tab.frame(f);
        }
        g.attached = Some(tab);
    }

    // ---- who is in control ----------------------------------------------------------

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn set_paused(&self, on: bool) {
        self.paused.store(on, Ordering::SeqCst);
        self.tick.send_modify(|t| *t = t.wrapping_add(1));
    }
    pub fn free(&self) -> bool {
        self.free.load(Ordering::SeqCst)
    }
    pub fn set_free(&self, on: bool) {
        self.free.store(on, Ordering::SeqCst);
    }

    // ---- reading ----------------------------------------------------------------------

    pub fn end_offset(&self) -> u64 {
        self.lock().transcript.end()
    }

    /// Bytes from `from` on, and the offset they start at.
    pub fn since(&self, from: u64) -> (Vec<u8>, u64) {
        self.lock().transcript.since(from)
    }

    pub fn screen(&self) -> Screen {
        let g = self.lock();
        let s = g.transcript.screen();
        let (rows, cols) = s.size();
        Screen { text: s.contents(), cols, rows, cursor: s.cursor_position(), full_screen: s.alternate_screen() }
    }

    /// The shell asked for bracketed paste, and no full-screen program is in front.
    pub fn bracketed(&self) -> bool {
        let g = self.lock();
        let s = g.transcript.screen();
        s.bracketed_paste() && !s.alternate_screen()
    }

    pub fn full_screen(&self) -> bool {
        self.lock().transcript.screen().alternate_screen()
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        self.lock().transcript.resize(cols, rows);
    }

    /// Whether the person has entered the master password for this session during the vault's current opening.
    pub fn proven(&self, epoch: Option<u64>) -> bool {
        epoch.is_some_and(|e| self.proof.load(Ordering::SeqCst) == e + 1)
    }
    pub fn set_proof(&self, epoch: u64) {
        self.proof.store(epoch + 1, Ordering::SeqCst);
    }

    pub fn read_cursor(&self) -> u64 {
        self.read_cursor.load(Ordering::SeqCst)
    }
    pub fn set_read_cursor(&self, at: u64) {
        self.read_cursor.store(at, Ordering::SeqCst);
    }

    /// How long ago the session ended, if it has.
    pub fn ended_for(&self) -> Option<Duration> {
        self.lock().ended.map(|t| t.elapsed())
    }

    pub fn inflight(&self) -> Option<Inflight> {
        self.lock().inflight.clone()
    }
    pub fn set_inflight(&self, f: Option<Inflight>) {
        self.lock().inflight = f;
    }

    pub fn info(&self) -> Info {
        let g = self.lock();
        let (cols, rows) = g.transcript.size();
        Info {
            session: self.id().into(),
            profile: self.profile_id.clone(),
            name: self.name.clone(),
            host: self.host.clone(),
            protocol: self.protocol,
            phase: g.status.phase,
            state: g.status.state.clone(),
            message: g.status.message.clone(),
            controller: if self.paused() { "user" } else { "agent" },
            cols,
            rows,
            full_screen: g.transcript.screen().alternate_screen(),
            can_run_commands: self.dialect.is_some(),
            client: self.client.clone(),
            age_secs: self.opened.elapsed().as_secs(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn status(state: &str, message: &str) -> Vec<u8> {
        let mut f = vec![1u8];
        f.extend(serde_json::json!({ "state": state, "message": message }).to_string().into_bytes());
        f
    }
    fn data(d: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8];
        f.extend_from_slice(d);
        f
    }
    fn session() -> AgentSession {
        AgentSession::new("local:sh", "sh", "", Protocol::Local, "test", 80, 24)
    }

    #[test]
    fn frames_fill_the_transcript_and_move_the_phase() {
        let s = session();
        assert_eq!(s.phase(), Phase::Starting);
        s.on_frame(status("confirm-host", "{}"));
        assert_eq!(s.phase(), Phase::AwaitingUser);
        s.on_frame(status("connected", "Started sh"));
        s.on_frame(data(b"hello"));
        assert_eq!((s.phase(), s.end_offset()), (Phase::Ready, 5));
        s.on_frame(status("tunnels", "[]"));
        assert_eq!(s.phase(), Phase::Ready, "informational states change nothing");
        s.on_frame(status("lost", "Connection lost"));
        s.on_frame(status("connected", "again"));
        assert_eq!(s.status().state, "lost", "an ended session stays ended");
    }

    #[test]
    fn a_tab_that_attaches_late_gets_the_history_and_then_the_live_output() {
        let s = session();
        s.on_frame(status("connecting", "…"));
        s.on_frame(data(b"before "));
        s.on_frame(status("confirm-host", "{\"fingerprint\":\"x\"}"));
        let got = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = got.clone();
        s.attach(Emitter::sink(move |f| sink.lock().unwrap().push(f)));
        s.on_frame(data(b"after"));
        let frames = got.lock().unwrap().clone();
        assert_eq!(frames[0], data(b"before "));
        assert!(frames[1].starts_with(&[1]) && String::from_utf8_lossy(&frames[1]).contains("confirm-host"), "the pending question is replayed");
        assert_eq!(frames[2], data(b"after"));

        // A second tab takes over the stream; the first hears no more.
        let second = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = second.clone();
        s.attach(Emitter::sink(move |f| sink.lock().unwrap().push(f)));
        s.on_frame(data(b"later"));
        assert_eq!(got.lock().unwrap().len(), 3);
        assert_eq!(second.lock().unwrap().last(), Some(&data(b"later")));
    }

    #[test]
    fn the_screen_and_the_info_reflect_the_output() {
        let s = session();
        s.on_frame(status("connected", ""));
        s.on_frame(data(b"$ ls\r\nfile\r\n\x1b[?2004h"));
        assert!(s.bracketed());
        let screen = s.screen();
        assert!(screen.text.starts_with("$ ls\nfile"), "{:?}", screen.text);
        assert_eq!(screen.cursor, (2, 0));
        s.on_frame(data(b"\x1b[?1049h"));
        assert!(s.full_screen() && !s.bracketed());
        s.resize(100, 30);
        let i = s.info();
        assert_eq!((i.cols, i.rows, i.controller), (100, 30, "agent"));
        s.set_paused(true);
        assert_eq!(s.info().controller, "user");
        assert!(i.can_run_commands);
    }

    #[test]
    fn a_password_proof_lasts_only_through_one_opening_of_the_vault() {
        let s = session();
        assert!(!s.proven(Some(0)) && !s.proven(None));
        s.set_proof(0);
        assert!(s.proven(Some(0)), "epoch 0 is a valid opening");
        assert!(!s.proven(Some(1)), "the vault was locked and opened again");
        assert!(!s.proven(None), "locked");
    }

    #[test]
    fn a_change_wakes_a_watcher() {
        let s = session();
        let rx = s.watch();
        assert!(!rx.has_changed().unwrap());
        s.on_frame(data(b"x"));
        assert!(rx.has_changed().unwrap());
    }
}
