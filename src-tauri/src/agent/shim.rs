//! `portique mcp`: the stdio transport for agent programs that start their MCP server as a command.
//!
//! It holds no logic and no secret of its own. Each line it reads on stdin is one JSON-RPC message; it
//! posts that to the running Portique (address and token from `agent-endpoint.json`, read afresh each
//! time so a restart of the app does not break it) and prints the reply as one line on stdout.

use super::server::read_endpoint;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::Mutex,
};

/// Reported to the agent when the app cannot be reached.
const NOT_RUNNING: &str = "Portique is not running, or agent access is switched off. Open Portique and turn on Settings → Agent access, then try again.";

struct Bridge {
    dir: PathBuf,
    http: reqwest::Client,
    /// The MCP session the app gave us, and the `initialize` that made it, to start over if the app forgets it.
    session: Mutex<Option<String>>,
    hello: Mutex<Option<String>>,
    out: Mutex<Out>,
}

type Out = Box<dyn AsyncWrite + Send + Unpin>;

/// Runs the bridge until stdin closes. The exit code for `main`.
pub fn main() -> i32 {
    let Ok(dir) = crate::store::data_dir() else {
        eprintln!("portique mcp: cannot find Portique's data folder");
        return 1;
    };
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread().enable_all().build() else {
        eprintln!("portique mcp: cannot start");
        return 1;
    };
    rt.block_on(run(dir, tokio::io::stdin(), Box::new(tokio::io::stdout())));
    0
}

impl Bridge {
    fn new(dir: PathBuf, out: Out) -> Arc<Self> {
        Arc::new(Self {
            dir,
            http: reqwest::Client::builder().no_proxy().build().expect("a client"),
            session: Mutex::new(None),
            hello: Mutex::new(None),
            out: Mutex::new(out),
        })
    }
}

async fn run(dir: PathBuf, input: impl tokio::io::AsyncRead + Unpin, out: Out) {
    let bridge = Bridge::new(dir, out);
    let mut lines = BufReader::new(input).lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // Each message on its own task, so a long command does not hold up a ping.
        let bridge = bridge.clone();
        tasks.spawn(async move {
            if let Some(reply) = bridge.relay(&line).await {
                bridge.print(&reply).await;
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

impl Bridge {
    async fn print(&self, reply: &str) {
        let mut out = self.out.lock().await;
        let _ = out.write_all(reply.as_bytes()).await;
        let _ = out.write_all(b"\n").await;
        let _ = out.flush().await;
    }

    /// Sends one message and returns the line to print, if any.
    async fn relay(&self, line: &str) -> Option<String> {
        let msg: Value = serde_json::from_str(line).ok()?;
        let is_init = msg["method"] == "initialize";
        if is_init {
            *self.hello.lock().await = Some(line.to_string());
        }
        let mut result = self.post(line, is_init).await;
        // The app forgot our session (it restarted): introduce ourselves again, then repeat the message.
        if matches!(result, Ok((404, _, _))) && !is_init {
            if let Some(hello) = self.hello.lock().await.clone() {
                if matches!(self.post(&hello, true).await, Ok((200, _, _))) {
                    let _ = self.post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, false).await;
                    result = self.post(line, false).await;
                }
            }
        }
        match result {
            Ok((_, body, _)) if body.trim().is_empty() => None,
            Ok((_, body, _)) => Some(body.replace(['\n', '\r'], " ")),
            Err(why) => {
                // A request needs an answer; a notification does not.
                let id = msg.get("id")?.clone();
                Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": why } }).to_string())
            }
        }
    }

    /// Posts `line`; returns the status, the body and the session id the app issued (for `initialize`).
    async fn post(&self, line: &str, is_init: bool) -> Result<(u16, String, Option<String>), String> {
        let (url, token) = read_endpoint(&self.dir).ok_or_else(|| NOT_RUNNING.to_string())?;
        let mut req = self.http.post(url).bearer_auth(token).header("content-type", "application/json").header("accept", "application/json").body(line.to_string());
        if !is_init {
            if let Some(id) = self.session.lock().await.clone() {
                req = req.header("mcp-session-id", id);
            }
        }
        // Calls may legitimately take minutes (a command, a question to the person); the app sets the limits.
        let resp = req.send().await.map_err(|_| NOT_RUNNING.to_string())?;
        let status = resp.status().as_u16();
        let issued = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_string);
        if is_init {
            if let Some(id) = &issued {
                *self.session.lock().await = Some(id.clone());
            }
        }
        let body = resp.text().await.map_err(|e| format!("Portique's reply was cut off: {e}"))?;
        if status == 401 || status == 403 {
            return Err("Portique refused the request. Restart the agent program so it reads Portique's current address.".to_string());
        }
        Ok((status, body, issued))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::agent::{server, testing::FakeHost, Agents};
    #[cfg(unix)]
    use crate::{session::Sessions, window::AgentMode};

    /// Runs the bridge on in-memory pipes against a real server and returns what it printed for each line.
    async fn through_the_bridge(dir: PathBuf, lines: &[&str]) -> Vec<Value> {
        let bridge = Bridge::new(dir, Box::new(tokio::io::sink()));
        let mut out = Vec::new();
        for l in lines {
            if let Some(r) = bridge.relay(l).await {
                out.push(serde_json::from_str(&r).unwrap());
            }
        }
        out
    }

    #[cfg(unix)]
    async fn serve() -> (server::Running, tempfile::TempDir) {
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
        let running = server::start(Agents::new(host, Sessions::default())).await.unwrap();
        (running, dir)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lines_in_replies_out_and_notifications_silent() {
        let (_running, dir) = serve().await;
        let replies = through_the_bridge(
            dir.path().to_path_buf(),
            &[
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"bridge-test"}}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_profiles","arguments":{}}}"#,
            ],
        )
        .await;
        assert_eq!(replies.len(), 3, "the notification gets no reply");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "portique");
        assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 9);
        assert_eq!(replies[2]["result"]["structuredContent"]["profiles"][0]["id"], "local:sh");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_loop_reads_lines_and_writes_one_line_per_reply() {
        use tokio::io::AsyncReadExt;
        let (_running, dir) = serve().await;
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"loop-test"}}}"#, "\n",
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_profiles","arguments":{}}}"#, "\n",
        );
        let (writer, mut reader) = tokio::io::duplex(64 * 1024);
        run(dir.path().to_path_buf(), input.as_bytes(), Box::new(writer)).await;
        let mut printed = String::new();
        reader.read_to_string(&mut printed).await.unwrap();
        let lines: Vec<Value> = printed.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2, "{printed}");
        let by_id = |n: i64| lines.iter().find(|l| l["id"] == n).unwrap();
        assert_eq!(by_id(1)["result"]["serverInfo"]["name"], "portique");
        assert_eq!(by_id(2)["result"]["structuredContent"]["profiles"][0]["id"], "local:sh");
        assert!(printed.ends_with('\n') && !printed.contains("\n\n"));
    }

    #[tokio::test]
    async fn an_app_that_is_not_running_is_explained_to_requests_only() {
        let dir = tempfile::tempdir().unwrap();
        let replies = through_the_bridge(
            dir.path().to_path_buf(),
            &[r#"{"jsonrpc":"2.0","id":5,"method":"tools/list"}"#, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#],
        )
        .await;
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], 5);
        assert!(replies[0]["error"]["message"].as_str().unwrap().contains("not running"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_restarted_app_is_found_again_and_the_session_is_remade() {
        let (first, dir) = serve().await;
        let bridge = Bridge::new(dir.path().to_path_buf(), Box::new(tokio::io::sink()));
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"bridge-test"}}}"#;
        assert!(bridge.relay(init).await.is_some());
        first.stop();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let gone = bridge.relay(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#).await.unwrap();
        assert!(gone.contains("not running"));

        // A new run of the app (new port, new token, no memory of our session).
        let host = Arc::new(FakeHost::default());
        *host.data.lock().unwrap() = Some(dir.path().to_path_buf());
        host.settings.lock().unwrap().agent.enabled = true;
        let _second = server::start(Agents::new(host, Sessions::default())).await.unwrap();
        let back = bridge.relay(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await.unwrap();
        assert!(back.contains(r#""result":{}"#), "{back}");
    }
}
