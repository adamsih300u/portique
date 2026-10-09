//! Local terminal sessions: a shell on this computer, run on a pseudo-terminal.
//!
//! The shells on offer are found here (never typed in by the interface), and a session can only start
//! from one of them: its profile id is `local:<shell id>` and `profile_for` looks the id up in the
//! detected list, so the interface cannot ask for an arbitrary program.

use crate::session::{Ctl, Emitter, Params};
use crate::store::{Profile, Protocol};
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    io::{Read, Write},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::mpsc::UnboundedReceiver;

/// Prefix of the profile ids of local terminals, which exist only in memory.
pub const PREFIX: &str = "local:";

/// A shell found on this computer.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    /// Stable between runs (`bash`, `cmd`, `wsl:Ubuntu`); this is what the settings remember.
    pub id: String,
    pub name: String,
    /// The one a new user most likely wants; offered first and chosen when local terminals are first turned on.
    pub is_default: bool,
    #[serde(skip)]
    program: String,
    #[serde(skip)]
    args: Vec<String>,
}

fn shell(id: &str, name: &str, program: impl Into<String>, args: &[&str]) -> Shell {
    Shell { id: id.into(), name: name.into(), is_default: false, program: program.into(), args: args.iter().map(|s| s.to_string()).collect() }
}

fn cache() -> &'static Mutex<Vec<Shell>> {
    static CACHE: OnceLock<Mutex<Vec<Shell>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Looks for the shells again (on Windows this asks `wsl.exe` for its distributions, which takes a moment).
pub fn detect() -> Vec<Shell> {
    let found = detect_here();
    *cache().lock().unwrap() = found.clone();
    found
}

fn known() -> Vec<Shell> {
    let cached = cache().lock().unwrap().clone();
    if cached.is_empty() { detect() } else { cached }
}

/// The shell with this id (with or without the `local:` prefix), if it is one we found.
pub fn find(id: &str) -> Option<Shell> {
    let id = id.strip_prefix(PREFIX).unwrap_or(id);
    known().into_iter().find(|s| s.id == id)
}

pub fn profile_of(s: &Shell) -> Profile {
    Profile { id: format!("{PREFIX}{}", s.id), name: s.name.clone(), protocol: Protocol::Local, auto_reconnect: false, ..Default::default() }
}

/// The profile a session may start from: only for a shell that was found and that the settings turn on.
pub fn profile_for(id: &str, enabled: &crate::window::Settings) -> Option<Profile> {
    let shell_id = id.strip_prefix(PREFIX)?;
    if !enabled.local_terminals || !enabled.local_shells.iter().any(|s| s == shell_id) {
        return None;
    }
    find(shell_id).map(|s| profile_of(&s))
}

// ---- finding shells -------------------------------------------------------------

#[cfg(not(windows))]
fn detect_here() -> Vec<Shell> {
    let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    unix_shells(&listed, std::env::var("SHELL").ok().as_deref(), |p| std::path::Path::new(p).is_file())
}

/// Shells from the text of `/etc/shells`, the user's own first. One entry per program name.
#[cfg(any(not(windows), test))]
fn unix_shells(etc_shells: &str, login_shell: Option<&str>, exists: impl Fn(&str) -> bool) -> Vec<Shell> {
    // Terminal programs start a login shell on macOS, where the profile files are only read for those.
    let args: &[&str] = if cfg!(target_os = "macos") { &["-l"] } else { &[] };
    let mut paths: Vec<&str> = login_shell.into_iter().collect();
    paths.extend(etc_shells.lines().map(str::trim).filter(|l| l.starts_with('/')));
    let mut out: Vec<Shell> = Vec::new();
    for path in paths {
        let Some(name) = path.rsplit('/').next().filter(|n| !n.is_empty()) else { continue };
        if matches!(name, "nologin" | "false" | "true") || out.iter().any(|s| s.id == name) || !exists(path) {
            continue;
        }
        out.push(shell(name, name, path, args));
    }
    if let Some(first) = out.first_mut().filter(|_| login_shell.is_some()) {
        first.is_default = true;
    }
    out
}

#[cfg(windows)]
fn detect_here() -> Vec<Shell> {
    use std::path::{Path, PathBuf};
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let system32 = env("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32");
    let on_path = |exe: &str| {
        std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).map(|d| d.join(exe)).find(|p| p.is_file())
    };
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let mut out = Vec::new();

    let ps7 = on_path("pwsh.exe").or_else(|| env("ProgramFiles").map(|d| d.join(r"PowerShell\7\pwsh.exe")).filter(|p| p.is_file()));
    if let Some(p) = ps7 {
        out.push(shell("pwsh", "PowerShell 7", text(&p), &[]));
    }
    let ps5 = system32.join(r"WindowsPowerShell\v1.0\powershell.exe");
    if ps5.is_file() {
        out.push(shell("powershell", "Windows PowerShell", text(&ps5), &[]));
    }
    let cmd = env("ComSpec").filter(|p| p.is_file()).unwrap_or_else(|| system32.join("cmd.exe"));
    out.push(shell("cmd", "Command Prompt", text(&cmd), &[]));
    if let Some(bash) = env("ProgramFiles").map(|d| d.join(r"Git\bin\bash.exe")).filter(|p| p.is_file()) {
        out.push(shell("git-bash", "Git Bash", text(&bash), &["--login", "-i"]));
    }
    let wsl = system32.join("wsl.exe");
    if wsl.is_file() {
        for distro in wsl_distros(&wsl) {
            out.push(shell(&format!("wsl:{distro}"), &format!("WSL: {distro}"), text(&wsl), &["-d", &distro]));
        }
    }
    if let Some(first) = out.first_mut() {
        first.is_default = true;
    }
    out
}

/// The installed WSL distributions. `wsl.exe -l -q` answers in UTF-16; no distributions (or no WSL) gives an empty list.
#[cfg(windows)]
fn wsl_distros(wsl: &std::path::Path) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(wsl).args(["-l", "-q"]).creation_flags(CREATE_NO_WINDOW).output();
    match out {
        Ok(o) if o.status.success() => parse_wsl_list(&o.stdout),
        _ => Vec::new(),
    }
}

/// Reads the UTF-16 list `wsl.exe -l -q` prints: one name a line, with the helper distributions of Docker left out.
#[cfg(any(windows, test))]
fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop") && !l.chars().any(char::is_control))
        .collect()
}

// ---- running one ---------------------------------------------------------------------

/// How long to keep listening for the last output after the shell exits (a Windows console can hand it over late).
const DRAIN: Duration = Duration::from_millis(300);

fn dims(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

pub async fn run(p: &Profile, params: Params, em: Emitter, rx: UnboundedReceiver<Ctl>) -> Result<()> {
    let s = find(&p.id).filter(|_| p.id.starts_with(PREFIX)).context("that is not a local terminal this computer offers")?;
    em.status("connected", &format!("Started {}", s.name));
    let em2 = em.clone();
    pump(&s, dims(params.cols, params.rows), move |d| em2.data(d), rx).await
}

/// Runs the shell on a pseudo-terminal until it exits or the tab closes, passing its output to `out`.
async fn pump(s: &Shell, dims: PtySize, out: impl Fn(&[u8]) + Send + 'static, mut rx: UnboundedReceiver<Ctl>) -> Result<()> {
    let pair = native_pty_system().openpty(dims).context("cannot open a terminal")?;
    let mut cmd = CommandBuilder::new(&s.program);
    cmd.args(&s.args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(home) = dirs::home_dir().filter(|h| h.is_dir()) {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).with_context(|| format!("cannot start {}", s.name))?;
    drop(pair.slave); // so the reader sees the end of the output when the shell exits
    let master = pair.master;
    let mut reader = master.try_clone_reader()?;
    let mut writer = master.take_writer()?;
    let mut killer = child.clone_killer();

    let (read_done_tx, mut read_done_rx) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            out(&buf[..n]);
        }
        let _ = read_done_tx.send(());
    });
    let mut exited = tokio::task::spawn_blocking(move || child.wait());

    let mut reader_done = false;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Ctl::Input(d)) => {
                    if writer.write_all(&d).and_then(|_| writer.flush()).is_err() {
                        break; // the shell is gone; its exit is reported below
                    }
                }
                Some(Ctl::Resize(c, r)) => { let _ = master.resize(self::dims(c, r)); }
                Some(Ctl::Close) | None => { let _ = killer.kill(); break; }
            },
            _ = &mut read_done_rx => { reader_done = true; break }
            _ = &mut exited => break,
        }
    }
    let _ = killer.kill();
    // Let the last output arrive, then close the terminal, which also ends a reader that is still waiting.
    if !reader_done {
        let _ = tokio::time::timeout(DRAIN, &mut read_done_rx).await;
    }
    drop(writer);
    drop(master);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn unix_shells_prefer_the_login_shell_and_drop_duplicates() {
        let etc = "# valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/sbin/nologin\n/bin/zsh\n/missing/fish\n";
        let found = unix_shells(etc, Some("/bin/zsh"), |p| !p.starts_with("/missing"));
        let ids: Vec<_> = found.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["zsh", "sh", "bash"]);
        assert!(found[0].is_default && !found[1].is_default);
        assert_eq!(found[0].program, "/bin/zsh");
    }

    #[test]
    fn without_a_login_shell_nothing_is_default() {
        let found = unix_shells("/bin/sh\n", None, |_| true);
        assert_eq!(found.len(), 1);
        assert!(!found[0].is_default);
    }

    #[test]
    fn wsl_list_is_read_as_utf16() {
        let text = "\u{feff}Ubuntu\r\ndocker-desktop\r\nDebian\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu", "Debian"]);
        assert!(parse_wsl_list(&[]).is_empty());
    }

    #[test]
    fn only_enabled_known_shells_make_a_profile() {
        let mut s = crate::window::Settings::default();
        assert!(profile_for("local:nope", &s).is_none());
        s.local_terminals = true;
        s.local_shells = vec!["nope".into()];
        assert!(profile_for("local:nope", &s).is_none(), "an id that was not detected is refused");
        assert!(profile_for("bash", &s).is_none(), "the prefix is required");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_runs_on_a_terminal_and_obeys_input() {
        let sh = shell("sh", "sh", "/bin/sh", &[]);
        let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = seen.clone();
        let (tx, rx) = unbounded_channel();
        tx.send(Ctl::Resize(100, 30)).unwrap();
        tx.send(Ctl::Input(b"stty size; echo hello-$((6*7)); exit\r".to_vec())).unwrap();
        tokio::time::timeout(Duration::from_secs(10), pump(&sh, dims(80, 24), move |d| sink.lock().unwrap().extend_from_slice(d), rx))
            .await
            .expect("the shell should have exited")
            .unwrap();
        let text = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
        assert!(text.contains("hello-42"), "output was {text:?}");
        assert!(text.contains("30 100"), "the resize should reach the terminal: {text:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closing_the_tab_ends_a_shell_that_is_still_running() {
        let sh = shell("sh", "sh", "/bin/sh", &[]);
        let (tx, rx) = unbounded_channel();
        tx.send(Ctl::Close).unwrap();
        tokio::time::timeout(Duration::from_secs(10), pump(&sh, dims(80, 24), |_| {}, rx)).await.expect("close should end it").unwrap();
    }
}
