//! SSH sessions over russh: password, key, key+password and keyboard-interactive auth.

use crate::{
    keys,
    session::{saved_password, ConnectionLost, Ctl, Emitter, NeedsInput, Params, Sessions},
    store::{self, AuthMethod, Profile},
    tunnel::{self, RemoteMap},
};
use anyhow::{anyhow, bail, Context, Result};
use russh::{
    client::{self, Handle, KeyboardInteractiveAuthResponse},
    keys::{ssh_key::HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use serde_json::json;
use serde::Serialize;
use std::{collections::HashMap, future::Future, pin::Pin, sync::{Arc, LazyLock, Mutex}, time::Duration};
use tokio::sync::mpsc::UnboundedReceiver;

type KnownHosts = HashMap<String, String>;

/// Serialises read-modify-write of known_hosts.json across concurrent connections.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// Entries are keyed `host:port#algorithm`, so a server offering a different key type is
/// never silently treated as the pinned one.
pub fn forget_host(host: &str, port: u16) -> Result<()> {
    let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut kh: KnownHosts = store::read_json("known_hosts.json")?;
    let prefix = format!("{host}:{port}#");
    kh.retain(|k, _| !k.starts_with(&prefix));
    store::write_json("known_hosts.json", &kh)
}

struct Handler {
    host_id: String,
    em: Emitter,
    sessions: Sessions,
    sid: String,
    rejection: Arc<Mutex<Option<String>>>,
    remote: RemoteMap,
}

impl Handler {
    fn reject(&self, msg: String) -> Result<bool, russh::Error> {
        *self.rejection.lock().unwrap() = Some(msg);
        Ok(false)
    }
}

impl client::Handler for Handler {
    type Error = russh::Error;

    /// The server opened a connection for one of our remote (-R) forwards.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        tunnel::accept_remote(&self.remote, connected_port, channel);
        Ok(())
    }

    /// Pinned host keys; unknown keys require explicit confirmation from the user.
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let (alg, fp) = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                (key.algorithm().to_string(), key.fingerprint(HashAlg::Sha256).to_string())
            }
            PublicKeyOrCertificate::Certificate(c) => {
                let k = c.public_key();
                (k.algorithm().to_string(), k.fingerprint(HashAlg::Sha256).to_string())
            }
        };
        let entry = format!("{}#{alg}", self.host_id);
        let known_other_type = {
            let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let kh: KnownHosts = store::read_json("known_hosts.json").unwrap_or_default();
            match kh.get(&entry) {
                Some(known) if *known == fp => return Ok(true),
                Some(known) => {
                    return self.reject(format!(
                        "HOST KEY CHANGED for {} ({alg}).\nExpected {known}\nGot      {fp}\n\
                         This could be a man-in-the-middle attack. If the server was legitimately \
                         reinstalled, use \"Forget saved host key\" in the profile and reconnect.",
                        self.host_id
                    ));
                }
                None => kh.keys().any(|k| k.starts_with(&format!("{}#", self.host_id))),
            }
        };

        let answer = self.sessions.ask_host(&self.sid);
        self.em.status_json(
            "confirm-host",
            json!({ "sid": self.sid, "host": self.host_id, "algorithm": alg, "fingerprint": fp, "knownOtherType": known_other_type }),
        );
        match tokio::time::timeout(CONFIRM_TIMEOUT, answer).await {
            Ok(Ok(true)) => {
                let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                let mut kh: KnownHosts = store::read_json("known_hosts.json").unwrap_or_default();
                kh.insert(entry, fp);
                store::write_json("known_hosts.json", &kh).map_err(|_| russh::Error::Disconnect)?;
                Ok(true)
            }
            _ => self.reject(format!("Host key for {} was not accepted.", self.host_id)),
        }
    }
}

type Hop = Arc<Handle<Handler>>;
const MAX_JUMPS: usize = 5;

/// Opens the transport to `p` (directly, or tunnelled through its jump host) and runs the SSH
/// handshake. Jump hosts are authenticated here with their saved credentials and appended to
/// `hops` (outermost first) so the caller keeps them alive; `p` itself is returned unauthenticated.
fn dial<'a>(
    p: &'a Profile,
    params: &'a Params,
    em: &'a Emitter,
    remote: &'a RemoteMap,
    hops: &'a mut Vec<Hop>,
    chain: &'a mut Vec<String>,
) -> Pin<Box<dyn Future<Output = Result<Handle<Handler>>> + Send + 'a>> {
    Box::pin(async move {
        let port = if p.port == 0 { 22 } else { p.port };
        let rejection = Arc::new(Mutex::new(None));
        let handler = Handler {
            host_id: format!("{}:{port}", p.host),
            em: em.clone(),
            sessions: params.sessions.clone(),
            sid: params.sid.clone(),
            rejection: rejection.clone(),
            remote: remote.clone(),
        };
        let config = Arc::new(client::Config {
            // A silent link is declared dead after ~45 s so the UI can reconnect.
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        });

        let timeout = Duration::from_secs(15);
        let connected = match p.jump_host.as_deref().filter(|j| !j.is_empty()) {
            Some(jid) => {
                if chain.len() >= MAX_JUMPS || chain.iter().any(|c| c == jid) {
                    bail!("jump host chain is too deep or loops back on itself");
                }
                let jp = store::get_profile(jid).context("the configured jump host no longer exists")?;
                chain.push(jid.to_string());
                let mut jump = dial(&jp, params, em, &RemoteMap::default(), hops, chain).await?;
                let jparams = Params { sid: params.sid.clone(), sessions: params.sessions.clone(), ..Default::default() };
                authenticate(&mut jump, &jp, &jparams).await.map_err(|e| match e.downcast_ref::<NeedsInput>() {
                    Some(_) => anyhow!(
                        "jump host \"{}\" needs a saved password or an unencrypted key; save it in that profile",
                        jp.name
                    ),
                    None => e.context(format!("jump host \"{}\"", jp.name)),
                })?;
                let ch = jump
                    .channel_open_direct_tcpip(p.host.as_str(), port as u32, "127.0.0.1", 0)
                    .await
                    .with_context(|| format!("jump host \"{}\" cannot reach {}:{port}", jp.name, p.host))?;
                hops.push(Arc::new(jump));
                tokio::time::timeout(timeout, client::connect_stream(config, ch.into_stream(), handler))
                    .await
                    .context("connection timed out")?
            }
            None => tokio::time::timeout(timeout, client::connect(config, (p.host.as_str(), port), handler))
                .await
                .context("connection timed out")?,
        };
        match connected {
            Ok(s) => Ok(s),
            Err(e) => match rejection.lock().unwrap().take() {
                Some(msg) => bail!(msg),
                None => Err(anyhow!(e).context(format!("cannot connect to {}:{port}", p.host))),
            },
        }
    })
}

/// The logged-in connection of each open shell, by session id, so a one-off command can run beside the shell.
static EXEC: LazyLock<Mutex<HashMap<String, Arc<Handle<Handler>>>>> = LazyLock::new(Default::default);

/// Keeps a connection in `EXEC` until the session ends, however it ends.
struct ExecRegistration(String);

impl ExecRegistration {
    fn new(sid: &str, session: &Arc<Handle<Handler>>) -> Self {
        EXEC.lock().unwrap_or_else(|p| p.into_inner()).insert(sid.to_string(), session.clone());
        Self(sid.to_string())
    }
}

impl Drop for ExecRegistration {
    fn drop(&mut self) {
        EXEC.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

/// Most output of one command that is kept; the rest is dropped and `truncated` is set.
const EXEC_MAX_OUT: usize = 1 << 20;
const EXEC_MAX_SECS: u64 = 120;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecOut {
    pub stdout: String,
    pub stderr: String,
    /// The exit status, if the server sent one.
    pub code: Option<u32>,
    pub truncated: bool,
}

fn push_capped(buf: &mut Vec<u8>, data: &[u8], truncated: &mut bool) {
    let room = EXEC_MAX_OUT.saturating_sub(buf.len());
    if data.len() > room {
        *truncated = true;
    }
    buf.extend_from_slice(&data[..data.len().min(room)]);
}

/// Runs one command on the server of the open shell `sid`, on a new channel of the same connection
/// (no second login). `stdin`, if given, is sent to it and then closed: a script for `sh` goes this way, which
/// needs no quoting and does not depend on the account's login shell. Waits for it to finish, at most `secs` seconds.
pub async fn exec(sid: &str, command: &str, stdin: Option<&str>, secs: u64) -> Result<ExecOut> {
    let session = EXEC.lock().unwrap_or_else(|p| p.into_inner()).get(sid).cloned().context("this session is not connected")?;
    let secs = secs.clamp(1, EXEC_MAX_SECS);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut ch = session.channel_open_session().await.map_err(|_| anyhow!("the connection is gone; reconnect and try again"))?;
    ch.exec(true, command).await?;
    if let Some(input) = stdin {
        ch.data(input.as_bytes()).await?;
        ch.eof().await?;
    }
    let (mut out, mut err, mut code, mut truncated) = (Vec::new(), Vec::new(), None, false);
    loop {
        let msg = match tokio::time::timeout_at(deadline, ch.wait()).await {
            Ok(m) => m,
            Err(_) => {
                let _ = ch.close().await;
                bail!("The command took longer than {secs} seconds and was stopped");
            }
        };
        match msg {
            Some(ChannelMsg::Data { data }) => push_capped(&mut out, &data, &mut truncated),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => push_capped(&mut err, &data, &mut truncated),
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(ExecOut { stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned(), code, truncated })
}

pub async fn run(p: &Profile, params: Params, em: Emitter, mut rx: UnboundedReceiver<Ctl>) -> Result<()> {
    let port = if p.port == 0 { 22 } else { p.port };
    let remote = RemoteMap::default();
    let mut hops: Vec<Hop> = Vec::new();
    let mut session = dial(p, &params, &em, &remote, &mut hops, &mut vec![p.id.clone()]).await?;

    authenticate(&mut session, p, &params).await?;
    em.status("connected", &format!("Connected to {}:{port}", p.host));

    let session = Arc::new(session);
    let _exec = ExecRegistration::new(&params.sid, &session);
    let (_tunnels, report) = tunnel::start(&session, &p.forwards, &remote).await;
    if !report.is_empty() {
        let items: Vec<_> = report.iter().map(|s| json!({ "label": s.label, "error": s.error })).collect();
        em.status_json("tunnels", json!(items));
    }

    let mut channel = session.channel_open_session().await?;
    channel.request_pty(false, "xterm-256color", params.cols as u32, params.rows as u32, 0, 0, &[]).await?;
    channel.request_shell(true).await?;

    loop {
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => em.data(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                None => return Err(ConnectionLost.into()),
                _ => {}
            },
            c = rx.recv() => match c {
                Some(Ctl::Input(d)) => channel.data_bytes(d).await.map_err(|_| ConnectionLost)?,
                Some(Ctl::Resize(c, r)) => channel.window_change(c as u32, r as u32, 0, 0).await.map_err(|_| ConnectionLost)?,
                Some(Ctl::Close) | None => break,
            }
        }
    }
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    for hop in hops.iter().rev() {
        let _ = hop.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

/// Like `run`, but opens the SFTP subsystem instead of a shell and serves file-browser requests (see `sftp.rs`).
pub async fn run_sftp(p: &Profile, params: Params, em: Emitter, rx: UnboundedReceiver<Ctl>) -> Result<()> {
    let remote = RemoteMap::default();
    let mut hops: Vec<Hop> = Vec::new();
    let mut session = dial(p, &params, &em, &remote, &mut hops, &mut vec![p.id.clone()]).await?;
    authenticate(&mut session, p, &params).await?;
    let session = Arc::new(session);

    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await.context("the server refused the SFTP subsystem")?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow!("SFTP handshake failed: {e}"))?;
    let watched = session.clone();
    let res = crate::sftp::serve(&params.sid, sftp, em, rx, move || watched.is_closed()).await;
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    for hop in hops.iter().rev() {
        let _ = hop.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    res
}

/// Logs in like `run`, but instead of a shell offers a local SOCKS5 proxy that dials through this
/// server. The API client sends requests through it to reach hosts only the server can see.
/// Reports `{"port": n}` as a `proxy` status once ready, then runs until closed or the link dies.
pub async fn run_proxy(p: &Profile, params: Params, em: Emitter, mut rx: UnboundedReceiver<Ctl>) -> Result<()> {
    let remote = RemoteMap::default();
    let mut hops: Vec<Hop> = Vec::new();
    let mut session = dial(p, &params, &em, &remote, &mut hops, &mut vec![p.id.clone()]).await?;
    authenticate(&mut session, p, &params).await?;
    let session = Arc::new(session);

    let (port, listener) = tunnel::socks_proxy(session.clone()).await.context("could not open a local proxy port")?;
    em.status_json("proxy", json!({ "port": port }));
    let res = loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Ctl::Close) | None => break Ok(()),
                Some(_) => {}
            },
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if session.is_closed() { break Err(ConnectionLost.into()); }
            }
        }
    };
    listener.abort();
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    for hop in hops.iter().rev() {
        let _ = hop.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    res
}

async fn authenticate(s: &mut Handle<Handler>, p: &Profile, params: &Params) -> Result<()> {
    match p.auth_method {
        AuthMethod::Password => password_auth(s, p, params).await,
        AuthMethod::Key => {
            if key_auth(s, p, params).await?.success() { Ok(()) } else { bail!("key authentication rejected") }
        }
        AuthMethod::KeyAndPassword => match key_auth(s, p, params).await? {
            russh::client::AuthResult::Success => Ok(()),
            russh::client::AuthResult::Failure { partial_success: true, .. } => password_auth(s, p, params).await,
            _ => bail!("key authentication rejected"),
        },
    }
}

async fn key_auth(s: &mut Handle<Handler>, p: &Profile, params: &Params) -> Result<russh::client::AuthResult> {
    let key_id = p.key_id.as_deref().context("no key assigned to this profile")?;
    let key = match keys::load(key_id, params.passphrase.as_deref()) {
        Ok(k) => k,
        Err(_) if params.passphrase.is_none() && keys::needs_passphrase(key_id)? => {
            return Err(NeedsInput("passphrase").into());
        }
        Err(e) => return Err(e),
    };
    let hash = s.best_supported_rsa_hash().await?.flatten();
    Ok(s.authenticate_publickey(&p.username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?)
}

async fn password_auth(s: &mut Handle<Handler>, p: &Profile, params: &Params) -> Result<()> {
    let pw = saved_password(p, &params.password).ok_or(NeedsInput("password"))?;
    if s.authenticate_password(&p.username, &pw).await?.success() {
        return Ok(());
    }
    // Many servers expose passwords only through keyboard-interactive.
    let mut r = s.authenticate_keyboard_interactive_start(&p.username, None).await?;
    for _ in 0..5 {
        match r {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => break,
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                r = s.authenticate_keyboard_interactive_respond(prompts.iter().map(|_| pw.clone()).collect()).await?;
            }
        }
    }
    bail!("authentication failed (check username/password)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AuthMethod, Profile};
    use std::sync::Mutex as StdMutex;
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn output_is_capped_and_flagged() {
        let (mut buf, mut truncated) = (Vec::new(), false);
        push_capped(&mut buf, &vec![b'a'; EXEC_MAX_OUT - 1], &mut truncated);
        assert!(!truncated);
        push_capped(&mut buf, b"bcd", &mut truncated);
        assert!(truncated);
        assert_eq!(buf.len(), EXEC_MAX_OUT);
        assert_eq!(buf.last(), Some(&b'b'));
        push_capped(&mut buf, b"x", &mut truncated);
        assert_eq!(buf.len(), EXEC_MAX_OUT);
    }

    #[tokio::test]
    async fn exec_needs_an_open_session() {
        let err = exec("no-such-session", "true", None, 5).await.unwrap_err();
        assert!(err.to_string().contains("not connected"), "got: {err:#}");
    }

    /// Needs a running sshd: set PORTIQUE_TEST_SSH_PORT, PORTIQUE_TEST_SSH_USER, PORTIQUE_TEST_SSH_KEY.
    /// Opens a shell session, runs commands beside it, and checks the connection is released on close.
    #[tokio::test]
    #[ignore]
    async fn exec_beside_a_shell_against_local_sshd() {
        let env = |k: &str| std::env::var(k).unwrap();
        let pem = std::fs::read_to_string(env("PORTIQUE_TEST_SSH_KEY")).unwrap();
        crate::vault::global().create("integration-test-pass", crate::vault::Kdf { m: 64, t: 1, p: 1 }).unwrap();
        let key = keys::import("test", &pem, None).unwrap();
        let p = Profile {
            host: "127.0.0.1".into(), port: env("PORTIQUE_TEST_SSH_PORT").parse().unwrap(), username: env("PORTIQUE_TEST_SSH_USER"),
            auth_method: AuthMethod::Key, key_id: Some(key.id.clone()), ..Default::default()
        };
        let sessions = Sessions::default();
        let params = Params { cols: 80, rows: 24, sid: "ex".into(), sessions: sessions.clone(), ..Default::default() };
        tokio::spawn(async move {
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                sessions.answer_host("ex", true);
            }
        });
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn({ let em = Emitter::new(Channel::new(|_| Ok(()))); async move { run(&p, params, em, rx).await } });
        for _ in 0..50 {
            if EXEC.lock().unwrap().contains_key("ex") { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let r = exec("ex", "echo out-$((6*7)); echo oops >&2; exit 3", None, 10).await.unwrap();
        assert_eq!((r.stdout.as_str(), r.stderr.as_str(), r.code, r.truncated), ("out-42\n", "oops\n", Some(3), false));
        // Two at once, on the same connection.
        let (a, b) = tokio::join!(exec("ex", "sleep 1; echo a", None, 10), exec("ex", "echo b", None, 10));
        assert_eq!((a.unwrap().stdout, b.unwrap().stdout), ("a\n".to_string(), "b\n".to_string()));
        // A command that outlives its time is stopped, and the connection still works afterwards.
        let started = std::time::Instant::now();
        let err = exec("ex", "sleep 30", None, 1).await.unwrap_err();
        assert!(err.to_string().contains("longer than 1 seconds"), "got: {err:#}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(exec("ex", "echo still-here", None, 10).await.unwrap().stdout, "still-here\n");
        // A script on stdin runs under sh, whatever the login shell is, and its exit status comes back.
        let r = exec("ex", "sh", Some("echo from-stdin-$((1+2))\nexit 4\n"), 10).await.unwrap();
        assert_eq!((r.stdout.as_str(), r.code), ("from-stdin-3\n", Some(4)));
        // More output than the cap is cut off and flagged.
        let big = exec("ex", "head -c 2000000 /dev/zero | tr '\\0' x", None, 20).await.unwrap();
        assert!(big.truncated && big.stdout.len() == EXEC_MAX_OUT);

        tx.send(Ctl::Close).unwrap();
        task.await.unwrap().unwrap();
        assert!(!EXEC.lock().unwrap().contains_key("ex"));
        assert!(exec("ex", "true", None, 5).await.is_err());
        keys::delete(&key.id).unwrap();
    }

    /// Needs two running sshd instances (jump + target): set PORTIQUE_TEST_SSH_PORT (target),
    /// PORTIQUE_TEST_JUMP_PORT, PORTIQUE_TEST_SSH_USER, PORTIQUE_TEST_SSH_KEY. Run with XDG_CONFIG_HOME
    /// pointing at a scratch directory: it writes profiles, keys and a vault there.
    #[tokio::test]
    #[ignore]
    async fn jump_host_and_forwards_against_local_sshd() {
        use crate::store::{Forward, ForwardKind};
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}};
        let env = |k: &str| std::env::var(k).unwrap();
        let (port, jump_port): (u16, u16) = (env("PORTIQUE_TEST_SSH_PORT").parse().unwrap(), env("PORTIQUE_TEST_JUMP_PORT").parse().unwrap());
        let pem = std::fs::read_to_string(env("PORTIQUE_TEST_SSH_KEY")).unwrap();
        crate::vault::global().create("pylon-quartz-marmot-velvet-9", crate::vault::Kdf { m: 64, t: 1, p: 1 }).unwrap();
        let key = keys::import("test", &pem, None).unwrap();

        // A TCP echo server standing in for "the service behind the server".
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 256];
                    while let Ok(n) = s.read(&mut buf).await {
                        if n == 0 || s.write_all(&buf[..n]).await.is_err() { break; }
                    }
                });
            }
        });
        let free = || std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (lport, dport, rport) = (free(), free(), free());

        let base = |id: &str, port: u16| Profile {
            id: id.into(), name: id.into(), host: "127.0.0.1".into(), port, username: env("PORTIQUE_TEST_SSH_USER"),
            auth_method: AuthMethod::Key, key_id: Some(key.id.clone()), ..Default::default()
        };
        let fwd = |kind, listen_port| Forward { kind, listen_port, dest_host: "127.0.0.1".into(), dest_port: echo_port };
        let target = Profile {
            jump_host: Some("jump".into()),
            forwards: vec![fwd(ForwardKind::Local, lport), fwd(ForwardKind::Dynamic, dport), fwd(ForwardKind::Remote, rport)],
            ..base("target", port)
        };
        store::save_profiles(&vec![base("jump", jump_port), target.clone()]).unwrap();

        let frames = Arc::new(StdMutex::new(Vec::<String>::new()));
        let sink = frames.clone();
        let em = Emitter::new(Channel::new(move |b: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(v) = b {
                if v[0] == 1 { sink.lock().unwrap().push(String::from_utf8_lossy(&v[1..]).to_string()); }
            }
            Ok(())
        }));
        let sessions = Sessions::default();
        let params = Params { cols: 80, rows: 24, sid: "t".into(), sessions: sessions.clone(), ..Default::default() };
        tokio::spawn({
            let sessions = sessions.clone();
            async move { for _ in 0..100 { tokio::time::sleep(Duration::from_millis(100)).await; sessions.answer_host("t", true); } }
        });
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move { run(&target, params, em, rx).await });
        tokio::time::sleep(Duration::from_secs(3)).await;

        let echoes = |mut s: TcpStream, msg: &'static [u8]| async move {
            s.write_all(msg).await.unwrap();
            let mut buf = vec![0u8; msg.len()];
            tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut buf)).await.expect("echo timed out").unwrap();
            assert_eq!(buf, msg);
        };
        // -L
        echoes(TcpStream::connect(("127.0.0.1", lport)).await.unwrap(), b"local-forward").await;
        // -D: SOCKS5 CONNECT to the echo server by IPv4 address
        let mut s = TcpStream::connect(("127.0.0.1", dport)).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut r = [0u8; 2];
        s.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [5, 0]);
        s.write_all(&[5, 1, 0, 1, 127, 0, 0, 1]).await.unwrap();
        s.write_all(&echo_port.to_be_bytes()).await.unwrap();
        let mut reply = [0u8; 10];
        s.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0, "SOCKS connect failed: {reply:?}");
        echoes(s, b"socks-forward").await;
        // -R: the server listens, we connect out to the echo server
        echoes(TcpStream::connect(("127.0.0.1", rport)).await.unwrap(), b"remote-forward").await;

        let all = frames.lock().unwrap().join("\n");
        assert!(all.contains("\"state\":\"tunnels\""), "no tunnel report: {all}");
        assert!(!all.contains("cannot listen") && !all.contains("refused") && !all.contains("\"state\":\"error\""), "a forward failed: {all}");
        tx.send(Ctl::Close).unwrap();
        task.await.unwrap().unwrap();
        keys::delete(&key.id).unwrap();
    }

    /// Connects, then waits for the test harness to kill the server-side session process
    /// (see PORTIQUE_TEST_KILL_FILE, touched once connected) and expects a "lost" status, not a
    /// clean close. Needs a running sshd like the other integration tests.
    #[tokio::test]
    #[ignore]
    async fn dropped_connection_is_reported_as_lost() {
        let env = |k: &str| std::env::var(k).unwrap();
        let pem = std::fs::read_to_string(env("PORTIQUE_TEST_SSH_KEY")).unwrap();
        crate::vault::global().create("pylon-quartz-marmot-velvet-9", crate::vault::Kdf { m: 64, t: 1, p: 1 }).unwrap();
        let key = keys::import("test", &pem, None).unwrap();
        let p = Profile {
            host: "127.0.0.1".into(), port: env("PORTIQUE_TEST_SSH_PORT").parse().unwrap(), username: env("PORTIQUE_TEST_SSH_USER"),
            auth_method: AuthMethod::Key, key_id: Some(key.id.clone()), ..Default::default()
        };
        let states = Arc::new(StdMutex::new(Vec::<String>::new()));
        let sink = states.clone();
        let em = Emitter::new(Channel::new(move |b: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(v) = b {
                if v[0] == 1 {
                    let j: serde_json::Value = serde_json::from_slice(&v[1..]).unwrap();
                    sink.lock().unwrap().push(j["state"].as_str().unwrap().to_string());
                }
            }
            Ok(())
        }));
        let sessions = Sessions::default();
        let params = Params { cols: 80, rows: 24, sid: "t".into(), sessions: sessions.clone(), ..Default::default() };
        tokio::spawn(async move { for _ in 0..50 { tokio::time::sleep(Duration::from_millis(100)).await; sessions.answer_host("t", true); } });
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move { run(&p, params, em, rx).await });
        tokio::time::sleep(Duration::from_secs(2)).await;
        std::fs::write(env("PORTIQUE_TEST_KILL_FILE"), "connected").unwrap();
        let res = tokio::time::timeout(Duration::from_secs(std::env::var("PORTIQUE_TEST_WAIT").ok().and_then(|v| v.parse().ok()).unwrap_or(40)), task).await.expect("session never ended").unwrap();
        let err = res.expect_err("a dropped link must be an error, not a clean close");
        assert!(err.is::<ConnectionLost>(), "got: {err:#}");
        assert!(states.lock().unwrap().contains(&"connected".to_string()));
        keys::delete(&key.id).unwrap();
    }

    /// Needs a running sshd: set PORTIQUE_TEST_SSH_PORT, PORTIQUE_TEST_SSH_USER, PORTIQUE_TEST_SSH_KEY.
    #[tokio::test]
    #[ignore]
    async fn key_auth_against_local_sshd() {
        let port: u16 = std::env::var("PORTIQUE_TEST_SSH_PORT").unwrap().parse().unwrap();
        let user = std::env::var("PORTIQUE_TEST_SSH_USER").unwrap();
        let pem = std::fs::read_to_string(std::env::var("PORTIQUE_TEST_SSH_KEY").unwrap()).unwrap();
        crate::vault::global().create("pylon-quartz-marmot-velvet-9", crate::vault::Kdf { m: 64, t: 1, p: 1 }).unwrap();
        let info = keys::import("test", &pem, None).unwrap();

        let out = Arc::new(StdMutex::new(Vec::<u8>::new()));
        let sink = out.clone();
        let ch = Channel::new(move |b: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(v) = b {
                if v[0] == 0 { sink.lock().unwrap().extend_from_slice(&v[1..]); } else { eprintln!("status: {}", String::from_utf8_lossy(&v[1..])); }
            }
            Ok(())
        });
        let p = Profile {
            host: "127.0.0.1".into(), port, username: user, auth_method: AuthMethod::Key,
            key_id: Some(info.id.clone()), ..Default::default()
        };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let sessions = Sessions::default();
        let params = Params { cols: 80, rows: 24, sid: "t".into(), sessions: sessions.clone(), ..Default::default() };
        // Stand in for the user clicking "Accept" on the host-key dialog.
        tokio::spawn(async move {
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                sessions.answer_host("t", true);
            }
        });
        let task = tokio::spawn({ let em = Emitter::new(ch); async move { run(&p, params, em, rx).await } });
        tokio::time::sleep(Duration::from_secs(2)).await;
        tx.send(Ctl::Input(b"echo hello-$((6*7))\nexit\n".to_vec())).unwrap();
        task.await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
        assert!(text.contains("hello-42"), "output was: {text}");

        // Second connect: the key is pinned now, so no prompt (nobody answers) and it still works.
        let silent = Emitter::new(Channel::new(|_| Ok(())));
        let (tx2, rx2) = tokio::sync::mpsc::unbounded_channel();
        let p2 = Profile { host: "127.0.0.1".into(), port, username: std::env::var("PORTIQUE_TEST_SSH_USER").unwrap(),
            auth_method: AuthMethod::Key, key_id: Some(info.id.clone()), ..Default::default() };
        let t = tokio::spawn({ let p2 = p2.clone(); async move { run(&p2, Params::default(), silent, rx2).await } });
        tokio::time::sleep(Duration::from_secs(1)).await;
        tx2.send(Ctl::Close).unwrap();
        t.await.unwrap().unwrap();

        // Tamper with the pinned fingerprint: the connection must be refused as a changed key.
        let mut kh: KnownHosts = store::read_json("known_hosts.json").unwrap();
        for v in kh.values_mut() { *v = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(); }
        store::write_json("known_hosts.json", &kh).unwrap();
        let (_tx3, rx3) = tokio::sync::mpsc::unbounded_channel();
        let err = run(&p2, Params::default(), Emitter::new(Channel::new(|_| Ok(()))), rx3).await.unwrap_err();
        assert!(err.to_string().contains("HOST KEY CHANGED"), "got: {err:#}");
        keys::delete(&info.id).unwrap();
    }
}
