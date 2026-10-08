//! SFTP file browser: a session type that keeps one SFTP subsystem channel open and serves
//! listing, file-management and transfer requests from the frontend. Local-disk helpers live here too.

use crate::session::{ConnectionLost, Ctl, Emitter};
use anyhow::{anyhow, bail, Context, Result};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc::UnboundedReceiver, Semaphore},
};

const CHUNK: usize = 128 * 1024;
/// Transfers running at once per connection; the rest wait their turn.
const SLOTS: usize = 3;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

fn e<T: std::fmt::Display>(x: T) -> anyhow::Error {
    anyhow!("{x}")
}

struct Conn {
    sftp: SftpSession,
    em: Emitter,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    slots: Semaphore,
}

static CONNS: LazyLock<Mutex<HashMap<String, Arc<Conn>>>> = LazyLock::new(Default::default);

fn conn(id: &str) -> Result<Arc<Conn>> {
    CONNS.lock().unwrap().get(id).cloned().context("the SFTP connection is closed")
}

/// Runs for the life of the connection: registers it for the commands below, then waits to be closed
/// (or for the transport to die).
pub async fn serve(
    sid: &str,
    sftp: SftpSession,
    em: Emitter,
    mut rx: UnboundedReceiver<Ctl>,
    closed: impl Fn() -> bool,
) -> Result<()> {
    let c = Arc::new(Conn { sftp, em: em.clone(), cancels: Default::default(), slots: Semaphore::new(SLOTS) });
    CONNS.lock().unwrap().insert(sid.to_string(), c.clone());
    em.status("connected", "SFTP ready");
    let res = loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Ctl::Close) | None => break Ok(()),
                Some(_) => {}
            },
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if closed() { break Err(ConnectionLost.into()); }
            }
        }
    };
    for flag in c.cancels.lock().unwrap().values() {
        flag.store(true, Ordering::Relaxed);
    }
    CONNS.lock().unwrap().remove(sid);
    let _ = c.sftp.close().await;
    res
}

// ---------------------------------------------------------------- listings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    /// Seconds since the epoch.
    mtime: Option<i64>,
    mode: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
}

fn posix_parent(p: &str) -> Option<String> {
    if p == "/" || p.is_empty() {
        return None;
    }
    let t = p.trim_end_matches('/');
    Some(match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => t[..i].into(),
        None => return None,
    })
}

pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

/// Lists a remote directory; an empty path means the login directory.
pub async fn list(id: &str, path: &str) -> Result<Listing> {
    let c = conn(id)?;
    let path = c.sftp.canonicalize(if path.is_empty() { "." } else { path }).await.map_err(e)?;
    let mut entries = Vec::new();
    for ent in c.sftp.read_dir(path.clone()).await.map_err(e)? {
        let name = ent.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let m = ent.metadata();
        let is_link = m.is_symlink();
        // A link to a directory should browse like one.
        let (is_dir, size) = if is_link {
            match c.sftp.metadata(join_remote(&path, &name)).await {
                Ok(t) => (t.is_dir(), t.len()),
                Err(_) => (false, m.len()),
            }
        } else {
            (m.is_dir(), m.len())
        };
        entries.push(Entry { name, is_dir, is_link, size, mtime: m.mtime.map(i64::from), mode: m.permissions });
    }
    Ok(Listing { parent: posix_parent(&path), path, entries })
}

pub async fn mkdir(id: &str, path: &str) -> Result<()> {
    conn(id)?.sftp.create_dir(path).await.map_err(e)
}

pub async fn rename(id: &str, from: &str, to: &str) -> Result<()> {
    conn(id)?.sftp.rename(from, to).await.map_err(e)
}

/// Deletes a file, or a directory with everything in it (symlinks are removed, never followed).
pub async fn remove(id: &str, path: &str) -> Result<()> {
    let c = conn(id)?;
    remove_tree(&c.sftp, path.to_string()).await
}

fn remove_tree<'a>(sftp: &'a SftpSession, path: String) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let m = sftp.symlink_metadata(path.clone()).await.map_err(e)?;
        if !m.is_dir() {
            return sftp.remove_file(path).await.map_err(e);
        }
        for ent in sftp.read_dir(path.clone()).await.map_err(e)? {
            let name = ent.file_name();
            if name != "." && name != ".." {
                remove_tree(sftp, join_remote(&path, &name)).await?;
            }
        }
        sftp.remove_dir(path).await.map_err(e)
    })
}

// ---------------------------------------------------------------- transfers

/// One top-level thing to copy. For uploads `src` is local and `dst` remote; for downloads the reverse.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    src: String,
    dst: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct Started {
    tid: String,
    name: String,
}

struct Node {
    /// Path below the item's root, "/"-separated; empty for a single file.
    rel: String,
    dir: bool,
    size: u64,
}

#[derive(Debug)]
struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cancelled")
    }
}
impl std::error::Error for Cancelled {}

struct Progress<'a> {
    em: &'a Emitter,
    tid: &'a str,
    done: u64,
    total: u64,
    last: Instant,
    cancel: &'a AtomicBool,
}

impl Progress<'_> {
    fn emit(&mut self, state: &str, message: &str) {
        self.last = Instant::now();
        self.em.status_json("transfer", json!({ "tid": self.tid, "state": state, "done": self.done, "total": self.total, "message": message }));
    }
    fn add(&mut self, n: u64) -> Result<()> {
        self.done += n;
        if self.cancel.load(Ordering::Relaxed) {
            return Err(Cancelled.into());
        }
        if self.last.elapsed() >= PROGRESS_EVERY {
            self.emit("running", "");
        }
        Ok(())
    }
}

fn basename(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn local_join(root: &str, rel: &str) -> PathBuf {
    let mut p = PathBuf::from(root);
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

async fn walk_local(root: &str) -> Result<Vec<Node>> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let mut rd = tokio::fs::read_dir(local_join(root, &rel)).await?;
        while let Some(ent) = rd.next_entry().await? {
            let name = ent.file_name().to_string_lossy().into_owned();
            let m = ent.metadata().await?; // does not follow symlinks
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if m.is_symlink() {
                continue;
            } else if m.is_dir() {
                out.push(Node { rel: r.clone(), dir: true, size: 0 });
                stack.push(r);
            } else if m.is_file() {
                out.push(Node { rel: r, dir: false, size: m.len() });
            }
        }
    }
    Ok(out)
}

async fn walk_remote(sftp: &SftpSession, root: &str) -> Result<Vec<Node>> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { root.to_string() } else { join_remote(root, &rel) };
        for ent in sftp.read_dir(dir).await.map_err(e)? {
            let name = ent.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let m = ent.metadata();
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if m.is_symlink() {
                continue;
            } else if m.is_dir() {
                out.push(Node { rel: r.clone(), dir: true, size: 0 });
                stack.push(r);
            } else {
                out.push(Node { rel: r, dir: false, size: m.len() });
            }
        }
    }
    Ok(out)
}

async fn upload_file(c: &Conn, local: &Path, remote: &str, pr: &mut Progress<'_>) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await.with_context(|| format!("reading {}", local.display()))?;
    let mut dst = c.sftp.create(remote).await.map_err(e).with_context(|| format!("creating {remote}"))?;
    let mut buf = vec![0u8; CHUNK];
    let res: Result<()> = async {
        loop {
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            pr.add(n as u64)?;
        }
        Ok(())
    }
    .await;
    let closed = dst.shutdown().await;
    if let Err(err) = res {
        let _ = c.sftp.remove_file(remote).await; // never leave a half-written file behind
        return Err(err);
    }
    closed?;
    Ok(())
}

async fn download_file(c: &Conn, remote: &str, local: &Path, pr: &mut Progress<'_>) -> Result<()> {
    let mut src = c.sftp.open(remote).await.map_err(e).with_context(|| format!("opening {remote}"))?;
    let mut dst = tokio::fs::File::create(local).await.with_context(|| format!("writing {}", local.display()))?;
    let mut buf = vec![0u8; CHUNK];
    let res: Result<()> = async {
        loop {
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            pr.add(n as u64)?;
        }
        dst.flush().await?;
        Ok(())
    }
    .await;
    let _ = src.shutdown().await;
    drop(dst);
    if let Err(err) = res {
        let _ = tokio::fs::remove_file(local).await;
        return Err(err);
    }
    Ok(())
}

/// Copies one item (a file, or a whole folder). Returns how many files were skipped because they already existed.
async fn run_item(c: &Conn, upload: bool, it: &Item, overwrite: bool, pr: &mut Progress<'_>) -> Result<u32> {
    let nodes = if !it.is_dir {
        let size = if upload { tokio::fs::metadata(&it.src).await?.len() } else { c.sftp.metadata(it.src.clone()).await.map_err(e)?.len() };
        vec![Node { rel: String::new(), dir: false, size }]
    } else if upload {
        walk_local(&it.src).await?
    } else {
        walk_remote(&c.sftp, &it.src).await?
    };
    pr.total = nodes.iter().map(|n| n.size).sum();
    pr.emit("running", "");

    let mut skipped = 0;
    if it.is_dir {
        // The folder itself, then its sub-folders (the walk lists parents before children).
        if upload {
            if !c.sftp.try_exists(it.dst.clone()).await.map_err(e)? {
                c.sftp.create_dir(it.dst.clone()).await.map_err(e)?;
            }
        } else {
            tokio::fs::create_dir_all(&it.dst).await?;
        }
    }
    for n in &nodes {
        if pr.cancel.load(Ordering::Relaxed) {
            return Err(Cancelled.into());
        }
        let (src, dst_remote, dst_local) = if upload {
            (local_join(&it.src, &n.rel).to_string_lossy().into_owned(), join_rel_remote(&it.dst, &n.rel), String::new())
        } else {
            (join_rel_remote(&it.src, &n.rel), String::new(), local_join(&it.dst, &n.rel).to_string_lossy().into_owned())
        };
        if n.dir {
            if upload {
                if !c.sftp.try_exists(dst_remote.clone()).await.map_err(e)? {
                    c.sftp.create_dir(dst_remote).await.map_err(e)?;
                }
            } else {
                tokio::fs::create_dir_all(dst_local).await?;
            }
            continue;
        }
        let exists = if upload { c.sftp.try_exists(dst_remote.clone()).await.map_err(e)? } else { tokio::fs::try_exists(&dst_local).await? };
        if exists && !overwrite {
            skipped += 1;
            pr.add(n.size)?;
            continue;
        }
        if upload {
            upload_file(c, Path::new(&src), &dst_remote, pr).await?;
        } else {
            download_file(c, &src, Path::new(&dst_local), pr).await?;
        }
    }
    Ok(skipped)
}

fn join_rel_remote(root: &str, rel: &str) -> String {
    if rel.is_empty() { root.to_string() } else { join_remote(root, rel) }
}

/// Queues the items and returns immediately; progress arrives as `transfer` status frames.
pub fn start_transfers(id: &str, upload: bool, items: Vec<Item>, overwrite: bool) -> Result<Vec<Started>> {
    let c = conn(id)?;
    if items.len() > 10_000 {
        bail!("too many items at once");
    }
    let mut started = Vec::new();
    for it in items {
        let tid = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        c.cancels.lock().unwrap().insert(tid.clone(), cancel.clone());
        started.push(Started { tid: tid.clone(), name: basename(&it.src) });
        let c = c.clone();
        tauri::async_runtime::spawn(async move {
            let mut pr = Progress { em: &c.em, tid: &tid, done: 0, total: 0, last: Instant::now(), cancel: &cancel };
            pr.emit("queued", "");
            let _slot = c.slots.acquire().await;
            let res = if cancel.load(Ordering::Relaxed) { Err(Cancelled.into()) } else { run_item(&c, upload, &it, overwrite, &mut pr).await };
            match res {
                Ok(0) => pr.emit("done", ""),
                Ok(n) => pr.emit("done", &format!("{n} existing file{} skipped", if n == 1 { "" } else { "s" })),
                Err(err) if err.is::<Cancelled>() => pr.emit("cancelled", ""),
                Err(err) => pr.emit("error", &format!("{err:#}")),
            }
            c.cancels.lock().unwrap().remove(&tid);
        });
    }
    Ok(started)
}

pub fn cancel(id: &str, tid: &str) {
    if let Ok(c) = conn(id) {
        if let Some(flag) = c.cancels.lock().unwrap().get(tid) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

// ---------------------------------------------------------------- local disk

pub fn local_home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

/// Pseudo-path for the list of drives on Windows.
const DRIVES: &str = "@drives";

fn mtime_secs(m: &std::fs::Metadata) -> Option<i64> {
    m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

pub fn local_list(path: &str) -> Result<Listing> {
    if cfg!(windows) && path == DRIVES {
        let entries = (b'A'..=b'Z')
            .map(|c| format!("{}:\\", c as char))
            .filter(|d| Path::new(d).exists())
            .map(|name| Entry { name, is_dir: true, is_link: false, size: 0, mtime: None, mode: None })
            .collect();
        return Ok(Listing { path: DRIVES.into(), parent: None, entries });
    }
    let dir = if path.is_empty() { PathBuf::from(local_home()) } else { PathBuf::from(path) };
    let dir = std::fs::canonicalize(&dir).with_context(|| format!("cannot open {}", dir.display()))?;
    let mut entries = Vec::new();
    for ent in std::fs::read_dir(&dir).with_context(|| format!("cannot read {}", dir.display()))? {
        let Ok(ent) = ent else { continue };
        let name = ent.file_name().to_string_lossy().into_owned();
        let lm = ent.metadata();
        let is_link = lm.as_ref().is_ok_and(|m| m.is_symlink());
        // Follow links for display so a link to a folder opens like a folder.
        let Ok(m) = std::fs::metadata(ent.path()).or(lm) else { continue };
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            Some(m.permissions().mode())
        };
        #[cfg(not(unix))]
        let mode = None;
        entries.push(Entry { name, is_dir: m.is_dir(), is_link, size: m.len(), mtime: mtime_secs(&m), mode });
    }
    let parent = match dir.parent() {
        Some(p) => Some(p.to_string_lossy().into_owned()),
        None if cfg!(windows) => Some(DRIVES.into()),
        None => None,
    };
    let shown = dir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    Ok(Listing { path: shown, parent: parent.map(|p| p.trim_start_matches(r"\\?\").to_string()), entries })
}

pub fn local_mkdir(path: &str) -> Result<()> {
    std::fs::create_dir(path).with_context(|| format!("cannot create {path}"))
}

pub fn local_rename(from: &str, to: &str) -> Result<()> {
    std::fs::rename(from, to).with_context(|| format!("cannot rename {from}"))
}

/// Deletes a file or a folder tree. Symlinks are removed as links, never followed.
pub fn local_delete(path: &str) -> Result<()> {
    let m = std::fs::symlink_metadata(path).with_context(|| format!("cannot find {path}"))?;
    if m.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .with_context(|| format!("cannot delete {path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths() {
        assert_eq!(posix_parent("/"), None);
        assert_eq!(posix_parent("/home"), Some("/".into()));
        assert_eq!(posix_parent("/home/adam/"), Some("/home".into()));
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/a/b", "c"), "/a/b/c");
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename(r"C:\Users\me\"), "me");
    }

    #[test]
    fn local_listing_and_delete() {
        let base = std::env::temp_dir().join(format!("portique-sftp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.txt"), b"hello").unwrap();
        let l = local_list(base.to_str().unwrap()).unwrap();
        assert_eq!(l.entries.len(), 2);
        assert!(l.entries.iter().any(|e| e.name == "sub" && e.is_dir));
        assert!(l.entries.iter().any(|e| e.name == "a.txt" && e.size == 5));
        local_delete(base.to_str().unwrap()).unwrap();
        assert!(!base.exists());
    }

    /// Needs a running sshd with the sftp subsystem: PORTIQUE_TEST_SSH_PORT / _USER / _KEY, and
    /// XDG_CONFIG_HOME pointing at a scratch directory (a vault, key and profile are written there).
    #[tokio::test]
    #[ignore]
    async fn browse_and_transfer_against_local_sshd() {
        use crate::session::{Params, Sessions};
        use crate::store::{AuthMethod, Profile};
        use tauri::ipc::{Channel, InvokeResponseBody};
        let env = |k: &str| std::env::var(k).unwrap();
        crate::vault::global().create("integration-test-pass", crate::vault::Kdf { m: 64, t: 1, p: 1 }).unwrap();
        let key = crate::keys::import("test", &std::fs::read_to_string(env("PORTIQUE_TEST_SSH_KEY")).unwrap(), None).unwrap();
        let p = Profile {
            host: "127.0.0.1".into(), port: env("PORTIQUE_TEST_SSH_PORT").parse().unwrap(), username: env("PORTIQUE_TEST_SSH_USER"),
            auth_method: AuthMethod::Key, key_id: Some(key.id.clone()), ..Default::default()
        };
        let transfers = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let sink = transfers.clone();
        let em = Emitter::new(Channel::new(move |b: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(v) = b {
                if v[0] == 1 {
                    let f: serde_json::Value = serde_json::from_slice(&v[1..]).unwrap();
                    if f["state"] == "transfer" {
                        sink.lock().unwrap().push(serde_json::from_str(f["message"].as_str().unwrap()).unwrap());
                    }
                }
            }
            Ok(())
        }));
        let sessions = Sessions::default();
        let params = Params { sid: "sf".into(), sessions: sessions.clone(), sftp: true, ..Default::default() };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move { crate::ssh::run_sftp(&p, params, em, rx).await });
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sessions.answer_host("sf", true);
            if conn("sf").is_ok() { break; }
        }
        let wait = |tid: String| {
            let transfers = transfers.clone();
            async move {
                for _ in 0..600 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let last = transfers.lock().unwrap().iter().rev().find(|f| f["tid"] == tid.as_str()).cloned();
                    if let Some(f) = last {
                        if ["done", "error", "cancelled"].contains(&f["state"].as_str().unwrap()) { return f; }
                    }
                }
                panic!("transfer never finished");
            }
        };

        let home = list("sf", "").await.unwrap();
        assert!(home.path.starts_with('/'));
        let work = join_remote(&home.path, &format!("portique-test-{}", uuid::Uuid::new_v4()));
        mkdir("sf", &work).await.unwrap();

        // A local tree: small files, a multi-chunk file, nested and empty folders.
        let local = std::env::temp_dir().join(format!("portique-local-{}", uuid::Uuid::new_v4()));
        let tree = local.join("tree");
        std::fs::create_dir_all(tree.join("sub/deep")).unwrap();
        std::fs::create_dir_all(tree.join("empty")).unwrap();
        std::fs::write(tree.join("a.txt"), b"alpha").unwrap();
        std::fs::write(tree.join("sub/b.txt"), b"bravo").unwrap();
        std::fs::write(tree.join("sub/deep/c.txt"), b"charlie").unwrap();
        let big: Vec<u8> = (0..3 * CHUNK + 17).map(|i| (i * 31 % 251) as u8).collect();
        std::fs::write(tree.join("big.bin"), &big).unwrap();

        // Upload the folder, list it remotely.
        let remote_tree = join_remote(&work, "tree");
        let st = start_transfers("sf", true, vec![Item { src: tree.to_string_lossy().into(), dst: remote_tree.clone(), is_dir: true }], false).unwrap();
        let f = wait(st[0].tid.clone()).await;
        assert_eq!(f["state"], "done", "{f}");
        assert_eq!(f["total"], f["done"]);
        let l = list("sf", &remote_tree).await.unwrap();
        let mut names: Vec<_> = l.entries.iter().map(|e| (e.name.clone(), e.is_dir)).collect();
        names.sort();
        assert_eq!(names, vec![("a.txt".into(), false), ("big.bin".into(), false), ("empty".into(), true), ("sub".into(), true)]);
        assert_eq!(l.entries.iter().find(|e| e.name == "big.bin").unwrap().size, big.len() as u64);

        // Download it again somewhere else and compare byte for byte.
        let down = local.join("down");
        std::fs::create_dir_all(&down).unwrap();
        let st = start_transfers("sf", false, vec![Item { src: remote_tree.clone(), dst: down.join("tree").to_string_lossy().into(), is_dir: true }], false).unwrap();
        assert_eq!(wait(st[0].tid.clone()).await["state"], "done");
        assert_eq!(std::fs::read(down.join("tree/big.bin")).unwrap(), big);
        assert_eq!(std::fs::read(down.join("tree/sub/deep/c.txt")).unwrap(), b"charlie");
        assert!(down.join("tree/empty").is_dir());

        // Existing files are skipped unless overwrite is on.
        std::fs::write(tree.join("a.txt"), b"changed").unwrap();
        let st = start_transfers("sf", true, vec![Item { src: tree.to_string_lossy().into(), dst: remote_tree.clone(), is_dir: true }], false).unwrap();
        let f = wait(st[0].tid.clone()).await;
        assert!(f["message"].as_str().unwrap().contains("skipped"), "{f}");
        let st = start_transfers("sf", true, vec![Item { src: tree.join("a.txt").to_string_lossy().into(), dst: join_remote(&remote_tree, "a.txt"), is_dir: false }], true).unwrap();
        assert_eq!(wait(st[0].tid.clone()).await["state"], "done");
        let st = start_transfers("sf", false, vec![Item { src: join_remote(&remote_tree, "a.txt"), dst: down.join("a.txt").to_string_lossy().into(), is_dir: false }], false).unwrap();
        assert_eq!(wait(st[0].tid.clone()).await["state"], "done");
        assert_eq!(std::fs::read(down.join("a.txt")).unwrap(), b"changed");

        // Cancelling mid-file leaves no partial file behind.
        let huge = local.join("huge.bin");
        std::fs::File::create(&huge).unwrap().set_len(400 * 1024 * 1024).unwrap();
        let st = start_transfers("sf", true, vec![Item { src: huge.to_string_lossy().into(), dst: join_remote(&work, "huge.bin"), is_dir: false }], false).unwrap();
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if transfers.lock().unwrap().iter().any(|f| f["tid"] == st[0].tid.as_str() && f["done"].as_u64().unwrap_or(0) > 0) { break; }
        }
        cancel("sf", &st[0].tid);
        assert_eq!(wait(st[0].tid.clone()).await["state"], "cancelled");
        assert!(!list("sf", &work).await.unwrap().entries.iter().any(|e| e.name == "huge.bin"));

        // Rename and recursive delete.
        rename("sf", &remote_tree, &join_remote(&work, "renamed")).await.unwrap();
        remove("sf", &work).await.unwrap();
        assert!(list("sf", &work).await.is_err());
        std::fs::remove_dir_all(&local).unwrap();
        crate::keys::delete(&key.id).unwrap();
        tx.send(Ctl::Close).unwrap();
        task.await.unwrap().unwrap();
    }
}
