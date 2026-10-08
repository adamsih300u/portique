//! The API tab's HTTP client: sends one request and reports what came back.
//!
//! Runs here rather than in the webview so there is no CORS, self-signed certificates can be allowed,
//! and `{{secret}}` variables can be filled in from the vault without the page ever reading them.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::task::AbortHandle;

use crate::vault;

/// Responses larger than this are cut off (and flagged) rather than held in memory and sent to the UI.
const MAX_BODY: usize = 20 * 1024 * 1024;

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Body {
    #[default]
    None,
    Json { text: String },
    Text { text: String },
    Form { pairs: Vec<(String, String)> },
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Auth {
    #[default]
    None,
    Bearer { token: String },
    Basic { user: String, pass: String },
    Header { name: String, value: String },
    /// OAuth 2.0 client credentials: a token is fetched (and cached until it expires) before the request.
    #[serde(rename = "oauth2", rename_all = "camelCase")]
    OAuth2 { token_url: String, client_id: String, client_secret: String, scope: String },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Lets the UI cancel this request while it is in flight.
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Body,
    #[serde(default)]
    pub auth: Auth,
    /// Accept invalid or self-signed certificates.
    pub insecure: bool,
    pub follow_redirects: bool,
    pub timeout_secs: u64,
    /// The environment whose secret variables to read from the vault ("" for none).
    pub env_id: String,
    /// The environment's plain variables.
    pub vars: HashMap<String, String>,
    /// Send through the SOCKS5 proxy on this local port (an SSH session, see `ssh::run_proxy`).
    #[serde(default)]
    pub proxy_port: Option<u16>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: u16,
    pub reason: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    /// The body as text; empty when `binary`.
    pub body: String,
    pub binary: bool,
    pub size: u64,
    pub truncated: bool,
    /// Milliseconds until the headers arrived, and until the whole body had.
    pub head_millis: u64,
    pub millis: u64,
    /// Where the response came from after any redirects.
    pub url: String,
}

pub fn secret_account(env_id: &str, name: &str) -> String {
    format!("apienv:{env_id}:{name}")
}

// ---------------------------------------------------------------- {{variables}}

struct Expander<'a> {
    req: &'a Request,
    missing: BTreeSet<String>,
}

impl Expander<'_> {
    fn lookup(&mut self, name: &str) -> Result<Option<String>> {
        match name {
            "$uuid" => return Ok(Some(uuid::Uuid::new_v4().to_string())),
            "$timestamp" => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
                return Ok(Some(now.as_secs().to_string()));
            }
            _ => {}
        }
        if let Some(v) = self.req.vars.get(name) {
            return Ok(Some(v.clone()));
        }
        if self.req.env_id.is_empty() {
            return Ok(None);
        }
        vault::global().get(&secret_account(&self.req.env_id, name))
    }

    /// Replaces every `{{name}}`. Names that aren't defined are collected in `missing` and left in place.
    fn expand(&mut self, s: &str) -> Result<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(start) = rest.find("{{") {
            let Some(len) = rest[start + 2..].find("}}") else { break };
            let name = rest[start + 2..start + 2 + len].trim();
            out.push_str(&rest[..start]);
            match self.lookup(name)? {
                Some(v) => out.push_str(&v),
                None => {
                    self.missing.insert(name.to_string());
                    out.push_str(&rest[start..start + 4 + len]);
                }
            }
            rest = &rest[start + 4 + len..];
        }
        out.push_str(rest);
        Ok(out)
    }
}

/// `localhost` and bare addresses default to http, everything else to https.
fn with_scheme(url: &str) -> String {
    let url = url.trim();
    if url.contains("://") {
        return url.to_string();
    }
    let host = url.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    let local = name == "localhost" || name.ends_with(".localhost") || name.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[');
    format!("{}://{url}", if local { "http" } else { "https" })
}

/// A request with every variable filled in, ready to send.
#[derive(Debug)]
struct Prepared {
    method: reqwest::Method,
    url: String,
    headers: reqwest::header::HeaderMap,
    body: Body,
    oauth: Option<OAuth>,
}

#[derive(Debug, Clone)]
struct OAuth {
    token_url: String,
    client_id: String,
    client_secret: String,
    scope: String,
}

fn prepare(req: &Request) -> Result<Prepared> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    let mut x = Expander { req, missing: BTreeSet::new() };
    let url = with_scheme(&x.expand(&req.url)?);
    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        let (k, v) = (x.expand(k)?, x.expand(v)?);
        let name = HeaderName::from_bytes(k.trim().as_bytes()).map_err(|_| anyhow!("\"{k}\" is not a valid header name"))?;
        let value = HeaderValue::from_str(v.trim()).map_err(|_| anyhow!("the value of header \"{k}\" has characters that aren't allowed"))?;
        headers.append(name, value);
    }
    // Auth never overrides a header the user wrote by hand.
    let set = |headers: &mut HeaderMap, name: HeaderName, value: String| -> Result<()> {
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_str(&value).map_err(|_| anyhow!("the authorization value has characters that aren't allowed"))?);
        }
        Ok(())
    };
    match &req.auth {
        Auth::None => {}
        Auth::Bearer { token } => {
            let t = x.expand(token)?;
            if !t.trim().is_empty() {
                set(&mut headers, AUTHORIZATION, format!("Bearer {}", t.trim()))?;
            }
        }
        Auth::Basic { user, pass } => {
            let raw = format!("{}:{}", x.expand(user)?, x.expand(pass)?);
            set(&mut headers, AUTHORIZATION, format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw)))?;
        }
        Auth::OAuth2 { .. } => {} // handled in `execute`, once the token has been fetched
        Auth::Header { name, value } => {
            let (n, v) = (x.expand(name)?, x.expand(value)?);
            if !n.trim().is_empty() {
                let name = HeaderName::from_bytes(n.trim().as_bytes()).map_err(|_| anyhow!("\"{n}\" is not a valid header name"))?;
                set(&mut headers, name, v)?;
            }
        }
    }
    let mut oauth = None;
    if let Auth::OAuth2 { token_url, client_id, client_secret, scope } = &req.auth {
        oauth = Some(OAuth {
            token_url: x.expand(token_url)?.trim().to_string(),
            client_id: x.expand(client_id)?,
            client_secret: x.expand(client_secret)?,
            scope: x.expand(scope)?.trim().to_string(),
        });
    }
    let body = match &req.body {
        Body::None => Body::None,
        Body::Json { text } => {
            if !headers.contains_key(CONTENT_TYPE) {
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            }
            Body::Json { text: x.expand(text)? }
        }
        Body::Text { text } => Body::Text { text: x.expand(text)? },
        Body::Form { pairs } => Body::Form {
            pairs: pairs.iter().map(|(k, v)| Ok((x.expand(k)?, x.expand(v)?))).collect::<Result<_>>()?,
        },
    };
    if !x.missing.is_empty() {
        let list = x.missing.iter().map(|n| format!("{{{{{n}}}}}")).collect::<Vec<_>>().join(", ");
        let where_ = if req.env_id.is_empty() { "no environment is selected" } else { "the selected environment doesn't define it" };
        bail!("{list} {} not defined ({where_}).", if x.missing.len() == 1 { "is" } else { "are" });
    }
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes()).map_err(|_| anyhow!("\"{}\" is not a valid method", req.method))?;
    if url.trim_start_matches(|c| c != ':').len() <= 3 {
        bail!("Enter a URL to send the request to.");
    }
    if let Some(o) = &mut oauth {
        if o.token_url.is_empty() {
            bail!("Enter the token URL to sign in with OAuth 2.0.");
        }
        o.token_url = with_scheme(&o.token_url);
    }
    Ok(Prepared { method, url, headers, body, oauth })
}

// ---------------------------------------------------------------- sending

static RUNNING: Mutex<Option<HashMap<String, AbortHandle>>> = Mutex::new(None);

fn running<R>(f: impl FnOnce(&mut HashMap<String, AbortHandle>) -> R) -> R {
    f(RUNNING.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new))
}

pub fn cancel(id: &str) {
    if let Some(h) = running(|m| m.remove(id)) {
        h.abort();
    }
}

pub async fn send(req: Request) -> Result<Response> {
    let prepared = prepare(&req)?; // before any await: the vault guard must not be held across one
    let id = req.id.clone();
    let task = tokio::spawn(execute(prepared, req.insecure, req.follow_redirects, req.timeout_secs, req.proxy_port));
    running(|m| m.insert(id.clone(), task.abort_handle()));
    let out = task.await;
    running(|m| m.remove(&id));
    match out {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err(anyhow!("Cancelled")),
        Err(e) => Err(anyhow!("the request failed unexpectedly: {e}")),
    }
}

async fn execute(p: Prepared, insecure: bool, follow: bool, timeout_secs: u64, proxy: Option<u16>) -> Result<Response> {
    use reqwest::header::{HeaderValue, AUTHORIZATION};
    let mut cb = reqwest::Client::builder()
        .user_agent(concat!("Portique/", env!("CARGO_PKG_VERSION")))
        .redirect(if follow { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() })
        .danger_accept_invalid_certs(insecure)
        .timeout(Duration::from_secs(timeout_secs.clamp(1, 3600)));
    if let Some(port) = proxy {
        // socks5h: names are resolved by the SSH server, so hosts only it can see work.
        cb = cb.proxy(reqwest::Proxy::all(format!("socks5h://127.0.0.1:{port}")).context("bad proxy address")?);
    }
    let client = cb.build().context("could not set up the HTTP client")?;
    let via = proxy.is_some();
    let mut headers = p.headers;
    if let Some(o) = &p.oauth {
        if !headers.contains_key(AUTHORIZATION) {
            let (kind, token) = oauth_token(&client, o, insecure, via).await?;
            let value = HeaderValue::from_str(&format!("{kind} {token}")).context("the token has characters that aren't allowed in a header")?;
            headers.insert(AUTHORIZATION, value);
        }
    }
    let mut rb = client.request(p.method, &p.url).headers(headers);
    rb = match p.body {
        Body::None => rb,
        Body::Json { text } | Body::Text { text } => rb.body(text),
        Body::Form { pairs } => rb.form(&pairs),
    };
    let started = Instant::now();
    let mut resp = rb.send().await.map_err(|e| explain(e, insecure, via))?;
    let head_millis = started.elapsed().as_millis() as u64;

    let status = resp.status();
    if status.as_u16() == 401 {
        if let Some(o) = &p.oauth {
            forget_token(o); // the server no longer accepts it: sign in afresh next time
        }
    }
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let version = format!("{:?}", resp.version());
    let url = resp.url().to_string();

    let mut bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp.chunk().await.map_err(|e| explain(e, insecure, via))? {
        let room = MAX_BODY - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if chunk.len() > room {
            truncated = true;
            break; // don't download an unbounded stream
        }
    }
    let size = bytes.len() as u64;
    let (body, binary) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let raw = e.into_bytes();
            // A multi-byte character cut off at the limit isn't binary data.
            if truncated && raw.len() - valid < 4 {
                (String::from_utf8_lossy(&raw[..valid]).into_owned(), false)
            } else {
                (String::new(), true)
            }
        }
    };
    Ok(Response {
        status: status.as_u16(),
        reason: status.canonical_reason().unwrap_or("").to_string(),
        version,
        headers,
        body,
        binary,
        size,
        truncated,
        head_millis,
        millis: started.elapsed().as_millis() as u64,
        url,
    })
}

// ---------------------------------------------------------------- OAuth 2.0

/// Cached access tokens: key -> (token type, token, good until). Memory only; never written to disk.
static TOKENS: Mutex<Option<HashMap<String, (String, String, Instant)>>> = Mutex::new(None);

fn token_key(o: &OAuth) -> String {
    format!("{}\n{}\n{}\n{}", o.token_url, o.client_id, o.client_secret, o.scope)
}

fn forget_token(o: &OAuth) {
    if let Some(m) = TOKENS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        m.remove(&token_key(o));
    }
}

/// Signs in with the client-credentials grant, reusing a still-valid token from an earlier request.
async fn oauth_token(client: &reqwest::Client, o: &OAuth, insecure: bool, via_ssh: bool) -> Result<(String, String)> {
    let key = token_key(o);
    {
        let cache = TOKENS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((kind, token, until)) = cache.as_ref().and_then(|m| m.get(&key)) {
            if *until > Instant::now() + Duration::from_secs(30) {
                return Ok((kind.clone(), token.clone()));
            }
        }
    }
    let mut form = vec![("grant_type", "client_credentials")];
    if !o.scope.is_empty() {
        form.push(("scope", o.scope.as_str()));
    }
    let resp = client
        .post(&o.token_url)
        .basic_auth(&o.client_id, Some(&o.client_secret))
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| explain(e, insecure, via_ssh))
        .context("OAuth sign-in failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let why = json["error_description"].as_str().or(json["error"].as_str()).map(str::to_string).unwrap_or_else(|| text.chars().take(200).collect());
        bail!("OAuth sign-in failed: the server answered {status}{}", if why.is_empty() { String::new() } else { format!(" ({why})") });
    }
    let token = json["access_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| anyhow!("OAuth sign-in failed: the answer has no access_token"))?;
    let kind = match json["token_type"].as_str() {
        Some(k) if !k.eq_ignore_ascii_case("bearer") && !k.is_empty() => k.to_string(),
        _ => "Bearer".to_string(),
    };
    let ttl = json["expires_in"].as_u64().unwrap_or(300).clamp(1, 24 * 3600);
    TOKENS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(key, (kind.clone(), token.to_string(), Instant::now() + Duration::from_secs(ttl)));
    Ok((kind, token.to_string()))
}

/// Turns a transport error into something a person can act on.
fn explain(e: reqwest::Error, insecure: bool, via_ssh: bool) -> anyhow::Error {
    let chain = {
        let mut parts = vec![e.to_string()];
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            parts.push(s.to_string());
            src = s.source();
        }
        parts.join(": ")
    };
    let lower = chain.to_lowercase();
    if e.is_timeout() {
        anyhow!("The request timed out. The server didn't answer in time.")
    } else if !insecure && (lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("invalid peer")) {
        anyhow!("{chain}\n\nThe server's certificate isn't trusted. For a test server with a self-signed certificate, turn on “Allow self-signed certificates” under Options.")
    } else if e.is_connect() && via_ssh {
        anyhow!("Could not connect through the SSH host: {chain}\n\nThe address may be unreachable from the server, or its name may not resolve there.")
    } else if e.is_connect() {
        anyhow!("Could not connect: {chain}")
    } else {
        anyhow!("{chain}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str) -> Request {
        Request {
            id: "t".into(),
            method: "get".into(),
            url: url.into(),
            headers: vec![],
            body: Body::None,
            auth: Auth::None,
            insecure: false,
            follow_redirects: true,
            timeout_secs: 5,
            env_id: String::new(),
            vars: HashMap::from([("host".to_string(), "example.com".to_string()), ("id".to_string(), "42".to_string())]),
            proxy_port: None,
        }
    }

    #[test]
    fn expands_variables_and_reports_missing_ones() {
        let r = req("{{host}}/users/{{ id }}?x={{nope}}&y={{ other }}");
        let err = prepare(&r).unwrap_err().to_string();
        assert!(err.contains("{{nope}}") && err.contains("{{other}}") && err.contains("are not defined"), "{err}");
        let p = prepare(&req("{{host}}/users/{{ id }}")).unwrap();
        assert_eq!(p.url, "https://example.com/users/42");
    }

    #[test]
    fn schemes_default_sensibly() {
        assert_eq!(with_scheme("localhost:3000/x"), "http://localhost:3000/x");
        assert_eq!(with_scheme("127.0.0.1:8080"), "http://127.0.0.1:8080");
        assert_eq!(with_scheme("api.example.com/v1"), "https://api.example.com/v1");
        assert_eq!(with_scheme("http://a.b"), "http://a.b");
    }

    #[test]
    fn auth_does_not_override_explicit_headers() {
        let mut r = req("example.com");
        r.headers = vec![("Authorization".into(), "Custom abc".into())];
        r.auth = Auth::Bearer { token: "t".into() };
        let p = prepare(&r).unwrap();
        assert_eq!(p.headers.get("authorization").unwrap(), "Custom abc");
        r.headers.clear();
        r.auth = Auth::Basic { user: "a".into(), pass: "b".into() };
        assert_eq!(prepare(&r).unwrap().headers.get("authorization").unwrap(), "Basic YTpi");
    }

    #[test]
    fn rejects_empty_url_and_bad_header() {
        assert!(prepare(&req("  ")).is_err());
        let mut r = req("example.com");
        r.headers = vec![("bad name".into(), "x".into())];
        assert!(prepare(&r).unwrap_err().to_string().contains("not a valid header name"));
    }

    /// Talks to a throwaway local server: status, headers, JSON body, redirect and cancellation.
    #[tokio::test]
    async fn round_trip_against_local_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = s.read(&mut buf).await.unwrap();
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let reply = if text.starts_with("GET /slow") {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        String::new()
                    } else if text.starts_with("GET /old") {
                        "HTTP/1.1 302 Found\r\nLocation: /new\r\nContent-Length: 0\r\n\r\n".to_string()
                    } else {
                        let body = format!("{{\"echo\":{:?}}}", text.lines().next().unwrap_or(""));
                        format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-Seen: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            text.to_lowercase().contains("x-test: yes"), body.len())
                    };
                    let _ = s.write_all(reply.as_bytes()).await;
                });
            }
        });
        let mut r = req(&format!("localhost:{port}/old"));
        r.headers = vec![("X-Test".into(), "yes".into())];
        let res = send(r).await.unwrap();
        assert_eq!((res.status, res.reason.as_str()), (201, "Created"));
        assert!(res.url.ends_with("/new"), "{}", res.url);
        assert!(res.body.contains("GET /new"), "{}", res.body);
        assert!(res.headers.iter().any(|(k, v)| k == "x-seen" && v == "true"));

        let mut r = req(&format!("localhost:{port}/old"));
        r.follow_redirects = false;
        assert_eq!(send(r).await.unwrap().status, 302);

        let mut slow = req(&format!("localhost:{port}/slow"));
        slow.id = "slow".into();
        let task = tokio::spawn(send(slow));
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel("slow");
        assert_eq!(task.await.unwrap().unwrap_err().to_string(), "Cancelled");

        let refused = send(req("127.0.0.1:1")).await.unwrap_err().to_string();
        assert!(refused.starts_with("Could not connect"), "{refused}");
    }

    /// A throwaway HTTP server: `handler(request_text) -> response_text`. Returns its port.
    async fn serve(handler: impl Fn(String) -> String + Send + Sync + 'static) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = std::sync::Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    let reply = handler(String::from_utf8_lossy(&buf[..n]).to_string());
                    let _ = s.write_all(reply.as_bytes()).await;
                });
            }
        });
        port
    }

    fn ok_json(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[tokio::test]
    async fn oauth_signs_in_once_and_signs_in_again_after_a_401() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let logins = std::sync::Arc::new(AtomicUsize::new(0));
        let l = logins.clone();
        let port = serve(move |req| {
            if req.starts_with("POST /token") {
                let n = l.fetch_add(1, Ordering::SeqCst) + 1;
                assert!(req.contains("grant_type=client_credentials") && req.contains("scope=read"), "{req}");
                assert!(req.to_lowercase().contains("authorization: basic "), "{req}"); // client id + secret
                ok_json(&format!(r#"{{"access_token":"tok{n}","token_type":"bearer","expires_in":3600}}"#))
            } else if req.to_lowercase().contains("authorization: bearer tok1") && req.starts_with("GET /fine") {
                ok_json(r#"{"ok":true}"#)
            } else {
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
            }
        })
        .await;
        let mut r = req(&format!("localhost:{port}/fine"));
        r.auth = Auth::OAuth2 { token_url: format!("localhost:{port}/token"), client_id: "cid".into(), client_secret: "sec-oauth-test".into(), scope: "read".into() };
        assert_eq!(send(r).await.unwrap().status, 200);
        let mut r = req(&format!("localhost:{port}/fine"));
        r.auth = Auth::OAuth2 { token_url: format!("localhost:{port}/token"), client_id: "cid".into(), client_secret: "sec-oauth-test".into(), scope: "read".into() };
        assert_eq!(send(r).await.unwrap().status, 200);
        assert_eq!(logins.load(Ordering::SeqCst), 1, "the second request should reuse the token");

        // The API starts refusing the token: that request fails, and the next one signs in again.
        let mut r = req(&format!("localhost:{port}/revoked"));
        r.auth = Auth::OAuth2 { token_url: format!("localhost:{port}/token"), client_id: "cid".into(), client_secret: "sec-oauth-test".into(), scope: "read".into() };
        assert_eq!(send(r).await.unwrap().status, 401);
        let mut r = req(&format!("localhost:{port}/fine"));
        r.auth = Auth::OAuth2 { token_url: format!("localhost:{port}/token"), client_id: "cid".into(), client_secret: "sec-oauth-test".into(), scope: "read".into() };
        let _ = send(r).await; // tok2 isn't accepted by /fine; what matters is that a new sign-in happened
        assert_eq!(logins.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn oauth_errors_are_explained() {
        let port = serve(|_| "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 62\r\nConnection: close\r\n\r\n{\"error\":\"invalid_client\",\"error_description\":\"Unknown client\"} ".to_string()).await;
        let mut r = req(&format!("localhost:{port}/x"));
        r.auth = Auth::OAuth2 { token_url: format!("localhost:{port}/token"), client_id: "a".into(), client_secret: "b-err".into(), scope: String::new() };
        let e = send(r).await.unwrap_err().to_string();
        assert!(e.contains("OAuth sign-in failed") && e.contains("Unknown client"), "{e}");
        let mut r = req("localhost:1/x");
        r.auth = Auth::OAuth2 { token_url: String::new(), client_id: String::new(), client_secret: String::new(), scope: String::new() };
        assert!(prepare(&r).unwrap_err().to_string().contains("token URL"));
    }

    /// A minimal SOCKS5 server that records what it was asked to connect to, then relays to `target`.
    async fn socks_server(target: u16) -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
        use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = asked.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut head = [0u8; 2];
                    s.read_exact(&mut head).await.unwrap();
                    let mut methods = vec![0u8; head[1] as usize];
                    s.read_exact(&mut methods).await.unwrap();
                    s.write_all(&[5, 0]).await.unwrap();
                    let mut req = [0u8; 4];
                    s.read_exact(&mut req).await.unwrap();
                    let host = match req[3] {
                        3 => {
                            let mut len = [0u8; 1];
                            s.read_exact(&mut len).await.unwrap();
                            let mut name = vec![0u8; len[0] as usize];
                            s.read_exact(&mut name).await.unwrap();
                            String::from_utf8(name).unwrap()
                        }
                        _ => {
                            let mut a = [0u8; 4];
                            s.read_exact(&mut a).await.unwrap();
                            std::net::Ipv4Addr::from(a).to_string()
                        }
                    };
                    let mut p = [0u8; 2];
                    s.read_exact(&mut p).await.unwrap();
                    log.lock().unwrap().push(format!("{host}:{}", u16::from_be_bytes(p)));
                    s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                    let mut up = tokio::net::TcpStream::connect(("127.0.0.1", target)).await.unwrap();
                    let _ = copy_bidirectional(&mut s, &mut up).await;
                });
            }
        });
        (port, asked)
    }

    #[tokio::test]
    async fn requests_can_go_through_a_socks_proxy_with_the_name_resolved_there() {
        let target = serve(|req| ok_json(&format!("{{\"saw\":{:?}}}", req.lines().find(|l| l.to_lowercase().starts_with("host:")).unwrap_or("")))).await;
        let (proxy, asked) = socks_server(target).await;
        let mut r = req("http://only-the-server-knows.internal:8080/health");
        r.proxy_port = Some(proxy);
        let res = send(r).await.unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.contains("only-the-server-knows.internal:8080"), "{}", res.body);
        // socks5h: the proxy got the name, not an address our machine resolved.
        assert_eq!(asked.lock().unwrap().as_slice(), ["only-the-server-knows.internal:8080"]);

        let mut r = req("http://nothing.internal/x");
        r.proxy_port = Some(1); // nothing listens there
        let e = send(r).await.unwrap_err().to_string();
        assert!(e.starts_with("Could not connect through the SSH host"), "{e}");
    }
}
