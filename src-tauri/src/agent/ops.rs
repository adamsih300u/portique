//! What an agent can do: the operations behind the MCP tools. Each one checks the policy again when it
//! runs, so a change of settings takes effect on the next call, and each speaks to the agent in
//! sentences it can act on.

use super::{
    approval::{Kind, Outcome, Question},
    exec,
    session::{AgentSession, Inflight, Info, Phase, Screen},
    transcript::{clean, unfinished_tail},
    Agents, ToolError, ToolResult, MAX_SESSIONS,
};
use crate::{
    session::{Ctl, Emitter, Params},
    window::AgentMode,
};
use serde::Serialize;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// Output returned to the agent unless it asks for more or less.
pub const DEFAULT_OUTPUT: usize = 32 * 1024;
pub const MAX_OUTPUT: usize = 256 * 1024;
const MAX_INPUT: usize = 64 * 1024;
/// How long opening a session may take before the agent is told it is still starting.
const CONNECT_WITHIN: Duration = Duration::from_secs(30);
/// If the wrapper has not been echoed by the shell after this long, the shell did not take it.
const MARKER_WITHIN: Duration = Duration::from_secs(8);
/// A pause in the output this long counts as the output having settled.
const QUIET: Duration = Duration::from_millis(150);
const SCREEN_COLS: (u16, u16, u16) = (20, 120, 400);
const SCREEN_ROWS: (u16, u16, u16) = (5, 32, 200);

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    /// `finished`, `running` (still going when the time ran out), `session-ended`, `user-took-over` or `no-marker`.
    pub status: &'static str,
    pub exit_code: Option<i32>,
    pub output: String,
    /// The middle of a long output was left out; `read_output` with `since: outputStart` has all of it.
    pub truncated: bool,
    pub duration_ms: u64,
    /// Where the next `read_output` goes on.
    pub cursor: u64,
    pub output_start: u64,
    pub note: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub output: String,
    pub truncated: bool,
    /// Pass this as `since` to read on from here.
    pub cursor: u64,
    /// The history no longer reached back to `since`; some output was lost.
    pub lost_before: bool,
    pub phase: super::session::Phase,
    pub controller: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Waited {
    pub matched: bool,
    /// The first match (or nothing).
    pub found: Option<String>,
    pub output: String,
    pub truncated: bool,
    pub cursor: u64,
    pub phase: super::session::Phase,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Typed {
    pub typed: String,
    /// What the terminal printed in reply, once it settled.
    pub output: String,
    pub truncated: bool,
    pub cursor: u64,
}

fn clamp(v: Option<u16>, (lo, def, hi): (u16, u16, u16)) -> u16 {
    v.unwrap_or(def).clamp(lo, hi)
}

/// Keeps the start and the end of `text`, within `max` bytes, with a note about what was left out.
pub fn limit(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let head_len = max / 3;
    let tail_len = max - head_len;
    let mut head = head_len;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - tail_len;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    let omitted = tail - head;
    (format!("{}\n[… {omitted} bytes left out …]\n{}", &text[..head], &text[tail..]), true)
}

/// How typed input reads in a dialog or the log: control keys as `^C`, Enter as ⏎.
pub fn show_keys(bytes: &[u8]) -> String {
    let mut out = String::new();
    for ch in String::from_utf8_lossy(bytes).chars() {
        match ch {
            '\r' | '\n' => out.push('⏎'),
            '\t' => out.push('⇥'),
            '\u{1b}' => out.push('⎋'),
            '\u{7f}' => out.push('⌫'),
            c if (c as u32) < 0x20 => {
                out.push('^');
                out.push((b'@' + c as u8) as char);
            }
            c => out.push(c),
        }
    }
    out
}

/// Waits until `rx` changes or `until` passes. True if it changed.
async fn changed(rx: &mut tokio::sync::watch::Receiver<u64>, until: Instant) -> bool {
    matches!(tokio::time::timeout_at(until.into(), rx.changed()).await, Ok(Ok(())))
}

fn ended_error(s: &AgentSession) -> ToolError {
    let st = s.status();
    let why = match st.state.as_str() {
        "vault-locked" => "Portique's vault is locked. Ask the user to unlock it, then open the session again.".to_string(),
        "need-password" => "The profile needs a password that is not saved. Ask the user to save it in Portique or connect once by hand.".to_string(),
        "need-passphrase" => "The key needs a passphrase that is not saved. Ask the user to unlock it in Portique first.".to_string(),
        "lost" => "The connection was lost.".to_string(),
        "closed" => "The session was closed.".to_string(),
        _ if st.message.is_empty() => "The session failed.".to_string(),
        _ => st.message,
    };
    ToolError(format!("The session has ended: {why} Open a new one."))
}

impl Agents {
    // ---- opening and closing ------------------------------------------------------------

    pub async fn open_session(&self, client: &str, profile_id: &str, cols: Option<u16>, rows: Option<u16>) -> ToolResult<Info> {
        let settings = self.enabled()?;
        let not_open = || ToolError("No profile with that id is open to agents. Call list_profiles for the ones that are; the user switches one on with right-click → Agent access.".into());
        let mode = settings.agent.mode(profile_id);
        if mode == AgentMode::Off {
            return Err(not_open());
        }
        let profile = self.0.host.profile(profile_id).map_err(|_| not_open())?;
        if profile.protocol == crate::store::Protocol::Api {
            return Err(not_open());
        }
        if self.live() >= MAX_SESSIONS {
            return Err(ToolError(format!("{MAX_SESSIONS} sessions are open already. Close one with close_session first.")));
        }
        if profile.protocol != crate::store::Protocol::Local && !self.0.host.vault_unlocked() {
            return Err(ToolError("Portique's vault is locked, and this profile signs in with a saved login. Ask the user to unlock it, then try again.".into()));
        }

        let host = match profile.protocol {
            crate::store::Protocol::Ssh | crate::store::Protocol::Telnet => format!("{}:{}", profile.host, profile.port),
            crate::store::Protocol::Serial => profile.serial.port.clone(),
            _ => String::new(),
        };
        let mut free = mode == AgentMode::Allow;
        if mode == AgentMode::Ask {
            let what = if host.is_empty() { profile.name.clone() } else { format!("{} ({host})", profile.name) };
            let q = Question { kind: Kind::Open, client, profile: &profile.name, session: None, text: &what };
            match self.0.approvals.ask(&*self.0.host, q, self.0.patience).await {
                Outcome::Decided(super::Decision::Once) => {}
                Outcome::Decided(super::Decision::Session) => free = true,
                Outcome::Decided(super::Decision::Deny) => {
                    self.record_refusal(client, &profile.name, "open", &what);
                    return Err(ToolError("The user declined to let you open this. Do not try again; ask them what they would like instead.".into()));
                }
                Outcome::TimedOut => return Err(ToolError("The user did not answer in time. You may ask again, once they are back.".into())),
                Outcome::Crowded => return Err(ToolError("Too many requests are waiting for the user. Wait for them to answer those first.".into())),
            }
        }

        let (cols, rows) = (clamp(cols, SCREEN_COLS), clamp(rows, SCREEN_ROWS));
        let session = Arc::new(AgentSession::new(&profile.id, &profile.name, &host, profile.protocol, client, cols, rows));
        session.set_free(free);
        let feed = session.clone();
        let id = crate::session::start(
            &self.0.sessions,
            profile.clone(),
            Params { cols, rows, ..Default::default() },
            Emitter::sink(move |frame| feed.on_frame(frame)),
        );
        session.set_id(id.clone());
        self.registry().insert(id.clone(), session.clone());
        self.log(&session, "open", &profile.name, "opened");
        self.0.host.emit(
            "agent-session",
            json!({ "session": id, "profile": profile.id, "name": profile.name, "protocol": profile.protocol, "client": client }),
        );
        self.wait_ready(&session).await
    }

    /// Waits for the session to come up: a few seconds to connect, longer while the person has a host key to confirm.
    async fn wait_ready(&self, s: &Arc<AgentSession>) -> ToolResult<Info> {
        let mut rx = s.watch();
        let started = Instant::now();
        let mut asked: Option<Instant> = None;
        loop {
            match s.phase() {
                Phase::Ready => return Ok(s.info()),
                Phase::Ended => return Err(ended_error(s)),
                Phase::AwaitingUser => {
                    if asked.is_none() {
                        asked = Some(Instant::now());
                        self.0.host.attention();
                    }
                }
                Phase::Starting => {}
            }
            let until = match asked {
                Some(at) => at + self.0.patience,
                None => started + CONNECT_WITHIN,
            };
            if !changed(&mut rx, until).await && Instant::now() >= until {
                // Not an error: the session exists and the agent can look again with list_sessions.
                return Ok(s.info());
            }
        }
    }

    pub async fn close_session(&self, id: &str) -> ToolResult<Info> {
        self.enabled()?;
        let s = self.get(id)?;
        if s.phase() != Phase::Ended {
            self.log(&s, "close", "", "closed by the agent");
            self.0.sessions.send(id, Ctl::Close);
            let mut rx = s.watch();
            let until = Instant::now() + Duration::from_secs(3);
            while s.phase() != Phase::Ended && changed(&mut rx, until).await {}
        }
        Ok(s.info())
    }

    pub fn list_sessions(&self) -> ToolResult<Vec<Info>> {
        self.enabled()?;
        Ok(self.sessions())
    }

    // ---- checks that come before typing ----------------------------------------------------

    fn writable(&self, s: &AgentSession) -> ToolResult<()> {
        match s.phase() {
            Phase::Ready => {}
            Phase::Starting => return Err("The session is still connecting. Wait a moment and look at list_sessions.".into()),
            Phase::AwaitingUser => return Err("The session is waiting for the user to confirm the server's host key in Portique. Tell them, and wait.".into()),
            Phase::Ended => return Err(ended_error(s)),
        }
        if s.paused() {
            return Err("The user has taken over this terminal. Stop here and ask them what they want; do not retry until they hand it back.".into());
        }
        Ok(())
    }

    /// The person's yes, when the profile's mode asks for one and the session is not already cleared.
    async fn approve(&self, s: &AgentSession, kind: Kind, text: &str) -> ToolResult<()> {
        let settings = self.enabled()?;
        match settings.agent.mode(&s.profile_id) {
            AgentMode::Off => return Err("The user withdrew agent access to this profile.".into()),
            AgentMode::Allow => return Ok(()),
            AgentMode::Ask if s.free() => return Ok(()),
            AgentMode::Ask => {}
        }
        let q = Question { kind, client: &s.client, profile: &s.name, session: Some(s.id()), text };
        match self.0.approvals.ask(&*self.0.host, q, self.0.patience).await {
            Outcome::Decided(super::Decision::Once) => Ok(()),
            Outcome::Decided(super::Decision::Session) => {
                s.set_free(true);
                Ok(())
            }
            Outcome::Decided(super::Decision::Deny) => {
                self.log(s, "refused", text, "the user declined");
                Err("The user declined this. Do not try again or work around it; ask them what they would like instead.".into())
            }
            Outcome::TimedOut => Err("The user did not answer in time, so nothing was typed. You may ask again, once they are back.".into()),
            Outcome::Crowded => Err("Too many requests are waiting for the user. Wait for them to answer those first.".into()),
        }
    }

    fn record_refusal(&self, client: &str, profile: &str, action: &str, text: &str) {
        self.record(super::Audit {
            at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            client: client.into(),
            profile: profile.into(),
            session: String::new(),
            action: "refused".into(),
            text: format!("{action}: {text}").chars().take(500).collect(),
            outcome: "the user declined".into(),
        });
    }

    fn type_into(&self, s: &AgentSession, bytes: Vec<u8>) -> ToolResult<()> {
        if self.0.sessions.send(s.id(), Ctl::Input(bytes)) {
            Ok(())
        } else {
            Err(ended_error(s))
        }
    }

    // ---- running a command ---------------------------------------------------------------------

    pub async fn run_command(&self, id: &str, command: &str, timeout_secs: Option<u64>, max_bytes: Option<usize>) -> ToolResult<CommandOutput> {
        self.enabled()?;
        let s = self.get(id)?;
        let Some(dialect) = s.dialect else {
            return Err("This session cannot tell when a command ends (it is not a POSIX shell). Use send_input to type, then wait_for or read_output.".into());
        };
        self.writable(&s)?;
        if s.full_screen() {
            return Err("A full-screen program is running. Use read_screen to see it and send_input to drive it (for example q or C-c to leave).".into());
        }
        let _one_at_a_time = s.run.try_lock().map_err(|_| ToolError::from("Another command is running in this session. Wait for it, or send_input C-c to interrupt it."))?;
        if let Some(inflight) = s.inflight() {
            let (raw, _) = s.since(inflight.from);
            if exec::find_end(&raw, 0, &inflight.nonce).is_some() {
                s.set_inflight(None);
            } else {
                return Err("The previous command is still running here. Follow it with wait_for or read_output, or interrupt it with send_input keys [\"C-c\"].".into());
            }
        }
        exec::check_command(command, s.bracketed()).map_err(|e| ToolError(format!("Not typed: {e}.")))?;
        // The person reads the command with anything that could disguise it spelled out.
        let shown = exec::show_text(command);
        self.approve(&s, Kind::Command, &shown).await?;
        self.writable(&s)?; // the person may have taken over while the question was open

        let nonce = exec::nonce();
        let from = s.end_offset();
        let bracketed = s.bracketed();
        s.set_inflight(Some(Inflight { nonce: nonce.clone(), from }));
        self.type_into(&s, exec::keystrokes(&exec::wrap(dialect, command, &nonce), bracketed))?;

        let max = max_bytes.unwrap_or(DEFAULT_OUTPUT).clamp(1024, MAX_OUTPUT);
        let started = Instant::now();
        let deadline = started + Duration::from_secs(timeout_secs.unwrap_or(30).clamp(1, 900));
        let mut rx = s.watch();
        let result = loop {
            let (raw, base) = s.since(from);
            let begin = exec::find_begin(&raw, &nonce).or((base > from).then_some(0));
            if let Some(b) = begin {
                if let Some(end) = exec::find_end(&raw, b, &nonce) {
                    let mut text = clean(&raw[b..end.output_end]);
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    let (output, truncated) = limit(text, max);
                    let cursor = base + end.after as u64;
                    break CommandOutput {
                        status: "finished",
                        exit_code: Some(end.code),
                        output,
                        truncated,
                        duration_ms: started.elapsed().as_millis() as u64,
                        cursor,
                        output_start: base + b as u64,
                        note: None,
                    };
                }
            }
            let now = Instant::now();
            let stop = if s.phase() == Phase::Ended {
                Some(("session-ended", "The session ended before the command finished."))
            } else if s.paused() {
                Some(("user-took-over", "The user took over the terminal while the command was running. Stop and ask them."))
            } else if begin.is_none() && now >= started + MARKER_WITHIN.min(deadline - started) {
                Some(("no-marker", "The shell did not run the command wrapper, so the end cannot be detected. It may not be a POSIX shell, or a program is waiting for input (look with read_screen; leave it with send_input)."))
            } else if now >= deadline {
                Some(("running", "Still running. Follow it with wait_for or read_output, or interrupt it with send_input keys [\"C-c\"]."))
            } else {
                None
            };
            if let Some((status, note)) = stop {
                let consumed = raw.len() - if s.phase() == Phase::Ended { 0 } else { unfinished_tail(&raw) };
                let seen_from = begin.unwrap_or(0);
                let text = exec::hide_markers(&clean(&raw[seen_from.min(consumed)..consumed]));
                let (output, truncated) = limit(text, max);
                if status == "no-marker" || status == "session-ended" {
                    s.set_inflight(None);
                }
                break CommandOutput {
                    status,
                    exit_code: None,
                    output,
                    truncated,
                    duration_ms: started.elapsed().as_millis() as u64,
                    cursor: base + consumed as u64,
                    output_start: base + seen_from as u64,
                    note: Some(note.into()),
                };
            }
            // Wake on output, and no later than the next moment a check could change. Output comes in bursts, so
            // look again once it has paused a moment: a command that prints a lot must not be rescanned per chunk.
            let wake = if begin.is_none() { (started + MARKER_WITHIN).min(deadline) } else { deadline };
            if changed(&mut rx, wake.max(now + Duration::from_millis(1))).await {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        };
        s.set_read_cursor(result.cursor);
        self.log(&s, "run", &shown, &match result.exit_code {
            Some(c) => format!("exit {c}"),
            None => result.status.to_string(),
        });
        Ok(result)
    }

    // ---- typing keys -------------------------------------------------------------------------------

    pub async fn send_input(&self, id: &str, text: Option<&str>, keys: &[String], wait_ms: Option<u64>) -> ToolResult<Typed> {
        self.enabled()?;
        let s = self.get(id)?;
        self.writable(&s)?;
        let mut bytes = text.unwrap_or_default().replace("\r\n", "\r").replace('\n', "\r").into_bytes();
        for k in keys {
            bytes.extend(exec::key(k).ok_or_else(|| ToolError(format!("Unknown key \"{k}\". Use names like Enter, Tab, Esc, Up, Down, Left, Right, Backspace, PageUp, or C-c for Ctrl+C.")))?);
        }
        if bytes.is_empty() {
            return Err("Nothing to type: give text, keys, or both.".into());
        }
        if bytes.len() > MAX_INPUT {
            return Err(format!("That is more than {} KiB; type less at a time.", MAX_INPUT / 1024).into());
        }
        let shown = show_keys(&bytes);
        self.approve(&s, Kind::Input, &shown).await?;
        self.writable(&s)?;

        // An interrupt abandons a command being followed, whose end marker will now never print.
        if bytes.iter().any(|b| *b == 0x03 || *b == 0x04) {
            s.set_inflight(None);
        }
        let before = s.end_offset();
        self.type_into(&s, bytes)?;
        self.log(&s, "input", &shown, "typed");

        let mut rx = s.watch();
        let cap = Instant::now() + Duration::from_millis(wait_ms.unwrap_or(400).min(10_000));
        while Instant::now() < cap {
            let quiet_until = (Instant::now() + QUIET).min(cap);
            if !changed(&mut rx, quiet_until).await {
                break;
            }
        }
        let (raw, base) = s.since(before);
        let consumed = raw.len() - if s.phase() == Phase::Ended { 0 } else { unfinished_tail(&raw) };
        let (output, truncated) = limit(exec::hide_markers(&clean(&raw[..consumed])), DEFAULT_OUTPUT);
        let cursor = base + consumed as u64;
        s.set_read_cursor(cursor);
        Ok(Typed { typed: shown, output, truncated, cursor })
    }

    // ---- reading ---------------------------------------------------------------------------------------

    pub async fn read_output(&self, id: &str, since: Option<u64>, max_bytes: Option<usize>, wait_ms: Option<u64>) -> ToolResult<Read> {
        self.enabled()?;
        let s = self.get(id)?;
        let from = since.unwrap_or_else(|| s.read_cursor());
        if let Some(ms) = wait_ms.filter(|ms| *ms > 0) {
            let mut rx = s.watch();
            let until = Instant::now() + Duration::from_millis(ms.min(60_000));
            while s.end_offset() <= from && s.phase() != Phase::Ended && changed(&mut rx, until).await {}
        }
        let (raw, start) = s.since(from);
        let consumed = raw.len() - if s.phase() == Phase::Ended { 0 } else { unfinished_tail(&raw) };
        let (output, truncated) = limit(exec::hide_markers(&clean(&raw[..consumed])), max_bytes.unwrap_or(DEFAULT_OUTPUT).clamp(1024, MAX_OUTPUT));
        let cursor = start + consumed as u64;
        if since.is_none() {
            s.set_read_cursor(cursor);
        }
        Ok(Read { output, truncated, cursor, lost_before: start > from, phase: s.phase(), controller: if s.paused() { "user" } else { "agent" } })
    }

    pub fn read_screen(&self, id: &str) -> ToolResult<(Screen, Phase)> {
        self.enabled()?;
        let s = self.get(id)?;
        Ok((s.screen(), s.phase()))
    }

    pub async fn wait_for(&self, id: &str, pattern: &str, since: Option<u64>, timeout_secs: Option<u64>, max_bytes: Option<usize>) -> ToolResult<Waited> {
        self.enabled()?;
        let s = self.get(id)?;
        let re = regex::RegexBuilder::new(&format!("(?m){pattern}"))
            .size_limit(1 << 20)
            .build()
            .map_err(|e| ToolError(format!("That pattern is not a valid regular expression: {e}")))?;
        let from = since.unwrap_or_else(|| s.read_cursor());
        let until = Instant::now() + Duration::from_secs(timeout_secs.unwrap_or(30).clamp(1, 900));
        let max = max_bytes.unwrap_or(DEFAULT_OUTPUT).clamp(1024, MAX_OUTPUT);
        let mut rx = s.watch();
        loop {
            let (raw, start) = s.since(from);
            let ended = s.phase() == Phase::Ended;
            let consumed = raw.len() - if ended { 0 } else { unfinished_tail(&raw) };
            let text = exec::hide_markers(&clean(&raw[..consumed]));
            let found = re.find(&text).map(|m| m.as_str().to_string());
            if found.is_some() || ended || Instant::now() >= until {
                let (output, truncated) = limit(text, max);
                let cursor = start + consumed as u64;
                if since.is_none() {
                    s.set_read_cursor(cursor);
                }
                return Ok(Waited { matched: found.is_some(), found, output, truncated, cursor, phase: s.phase() });
            }
            // Output arrives in bursts; look again once it has paused, not on every chunk.
            if changed(&mut rx, until).await {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{approval::Decision, testing::FakeHost};
    use crate::session::Sessions;
    use crate::window::{AgentMode, Settings};

    /// An agent set up against a fake app that offers a local shell. `mode` is the profile's access.
    fn setup(shell: &str, mode: AgentMode, patience: Duration) -> (Agents, Arc<FakeHost>, String) {
        let host = Arc::new(FakeHost::default());
        let found = crate::local::find(shell).unwrap_or_else(|| panic!("no {shell} on this computer"));
        let mut settings = Settings { local_terminals: true, local_shells: vec![found.id.clone()], ..Default::default() };
        let profile = crate::local::profile_of(&found, &settings);
        settings.agent.enabled = true;
        settings.agent.profiles.insert(profile.id.clone(), mode);
        *host.settings.lock().unwrap() = settings;
        host.local.lock().unwrap().push(profile.clone());
        let agents = Agents::with_patience(host.clone(), Sessions::default(), patience);
        (agents, host, profile.id)
    }

    async fn open(agents: &Agents, profile: &str) -> String {
        let info = agents.open_session("test-agent", profile, Some(100), Some(30)).await.expect("the shell should open");
        assert_eq!(info.phase, Phase::Ready);
        info.session
    }

    /// Lets the shell print its first prompt (and ask for bracketed paste) before the first command.
    async fn settled(agents: &Agents, id: &str) {
        let _ = agents.read_output(id, Some(0), None, Some(1500)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    #[tokio::test]
    async fn a_command_runs_in_a_posix_shell_and_reports_its_status() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;

        let out = agents.run_command(&id, "echo hello-$((6*7))", Some(20), None).await.unwrap();
        assert_eq!((out.status, out.exit_code, out.output.as_str()), ("finished", Some(0), "hello-42"));

        let out = agents.run_command(&id, "ls /definitely/not/here", Some(20), None).await.unwrap();
        assert_eq!(out.status, "finished");
        assert_ne!(out.exit_code, Some(0));
        assert!(out.output.contains("No such file"), "{:?}", out.output);

        // The shell is the same one: state carries over.
        agents.run_command(&id, "PQ_X=kept; cd /tmp", Some(20), None).await.unwrap();
        let out = agents.run_command(&id, "echo $PQ_X; pwd", Some(20), None).await.unwrap();
        assert_eq!(out.output, "kept\n/tmp");

        // Several lines, a loop and a quoted tab all arrive as typed.
        let out = agents.run_command(&id, "for i in 1 2 3\ndo\n  echo line$i\ndone", Some(20), None).await.unwrap();
        assert_eq!(out.output, "line1\nline2\nline3");
        agents.close_session(&id).await.unwrap();
    }

    fn approval_patience() -> Duration {
        Duration::from_secs(5)
    }

    #[tokio::test]
    async fn bash_takes_the_command_as_one_paste_so_tabs_survive() {
        let (agents, _host, profile) = setup("bash", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "printf 'a\tb\\n'\nprintf 'x\ty\\n'", Some(20), None).await.unwrap();
        assert_eq!(out.status, "finished");
        assert!(out.output.contains("a       b") && out.output.contains("x       y"), "{:?}", out.output);
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_long_output_keeps_its_two_ends() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done", Some(30), Some(2048)).await.unwrap();
        assert!(out.truncated && out.output.contains("line-0") && out.output.contains("line-2999") && out.output.contains("bytes left out"));
        assert!(out.output.len() < 2300);
        // All of it is still there to read.
        let all = agents.read_output(&id, Some(out.output_start), Some(MAX_OUTPUT), None).await.unwrap();
        assert!(all.output.contains("line-1500"));
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_slow_command_returns_while_running_and_can_be_followed() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "echo start; sleep 3; echo end", Some(1), None).await.unwrap();
        assert_eq!(out.status, "running");
        assert!(out.output.contains("start") && !out.output.contains("end"));
        // Another command is refused until this one is done.
        let busy = agents.run_command(&id, "echo no", Some(5), None).await.unwrap_err();
        assert!(busy.0.contains("still running"), "{busy:?}");
        let w = agents.wait_for(&id, "^end$", None, Some(15), None).await.unwrap();
        assert!(w.matched, "{w:?}");
        // The end marker has printed by now, so the next command is allowed.
        let out = agents.run_command(&id, "echo again", Some(20), None).await.unwrap();
        assert_eq!(out.output, "again");
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn an_interrupted_command_does_not_block_the_next() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "sleep 30", Some(1), None).await.unwrap();
        assert_eq!(out.status, "running");
        agents.send_input(&id, None, &["C-c".to_string()], Some(500)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let out = agents.run_command(&id, "echo back", Some(20), None).await.unwrap();
        assert_eq!(out.output, "back");
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn typing_reaches_a_program_waiting_for_input() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "read -p 'name? ' n; echo \"hi $n\"", Some(1), None).await.unwrap();
        assert_eq!(out.status, "running");
        assert!(out.output.contains("name?"));
        let typed = agents.send_input(&id, Some("sam"), &["Enter".to_string()], Some(1500)).await.unwrap();
        assert_eq!(typed.typed, "sam⏎");
        assert!(typed.output.contains("hi sam"), "{:?}", typed.output);
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn wait_for_finds_a_pattern_and_times_out_politely() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let cursor = agents.read_output(&id, None, None, None).await.unwrap().cursor;
        agents.send_input(&id, Some("sleep 1; echo ready-$((1+1))"), &["Enter".to_string()], Some(0)).await.unwrap();
        let w = agents.wait_for(&id, r"ready-\d", Some(cursor), Some(15), None).await.unwrap();
        assert_eq!(w.found.as_deref(), Some("ready-2"));
        let w = agents.wait_for(&id, "never-printed-zzz", None, Some(1), None).await.unwrap();
        assert!(!w.matched && w.found.is_none());
        let bad = agents.wait_for(&id, "(", None, Some(1), None).await.unwrap_err();
        assert!(bad.0.contains("regular expression"));
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn the_screen_shows_what_a_full_screen_program_draws() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        // Draw into the alternate screen the way an editor does.
        agents.send_input(&id, Some("printf '\\033[?1049h\\033[2J\\033[3;5Hdrawn-by-a-program'"), &["Enter".to_string()], Some(800)).await.unwrap();
        let (screen, _) = agents.read_screen(&id).unwrap();
        assert!(screen.full_screen);
        assert!(screen.text.contains("drawn-by-a-program"), "{:?}", screen.text);
        assert_eq!(screen.text.lines().nth(2).map(|l| l.find("drawn")), Some(Some(4)));
        let err = agents.run_command(&id, "echo x", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("full-screen"));
        agents.close_session(&id).await.unwrap();
    }

    // ---- who may do what ---------------------------------------------------------------------------------

    #[tokio::test]
    async fn nothing_opens_while_access_is_off_or_the_profile_is_not_marked() {
        let (agents, host, profile) = setup("sh", AgentMode::Off, approval_patience());
        let err = agents.open_session("a", &profile, None, None).await.unwrap_err();
        assert!(err.0.contains("No profile with that id is open to agents"), "{err:?}");
        let err = agents.open_session("a", "local:nope", None, None).await.unwrap_err();
        assert_eq!(err.0, agents.open_session("a", &profile, None, None).await.unwrap_err().0, "an unknown id and a closed one look the same");
        assert!(agents.profiles().unwrap().is_empty());

        host.settings.lock().unwrap().agent.enabled = false;
        host.settings.lock().unwrap().agent.profiles.insert(profile.clone(), AgentMode::Allow);
        assert!(agents.open_session("a", &profile, None, None).await.unwrap_err().0.contains("switched off"));
        assert!(agents.profiles().is_err());
    }

    #[tokio::test]
    async fn list_profiles_shows_only_what_is_open_and_no_secrets() {
        let (agents, host, profile) = setup("sh", AgentMode::Ask, approval_patience());
        host.saved.lock().unwrap().push(crate::store::Profile { id: "p1".into(), name: "web1".into(), host: "10.0.0.5".into(), port: 22, username: "root".into(), ..Default::default() });
        host.saved.lock().unwrap().push(crate::store::Profile { id: "p2".into(), name: "hidden".into(), ..Default::default() });
        host.saved.lock().unwrap().push(crate::store::Profile { id: "p3".into(), name: "api".into(), protocol: crate::store::Protocol::Api, ..Default::default() });
        {
            let mut s = host.settings.lock().unwrap();
            s.agent.profiles.insert("p1".into(), AgentMode::Allow);
            s.agent.profiles.insert("p3".into(), AgentMode::Allow);
        }
        let listed = agents.profiles().unwrap();
        let ids: Vec<_> = listed.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["p1", profile.as_str()], "an API endpoint has no terminal, and p2 is not marked");
        assert_eq!((listed[0].access, listed[1].access, listed[0].host.as_str()), ("allow", "ask", "10.0.0.5:22"));
        let json = serde_json::to_string(&listed).unwrap();
        assert!(!json.contains("root"), "the user name is not shown: {json}");
    }

    #[tokio::test]
    async fn ask_mode_puts_the_exact_command_to_the_person() {
        let (agents, host, profile) = setup("sh", AgentMode::Ask, approval_patience());
        *host.auto.lock().unwrap() = Some((agents.clone(), Decision::Once));
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "echo asked", Some(20), None).await.unwrap();
        assert_eq!(out.output, "asked");
        let shown: Vec<_> = host.events("agent-approval").iter().map(|e| (e["kind"].as_str().unwrap().to_string(), e["text"].as_str().unwrap().to_string())).collect();
        assert_eq!(shown[0].0, "open");
        assert_eq!(shown[1], ("command".to_string(), "echo asked".to_string()), "the dialog shows the command as given, not the wrapper");
        // "Once" asks again next time.
        agents.run_command(&id, "echo second", Some(20), None).await.unwrap();
        assert_eq!(host.events("agent-approval").len(), 3);
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn allowing_for_the_session_stops_the_questions() {
        let (agents, host, profile) = setup("sh", AgentMode::Ask, approval_patience());
        *host.auto.lock().unwrap() = Some((agents.clone(), Decision::Session));
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        agents.run_command(&id, "echo one", Some(20), None).await.unwrap();
        agents.run_command(&id, "echo two", Some(20), None).await.unwrap();
        agents.send_input(&id, Some("echo three"), &["Enter".to_string()], Some(300)).await.unwrap();
        assert_eq!(host.events("agent-approval").len(), 1, "only the open was asked");
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_no_types_nothing_and_tells_the_agent_not_to_work_around_it() {
        let (agents, host, profile) = setup("sh", AgentMode::Ask, approval_patience());
        *host.auto.lock().unwrap() = Some((agents.clone(), Decision::Once));
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        *host.auto.lock().unwrap() = Some((agents.clone(), Decision::Deny));
        let before = agents.get(&id).unwrap().end_offset();
        let err = agents.run_command(&id, "touch /tmp/pq-should-not-exist", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("declined") && err.0.contains("work around"), "{err:?}");
        let err = agents.send_input(&id, Some("x"), &[], Some(0)).await.unwrap_err();
        assert!(err.0.contains("declined"));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(agents.get(&id).unwrap().end_offset(), before, "nothing reached the shell");
        assert!(!std::path::Path::new("/tmp/pq-should-not-exist").exists());
        let log = agents.activity();
        assert!(log.iter().any(|a| a.action == "refused" && a.text.contains("pq-should-not-exist")));

        // Declining to open at all leaves no session behind.
        let (agents2, host2, profile2) = setup("sh", AgentMode::Ask, approval_patience());
        *host2.auto.lock().unwrap() = Some((agents2.clone(), Decision::Deny));
        assert!(agents2.open_session("a", &profile2, None, None).await.unwrap_err().0.contains("declined"));
        assert!(agents2.sessions().is_empty());
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn no_answer_in_time_types_nothing() {
        let (agents, host, profile) = setup("sh", AgentMode::Ask, Duration::from_millis(150));
        *host.auto.lock().unwrap() = Some((agents.clone(), Decision::Session));
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        *host.auto.lock().unwrap() = None;
        host.settings.lock().unwrap().agent.profiles.insert(profile.clone(), AgentMode::Ask);
        agents.get(&id).unwrap().set_free(false);
        let err = agents.run_command(&id, "echo late", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("did not answer in time"), "{err:?}");
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn when_the_person_types_the_agent_stops_until_it_is_handed_back() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        agents.took_control(&id);
        assert_eq!(agents.controller(&id), Some("user"));
        let err = agents.run_command(&id, "echo x", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("taken over"), "{err:?}");
        assert!(agents.send_input(&id, Some("x"), &[], None).await.unwrap_err().0.contains("taken over"));
        // Reading is still fine.
        assert!(agents.read_output(&id, None, None, None).await.is_ok());
        agents.handed_back(&id);
        let out = agents.run_command(&id, "echo mine-again", Some(20), None).await.unwrap();
        assert_eq!(out.output, "mine-again");
        let actions: Vec<_> = agents.activity().iter().map(|a| a.action.clone()).collect();
        assert!(actions.contains(&"took-control".to_string()) && actions.contains(&"handed-back".to_string()));
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn taking_over_mid_command_returns_what_has_printed() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let a2 = agents.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            a2.took_control(&id2);
        });
        let out = agents.run_command(&id, "echo begun; sleep 5", Some(30), None).await.unwrap();
        assert_eq!(out.status, "user-took-over");
        assert!(out.output.contains("begun"));
        agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn switching_a_profile_off_closes_its_sessions() {
        let (agents, host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        host.settings.lock().unwrap().agent.profiles.insert(profile.clone(), AgentMode::Off);
        let err = agents.run_command(&id, "echo x", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("withdrew"), "{err:?}");
        agents.policy_changed();
        let s = agents.get(&id).unwrap();
        let mut rx = s.watch();
        let until = Instant::now() + Duration::from_secs(5);
        while s.phase() != Phase::Ended && changed(&mut rx, until).await {}
        assert_eq!(s.phase(), Phase::Ended);
    }

    #[tokio::test]
    async fn a_session_that_exits_is_reported_ended_and_stays_readable() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        let out = agents.run_command(&id, "echo bye; exit 3", Some(10), None).await.unwrap();
        assert_eq!(out.status, "session-ended");
        assert!(out.output.contains("bye"));
        let err = agents.run_command(&id, "echo x", Some(5), None).await.unwrap_err();
        assert!(err.0.contains("has ended"), "{err:?}");
        assert!(agents.read_output(&id, Some(0), None, None).await.unwrap().output.contains("bye"));
        assert_eq!(agents.list_sessions().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_number_of_live_sessions_is_capped() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let mut ids = Vec::new();
        for _ in 0..MAX_SESSIONS {
            ids.push(open(&agents, &profile).await);
        }
        let err = agents.open_session("a", &profile, None, None).await.unwrap_err();
        assert!(err.0.contains("sessions are open already"), "{err:?}");
        agents.close_session(&ids[0]).await.unwrap();
        assert!(agents.open_session("a", &profile, None, None).await.is_ok());
        for id in &ids[1..] {
            agents.close_session(id).await.unwrap();
        }
    }

    #[tokio::test]
    async fn bad_input_is_refused_before_anything_is_typed() {
        let (agents, _host, profile) = setup("sh", AgentMode::Allow, approval_patience());
        let id = open(&agents, &profile).await;
        settled(&agents, &id).await;
        for bad in ["", "echo \u{3}", "echo \u{1b}[201~"] {
            let err = agents.run_command(&id, bad, Some(5), None).await.unwrap_err();
            assert!(err.0.starts_with("Not typed"), "{bad:?}: {err:?}");
        }
        assert!(agents.send_input(&id, None, &["hyper-x".to_string()], None).await.unwrap_err().0.contains("Unknown key"));
        assert!(agents.send_input(&id, None, &[], None).await.unwrap_err().0.contains("Nothing to type"));
        assert!(agents.run_command("nope", "ls", None, None).await.unwrap_err().0.contains("No such session"));
        agents.close_session(&id).await.unwrap();
    }

    #[test]
    fn limit_keeps_both_ends_on_character_boundaries() {
        let text = "é".repeat(5000);
        let (cut, truncated) = limit(text, 1001);
        assert!(truncated && cut.contains("bytes left out") && cut.starts_with('é') && cut.ends_with('é'));
        assert_eq!(limit("short".into(), 10), ("short".to_string(), false));
    }

    #[test]
    fn typed_keys_read_back_plainly() {
        assert_eq!(show_keys(b"ls -l\r"), "ls -l⏎");
        assert_eq!(show_keys(&[3]), "^C");
        assert_eq!(show_keys(b"\x1b[A"), "⎋[A");
    }
}
