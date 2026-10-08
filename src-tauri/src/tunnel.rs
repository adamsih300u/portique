//! SSH port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D). Forwards live exactly
//! as long as the `Tunnels` guard, which the SSH session holds.

use crate::store::{Forward, ForwardKind};
use russh::client::{Handle, Handler};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

/// Remote forwards the server may open channels for: remote port -> where to connect locally.
pub type RemoteMap = Arc<Mutex<HashMap<u32, (String, u16)>>>;

/// Outcome of one forward, shown to the user once the session is up.
pub struct Status {
    pub label: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Tunnels(Vec<JoinHandle<()>>);

impl Drop for Tunnels {
    fn drop(&mut self) {
        for t in &self.0 {
            t.abort();
        }
    }
}

pub fn label(f: &Forward) -> String {
    match f.kind {
        ForwardKind::Local => format!("localhost:{} → {}:{}", f.listen_port, f.dest_host, f.dest_port),
        ForwardKind::Remote => format!("server:{} → {}:{}", f.listen_port, f.dest_host, f.dest_port),
        ForwardKind::Dynamic => format!("SOCKS5 localhost:{}", f.listen_port),
    }
}

pub async fn start<H>(handle: &Arc<Handle<H>>, forwards: &[Forward], remote: &RemoteMap) -> (Tunnels, Vec<Status>)
where
    H: Handler + Send + 'static,
{
    let mut tunnels = Tunnels::default();
    let mut report = Vec::new();
    for f in forwards {
        let res = match f.kind {
            ForwardKind::Local | ForwardKind::Dynamic => listen(handle.clone(), f).await.map(|t| tunnels.0.push(t)),
            ForwardKind::Remote => {
                let port = f.listen_port as u32;
                match handle.tcpip_forward("localhost", port).await {
                    Ok(_) => {
                        remote.lock().unwrap().insert(port, (f.dest_host.clone(), f.dest_port));
                        Ok(())
                    }
                    Err(e) => Err(format!("server refused the forward ({e})")),
                }
            }
        };
        report.push(Status { label: label(f), error: res.err() });
    }
    (tunnels, report)
}

async fn listen<H>(handle: Arc<Handle<H>>, f: &Forward) -> Result<JoinHandle<()>, String>
where
    H: Handler + Send + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", f.listen_port))
        .await
        .map_err(|e| format!("cannot listen on port {}: {e}", f.listen_port))?;
    let (kind, dest) = (f.kind, (f.dest_host.clone(), f.dest_port));
    Ok(tokio::spawn(async move {
        while let Ok((sock, peer)) = listener.accept().await {
            let (handle, dest) = (handle.clone(), dest.clone());
            tokio::spawn(async move {
                let _ = match kind {
                    ForwardKind::Dynamic => socks(&handle, sock, peer).await,
                    _ => pipe(&handle, sock, peer, &dest.0, dest.1).await,
                };
            });
        }
    }))
}

async fn pipe<H: Handler + Send + 'static>(
    handle: &Handle<H>,
    mut sock: TcpStream,
    peer: SocketAddr,
    host: &str,
    port: u16,
) -> std::io::Result<()> {
    let ch = handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await
        .map_err(std::io::Error::other)?;
    copy_bidirectional(&mut sock, &mut ch.into_stream()).await.map(|_| ())
}

/// Minimal SOCKS5 server: no authentication, CONNECT only.
async fn socks<H: Handler + Send + 'static>(handle: &Handle<H>, mut s: TcpStream, peer: SocketAddr) -> std::io::Result<()> {
    let bad = |m| std::io::Error::new(std::io::ErrorKind::InvalidData, m);
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(bad("not SOCKS5"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        return Err(bad("no acceptable auth method"));
    }
    s.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| bad("bad hostname"))?
        }
        _ => {
            s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(bad("unsupported address type"));
        }
    };
    let mut port = [0u8; 2];
    s.read_exact(&mut port).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(bad("only CONNECT is supported"));
    }
    let port = u16::from_be_bytes(port);
    match handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(ch) => {
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            copy_bidirectional(&mut s, &mut ch.into_stream()).await.map(|_| ())
        }
        Err(e) => {
            s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            Err(std::io::Error::other(e))
        }
    }
}

/// Server opened a channel for one of our remote forwards: connect it to the local target.
pub fn accept_remote(map: &RemoteMap, port: u32, channel: russh::Channel<russh::client::Msg>) {
    let Some((host, dest_port)) = map.lock().unwrap().get(&port).cloned() else {
        return;
    };
    tokio::spawn(async move {
        if let Ok(mut local) = TcpStream::connect((host.as_str(), dest_port)).await {
            let _ = copy_bidirectional(&mut local, &mut channel.into_stream()).await;
        }
    });
}
