//! The HTTP side of the MCP server: a listener on the loopback address only, speaking the Streamable
//! HTTP transport (one JSON-RPC message per POST, answered in the response).
//!
//! Who may talk to it:
//! - only this computer (it binds `127.0.0.1`), and only with the bearer token made at start-up;
//! - not a web page: a request carrying an `Origin` header is refused, and the `Host` header must name
//!   the loopback address and our port, which stops a page from reaching us through DNS rebinding;
//! - the token is written to `agent-endpoint.json` in Portique's data folder, readable by the user only,
//!   and changes at every start.

use super::{mcp, Agents, Endpoint};
use anyhow::{Context, Result};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::watch};

/// The one path the server answers on.
pub const PATH: &str = "/mcp";
/// Where the address and token are published for the bridge command.
pub const ENDPOINT_FILE: &str = "agent-endpoint.json";
const MAX_BODY: usize = 1 << 20;
const HEADER_WITHIN: Duration = Duration::from_secs(10);
const MAX_CLIENT_SESSIONS: usize = 64;

struct State {
    agents: Agents,
    token: String,
    port: u16,
    /// MCP session id → the name the agent gave itself, and when it started.
    clients: Mutex<HashMap<String, (String, Instant)>>,
}

pub struct Running {
    state: Arc<State>,
    stop: watch::Sender<bool>,
    file: Option<PathBuf>,
}

impl Running {
    pub fn endpoint(&self) -> Endpoint {
        Endpoint { url: format!("http://127.0.0.1:{}{PATH}", self.state.port), port: self.state.port }
    }

    pub fn stop(self) {
        let _ = self.stop.send(true);
        if let Some(f) = &self.file {
            let ours = std::fs::read_to_string(f).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).is_some_and(|v| v["pid"] == std::process::id());
            if ours {
                let _ = std::fs::remove_file(f);
            }
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Starts listening on a free loopback port and publishes where.
pub async fn start(agents: Agents) -> Result<Running> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.context("cannot listen for agents on this computer")?;
    let port = listener.local_addr()?.port();
    let state = Arc::new(State { agents: agents.clone(), token: random_token(), port, clients: Mutex::default() });
    let file = match agents.0.host.data_dir() {
        Ok(dir) => Some(publish(&dir, &state)?),
        Err(_) => None,
    };
    let (stop, stopped) = watch::channel(false);
    tokio::spawn(accept(listener, state.clone(), stopped));
    Ok(Running { state, stop, file })
}

/// Writes the address and token where only the user can read them, replacing a stale file from an earlier run.
fn publish(dir: &std::path::Path, state: &State) -> Result<PathBuf> {
    let path = dir.join(ENDPOINT_FILE);
    let tmp = dir.join(format!("{ENDPOINT_FILE}.tmp"));
    let body = serde_json::to_vec_pretty(&json!({
        "url": format!("http://127.0.0.1:{}{PATH}", state.port),
        "token": state.token,
        "pid": std::process::id(),
    }))?;
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp).context("cannot write the agent endpoint file")?;
        // `mode` only counts when the file is created; a leftover file keeps its old rights unless they are set again.
        #[cfg(unix)]
        f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        f.write_all(&body)?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

async fn accept(listener: TcpListener, state: Arc<State>, mut stopped: watch::Receiver<bool>) {
    loop {
        let stream = tokio::select! {
            _ = stopped.changed() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) if peer.ip().is_loopback() => stream,
                Ok(_) => continue,
                // Out of file handles and the like: wait, instead of spinning on the same error.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
        };
        let state = state.clone();
        let mut stopped = stopped.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(route(state, req).await) }
            });
            let conn = http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(HEADER_WITHIN).serve_connection(TokioIo::new(stream), svc);
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => {}
                // Switching access off drops every connection, calls in flight included.
                _ = stopped.changed() => {}
            }
        });
    }
}

fn reply(status: StatusCode, body: Option<Value>) -> Response<Full<Bytes>> {
    let mut r = Response::builder().status(status).header(header::CACHE_CONTROL, "no-store");
    let bytes = match body {
        Some(v) => {
            r = r.header(header::CONTENT_TYPE, "application/json");
            Bytes::from(v.to_string())
        }
        None => Bytes::new(),
    };
    r.body(Full::new(bytes)).expect("a valid response")
}

fn refuse(status: StatusCode, why: &str) -> Response<Full<Bytes>> {
    reply(status, Some(json!({ "error": why })))
}

fn header_str(req: &Request<Incoming>, name: header::HeaderName) -> Option<&str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// The checks every request passes before anything is read from it. `Some` is the refusal to send.
fn turn_away(state: &State, req: &Request<Incoming>) -> Option<Response<Full<Bytes>>> {
    let port = state.port;
    let host = header_str(req, header::HOST).unwrap_or_default().to_ascii_lowercase();
    if ![format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&host) {
        return Some(refuse(StatusCode::FORBIDDEN, "unexpected Host header"));
    }
    if req.headers().contains_key(header::ORIGIN) {
        return Some(refuse(StatusCode::FORBIDDEN, "requests from web pages are not accepted"));
    }
    let given = header_str(req, header::AUTHORIZATION).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    if !bool::from(given.as_bytes().ct_eq(state.token.as_bytes())) {
        let mut r = refuse(StatusCode::UNAUTHORIZED, "missing or wrong token");
        r.headers_mut().insert(header::WWW_AUTHENTICATE, header::HeaderValue::from_static("Bearer realm=\"portique\""));
        return Some(r);
    }
    if req.uri().path() != PATH {
        return Some(refuse(StatusCode::NOT_FOUND, "nothing here; the MCP endpoint is /mcp"));
    }
    None
}

async fn route(state: Arc<State>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    if let Some(refusal) = turn_away(&state, &req) {
        return refusal;
    }
    match *req.method() {
        Method::POST => post(&state, req).await,
        Method::DELETE => {
            if let Some(id) = header_str(&req, header::HeaderName::from_static("mcp-session-id")) {
                state.clients.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
            }
            reply(StatusCode::NO_CONTENT, None)
        }
        _ => {
            let mut r = refuse(StatusCode::METHOD_NOT_ALLOWED, "send JSON-RPC messages with POST");
            r.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static("POST, DELETE"));
            r
        }
    }
}

async fn post(state: &State, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let session = header_str(&req, header::HeaderName::from_static("mcp-session-id")).map(str::to_string);
    if !header_str(&req, header::CONTENT_TYPE).is_some_and(|t| t.to_ascii_lowercase().contains("json")) {
        return refuse(StatusCode::UNSUPPORTED_MEDIA_TYPE, "send application/json");
    }
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "the message is too large"),
    };
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return reply(StatusCode::BAD_REQUEST, Some(mcp::parse_error()));
    };
    let (batch, items) = match msg {
        Value::Array(a) if !a.is_empty() => (true, a),
        other => (false, vec![other]),
    };

    // An agent introduces itself once; the id we hand back identifies it from then on.
    let mut issued = None;
    let client = if let Some(name) = items.iter().find_map(mcp::client_name) {
        let id = super::exec::nonce() + &super::exec::nonce();
        let mut clients = state.clients.lock().unwrap_or_else(|p| p.into_inner());
        if clients.len() >= MAX_CLIENT_SESSIONS {
            if let Some(oldest) = clients.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone()) {
                clients.remove(&oldest);
            }
        }
        clients.insert(id.clone(), (name.clone(), Instant::now()));
        issued = Some(id);
        name
    } else if let Some(id) = &session {
        match state.clients.lock().unwrap_or_else(|p| p.into_inner()).get(id) {
            Some((name, _)) => name.clone(),
            // Unknown after a restart or a DELETE: the client starts over with `initialize`.
            None => return refuse(StatusCode::NOT_FOUND, "unknown session; send initialize again"),
        }
    } else {
        "an agent".to_string()
    };

    let mut replies = Vec::new();
    for item in items {
        replies.extend(mcp::handle(&state.agents, &client, item).await);
    }
    let mut response = match (replies.len(), batch) {
        (0, _) => reply(StatusCode::ACCEPTED, None),
        (1, false) => reply(StatusCode::OK, replies.pop()),
        _ => reply(StatusCode::OK, Some(Value::Array(replies))),
    };
    if let Some(id) = issued {
        if let Ok(v) = header::HeaderValue::from_str(&id) {
            response.headers_mut().insert(header::HeaderName::from_static("mcp-session-id"), v);
        }
    }
    response
}

// ---- what to give an agent program ----------------------------------------------------------------

/// The program that bridges stdio to this server: this very executable. In an AppImage the running file sits in a
/// temporary mount that changes every start, so the image itself is named instead.
pub fn bridge_program() -> String {
    std::env::var_os("APPIMAGE")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .map_or_else(|| "portique".to_string(), |p| p.to_string_lossy().into_owned())
}

/// Quotes a word for a POSIX shell command line.
fn quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Text to paste into an agent program's settings. `stdio` and `command` hold no secret and keep working after a restart;
/// `http` holds this run's token.
pub fn config(r: &Running, kind: &str) -> Option<String> {
    let program = bridge_program();
    let pretty = |v: Value| serde_json::to_string_pretty(&v).ok();
    match kind {
        "stdio" => pretty(json!({ "mcpServers": { "portique": { "command": program, "args": ["mcp"] } } })),
        "command" => Some(format!("{} mcp", quote(&program))),
        "http" => pretty(json!({ "mcpServers": { "portique": {
            "type": "http",
            "url": format!("http://127.0.0.1:{}{PATH}", r.state.port),
            "headers": { "Authorization": format!("Bearer {}", r.state.token) },
        } } })),
        _ => None,
    }
}

/// The address and token published by a running Portique, for the bridge. `None` when it is not running.
pub fn read_endpoint(dir: &std::path::Path) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(ENDPOINT_FILE)).ok()?).ok()?;
    let url = v["url"].as_str()?;
    // The token is only ever sent to this computer, whatever the file says.
    if !url.starts_with("http://127.0.0.1:") {
        return None;
    }
    Some((url.to_string(), v["token"].as_str()?.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::testing::FakeHost;
    use crate::session::Sessions;
    use crate::window::AgentMode;

    struct Up {
        agents: Agents,
        running: Running,
        url: String,
        token: String,
        dir: tempfile::TempDir,
        http: reqwest::Client,
    }

    async fn up() -> Up {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(FakeHost::default());
        *host.data.lock().unwrap() = Some(dir.path().to_path_buf());
        let found = crate::local::find("sh").unwrap();
        let mut s = crate::window::Settings { local_terminals: true, local_shells: vec![found.id.clone()], ..Default::default() };
        let profile = crate::local::profile_of(&found, &s);
        s.agent.enabled = true;
        s.agent.profiles.insert(profile.id.clone(), AgentMode::Allow);
        *host.settings.lock().unwrap() = s;
        host.local.lock().unwrap().push(profile);
        let agents = Agents::new(host, Sessions::default());
        let running = start(agents.clone()).await.unwrap();
        let token = running.state.token.clone();
        let url = running.endpoint().url;
        Up { agents, running, url, token, dir, http: reqwest::Client::new() }
    }

    trait Body {
        async fn value(self) -> Value;
    }
    impl Body for reqwest::Response {
        async fn value(self) -> Value {
            serde_json::from_slice(&self.bytes().await.unwrap()).unwrap()
        }
    }

    impl Up {
        fn post(&self, body: &str) -> reqwest::RequestBuilder {
            self.http.post(&self.url).bearer_auth(&self.token).header("content-type", "application/json").body(body.to_string())
        }
    }

    #[tokio::test]
    async fn only_a_request_with_the_token_is_answered() {
        let u = up().await;
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let r = u.post(ping).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.value().await["result"], json!({}));

        let no_token = u.http.post(&u.url).header("content-type", "application/json").body(ping).send().await.unwrap();
        assert_eq!(no_token.status(), 401);
        assert!(no_token.headers().contains_key("www-authenticate"));
        let wrong = u.http.post(&u.url).bearer_auth("0".repeat(64)).header("content-type", "application/json").body(ping).send().await.unwrap();
        assert_eq!(wrong.status(), 401);
        let shorter = u.http.post(&u.url).bearer_auth("x").header("content-type", "application/json").body(ping).send().await.unwrap();
        assert_eq!(shorter.status(), 401);
        assert_eq!(u.token.len(), 64);
    }

    #[tokio::test]
    async fn a_web_page_cannot_use_it_even_with_the_token() {
        let u = up().await;
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let from_page = u.post(ping).header("origin", "https://evil.example").send().await.unwrap();
        assert_eq!(from_page.status(), 403);
        let rebound = u.post(ping).header("host", "evil.example").send().await.unwrap();
        assert_eq!(rebound.status(), 403, "a rebound name is not ours");
        let right_name = u.post(ping).header("host", format!("localhost:{}", u.running.state.port)).send().await.unwrap();
        assert_eq!(right_name.status(), 200);
    }

    #[tokio::test]
    async fn the_transport_is_strict_about_what_it_takes() {
        let u = up().await;
        assert_eq!(u.http.get(&u.url).bearer_auth(&u.token).send().await.unwrap().status(), 405);
        assert_eq!(u.http.post(u.url.replace("/mcp", "/other")).bearer_auth(&u.token).header("content-type", "application/json").body("{}").send().await.unwrap().status(), 404);
        assert_eq!(u.http.post(&u.url).bearer_auth(&u.token).body("{}").send().await.unwrap().status(), 415);
        let bad = u.post("{not json").send().await.unwrap();
        assert_eq!(bad.status(), 400);
        assert_eq!(bad.value().await["error"]["code"], -32700);
        let huge = u.post(&"x".repeat(MAX_BODY + 10)).send().await.unwrap();
        assert_eq!(huge.status(), 413);
        let note = u.post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).send().await.unwrap();
        assert_eq!((note.status().as_u16(), note.bytes().await.unwrap().len()), (202, 0));
    }

    #[tokio::test]
    async fn an_agent_introduces_itself_and_its_session_is_remembered() {
        let u = up().await;
        let init = u.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test-agent"}}}"#).send().await.unwrap();
        assert_eq!(init.status(), 200);
        let sid = init.headers()["mcp-session-id"].to_str().unwrap().to_string();
        assert_eq!(sid.len(), 24);

        let list = u.post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).header("mcp-session-id", &sid).send().await.unwrap();
        assert_eq!(list.value().await["result"]["tools"].as_array().unwrap().len(), 9);

        // An id we never issued (or one that ended) must start over.
        let stale = u.post(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).header("mcp-session-id", "nope").send().await.unwrap();
        assert_eq!(stale.status(), 404);
        let del = u.http.delete(&u.url).bearer_auth(&u.token).header("mcp-session-id", &sid).send().await.unwrap();
        assert_eq!(del.status(), 204);
        assert_eq!(u.post(r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#).header("mcp-session-id", &sid).send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn the_agents_name_reaches_the_dialogs() {
        let u = up().await;
        let init = u.post(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Named Agent"}}}"#).send().await.unwrap();
        let sid = init.headers()["mcp-session-id"].to_str().unwrap().to_string();
        let open = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open_session","arguments":{"profile":"local:sh"}}}"#;
        let r = u.post(open).header("mcp-session-id", &sid).send().await.unwrap().value().await;
        assert_eq!(r["result"]["structuredContent"]["client"], "Named Agent", "{r}");
        let id = r["result"]["structuredContent"]["session"].as_str().unwrap().to_string();
        u.agents.close_session(&id).await.unwrap();
    }

    #[tokio::test]
    async fn a_batch_gets_a_batch_back() {
        let u = up().await;
        let r = u.post(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#).send().await.unwrap();
        let v = r.value().await;
        assert_eq!(v.as_array().unwrap().len(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_endpoint_file_is_private_and_goes_away_with_the_server() {
        use std::os::unix::fs::PermissionsExt;
        let u = up().await;
        let path = u.dir.path().join(ENDPOINT_FILE);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let (url, token) = read_endpoint(u.dir.path()).unwrap();
        assert_eq!((url, token), (u.url.clone(), u.token.clone()));
        std::fs::write(&path, r#"{"url":"http://evil.example:80/mcp","token":"t","pid":1}"#).unwrap();
        assert!(read_endpoint(u.dir.path()).is_none(), "a file that names another machine is not trusted with the token");
        std::fs::write(&path, format!(r#"{{"url":"{}","token":"{}","pid":{}}}"#, u.url, u.token, std::process::id())).unwrap();
        let (dir, http, url) = (u.dir, u.http, u.url);
        u.running.stop();
        assert!(!path.exists());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(http.post(&url).send().await.is_err(), "nothing listens any more");
        drop(dir);
    }

    #[tokio::test]
    async fn the_copyable_configurations() {
        let u = up().await;
        let stdio: Value = serde_json::from_str(&config(&u.running, "stdio").unwrap()).unwrap();
        assert_eq!(stdio["mcpServers"]["portique"]["args"], json!(["mcp"]));
        assert!(!config(&u.running, "stdio").unwrap().contains(&u.token), "the bridge needs no secret in its configuration");
        assert!(config(&u.running, "command").unwrap().ends_with(" mcp"));
        let http: Value = serde_json::from_str(&config(&u.running, "http").unwrap()).unwrap();
        assert_eq!(http["mcpServers"]["portique"]["url"], u.url.as_str());
        assert_eq!(http["mcpServers"]["portique"]["headers"]["Authorization"], format!("Bearer {}", u.token));
        assert!(config(&u.running, "nonsense").is_none());
        assert_eq!(quote("/opt/Portique App/portique"), "'/opt/Portique App/portique'");
        assert_eq!(quote("/usr/bin/portique"), "/usr/bin/portique");
        assert_eq!(quote("it's"), "'it'\\''s'");
    }
}
