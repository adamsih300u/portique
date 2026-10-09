//! Network helpers for the palette's Toolbox: a name lookup, a port check, a TCP ping and Wake-on-LAN.
//! They use only the standard library and tokio, run on this computer, and never touch a profile or the vault.

use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::net::{lookup_host, TcpStream, UdpSocket};

/// Most ports one check will probe, and the most connections one ping will make.
const MAX_PORTS: usize = 64;
const MAX_PINGS: u32 = 20;
const TIMEOUT: Duration = Duration::from_millis(3000);

#[derive(Serialize, Debug, PartialEq)]
pub struct PortResult {
    pub port: u16,
    pub open: bool,
    /// Milliseconds to connect, when it did.
    pub ms: Option<f64>,
    /// Why it did not connect: "refused", "timed out" or the system's message.
    pub note: String,
}

fn ms(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

/// The addresses a name resolves to (IPv4 first), as the system resolver sees them. An address resolves to itself.
pub async fn dns(name: &str) -> anyhow::Result<Vec<IpAddr>> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "Enter a host name");
    if let Ok(ip) = name.trim_matches(['[', ']']).parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let found = tokio::time::timeout(Duration::from_secs(8), lookup_host((name, 0)))
        .await
        .map_err(|_| anyhow::anyhow!("The lookup timed out"))?
        .map_err(|_| anyhow::anyhow!("No address found for {name}"))?;
    let mut out: Vec<IpAddr> = Vec::new();
    for a in found {
        if !out.contains(&a.ip()) {
            out.push(a.ip());
        }
    }
    out.sort_by_key(|ip| ip.is_ipv6());
    anyhow::ensure!(!out.is_empty(), "No address found for {name}");
    Ok(out)
}

/// One connection attempt to an already resolved address.
async fn try_connect(addr: SocketAddr) -> PortResult {
    let start = Instant::now();
    match tokio::time::timeout(TIMEOUT, TcpStream::connect(addr)).await {
        Ok(Ok(_)) => PortResult { port: addr.port(), open: true, ms: Some(ms(start)), note: String::new() },
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => PortResult { port: addr.port(), open: false, ms: None, note: "refused".into() },
        Ok(Err(e)) => PortResult { port: addr.port(), open: false, ms: None, note: e.to_string() },
        Err(_) => PortResult { port: addr.port(), open: false, ms: None, note: "timed out".into() },
    }
}

/// The address to probe for a host name: the first one the resolver gives.
async fn target(host: &str) -> anyhow::Result<IpAddr> {
    Ok(dns(host).await?[0])
}

/// Tries each port at once and reports them in the order given.
pub async fn check_ports(host: &str, ports: &[u16]) -> anyhow::Result<(IpAddr, Vec<PortResult>)> {
    anyhow::ensure!(!ports.is_empty(), "Enter a port");
    anyhow::ensure!(ports.len() <= MAX_PORTS, "Check at most {MAX_PORTS} ports at a time");
    let ip = target(host).await?;
    let tasks: Vec<_> = ports.iter().map(|&p| tokio::spawn(try_connect(SocketAddr::new(ip, p)))).collect();
    let mut out = Vec::new();
    for t in tasks {
        out.push(t.await?);
    }
    Ok((ip, out))
}

/// Connects `count` times, one a second, and reports the time of each (None for a failure).
pub async fn tcp_ping(host: &str, port: u16, count: u32) -> anyhow::Result<(IpAddr, Vec<PortResult>)> {
    anyhow::ensure!(port != 0, "Enter a port");
    let count = count.clamp(1, MAX_PINGS);
    let ip = target(host).await?;
    let mut out = Vec::new();
    for i in 0..count {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        out.push(try_connect(SocketAddr::new(ip, port)).await);
    }
    Ok((ip, out))
}

/// Six bytes from `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, `aabb.ccdd.eeff` or `aabbccddeeff`.
pub fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let digits: String = s.trim().chars().filter(|c| !matches!(c, ':' | '-' | '.')).collect();
    if digits.len() != 12 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // The separators must be consistent, so `aa:bb-cc:…` is not taken for an address.
    let seps: Vec<char> = s.trim().chars().filter(|c| matches!(c, ':' | '-' | '.')).collect();
    if seps.windows(2).any(|w| w[0] != w[1]) {
        return None;
    }
    let mut mac = [0u8; 6];
    for (i, b) in mac.iter_mut().enumerate() {
        *b = u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(mac)
}

/// Six 0xFF bytes followed by the address sixteen times.
pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut p = vec![0xFFu8; 6];
    for _ in 0..16 {
        p.extend_from_slice(&mac);
    }
    p
}

/// Broadcasts a Wake-on-LAN packet (UDP port 9). `broadcast` defaults to the whole local network.
pub async fn wake(mac: &str, broadcast: &str) -> anyhow::Result<String> {
    let mac = parse_mac(mac).ok_or_else(|| anyhow::anyhow!("That isn't a MAC address (like aa:bb:cc:dd:ee:ff)"))?;
    let dest: IpAddr = match broadcast.trim() {
        "" => IpAddr::from([255, 255, 255, 255]),
        b => b.parse().map_err(|_| anyhow::anyhow!("The broadcast address must be an IP address, like 192.168.1.255"))?,
    };
    let bind = if dest.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let sock = UdpSocket::bind(bind).await?;
    sock.set_broadcast(true)?;
    sock.send_to(&magic_packet(mac), SocketAddr::new(dest, 9)).await?;
    Ok(mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mac_addresses() {
        let want = Some([0xaa, 0xbb, 0xcc, 0x01, 0x02, 0x03]);
        for s in ["aa:bb:cc:01:02:03", "AA-BB-CC-01-02-03", "aabb.cc01.0203", "aabbcc010203", "  aa:bb:cc:01:02:03 "] {
            assert_eq!(parse_mac(s), want, "{s}");
        }
        for s in ["", "aa:bb:cc:01:02", "aa:bb:cc:01:02:0g", "aa:bb-cc:01:02:03", "aa:bb:cc:01:02:03:04"] {
            assert_eq!(parse_mac(s), None, "{s}");
        }
    }

    #[test]
    fn magic_packet_is_ff_then_the_mac_sixteen_times() {
        let p = magic_packet([1, 2, 3, 4, 5, 6]);
        assert_eq!(p.len(), 102);
        assert!(p[..6].iter().all(|&b| b == 0xFF));
        assert!(p[6..].chunks(6).all(|c| c == [1, 2, 3, 4, 5, 6]));
    }

    #[tokio::test]
    async fn an_address_resolves_to_itself() {
        assert_eq!(dns("10.1.2.3").await.unwrap(), vec!["10.1.2.3".parse::<IpAddr>().unwrap()]);
        assert_eq!(dns("[::1]").await.unwrap(), vec!["::1".parse::<IpAddr>().unwrap()]);
        assert!(dns("  ").await.is_err());
    }

    #[tokio::test]
    async fn finds_an_open_and_a_closed_port() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open = l.local_addr().unwrap().port();
        let closed = {
            let t = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            t.local_addr().unwrap().port()
        };
        let (ip, r) = check_ports("127.0.0.1", &[open, closed]).await.unwrap();
        assert_eq!(ip.to_string(), "127.0.0.1");
        assert!(r[0].open && r[0].ms.is_some());
        assert!(!r[1].open && r[1].note == "refused");
        assert!(check_ports("127.0.0.1", &[]).await.is_err());
        assert!(check_ports("127.0.0.1", &[80; MAX_PORTS + 1]).await.is_err());
    }

    #[tokio::test]
    async fn pings_a_listener() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (_, r) = tcp_ping("127.0.0.1", l.local_addr().unwrap().port(), 1).await.unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].open);
    }

    #[tokio::test]
    async fn wake_rejects_bad_input_and_sends_to_a_local_listener() {
        assert!(wake("nonsense", "").await.is_err());
        assert!(wake("aa:bb:cc:01:02:03", "not-an-ip").await.is_err());
        // A broadcast to the loopback address is delivered like any other datagram, so the send itself succeeds.
        assert_eq!(wake("AA-BB-CC-01-02-03", "127.0.0.1").await.unwrap(), "aa:bb:cc:01:02:03");
    }
}
