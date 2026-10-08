//! Minimal Telnet client: IAC negotiation (ECHO, SGA, TTYPE, NAWS) over tokio TCP.

use crate::session::{saved_password, AutoLogin, Ctl, Emitter, Params};
use crate::store::Profile;
use anyhow::{Context, Result};
use std::{collections::HashSet, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc::{UnboundedReceiver, UnboundedSender},
};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
/// Subnegotiation payloads are tiny; cap what a hostile server can make us buffer.
const MAX_SB: usize = 1024;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

#[derive(PartialEq, Clone, Copy)]
enum St {
    Data,
    Cr,
    Iac,
    Cmd(u8),
    Sb,
    SbIac,
}

pub struct Telnet {
    st: St,
    sb: Vec<u8>,
    us: HashSet<u8>,
    him: HashSet<u8>,
    pub cols: u16,
    pub rows: u16,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { st: St::Data, sb: vec![], us: HashSet::new(), him: HashSet::new(), cols, rows }
    }

    pub fn naws_active(&self) -> bool {
        self.us.contains(&OPT_NAWS)
    }

    pub fn naws(&self) -> Vec<u8> {
        let mut v = vec![IAC, SB, OPT_NAWS];
        for b in [(self.cols >> 8) as u8, self.cols as u8, (self.rows >> 8) as u8, self.rows as u8] {
            v.push(b);
            if b == IAC {
                v.push(IAC);
            }
        }
        v.extend([IAC, SE]);
        v
    }

    /// Consume network bytes; plain data goes to `out`, protocol replies to `reply`.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>, reply: &mut Vec<u8>) {
        for &b in input {
            match self.st {
                St::Data | St::Cr => {
                    if self.st == St::Cr {
                        self.st = St::Data;
                        if b == 0 {
                            continue; // CR NUL == bare CR
                        }
                    }
                    match b {
                        IAC => self.st = St::Iac,
                        b'\r' => {
                            out.push(b);
                            self.st = St::Cr;
                        }
                        _ => out.push(b),
                    }
                }
                St::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        self.st = St::Data;
                    }
                    WILL | WONT | DO | DONT => self.st = St::Cmd(b),
                    SB => {
                        self.sb.clear();
                        self.st = St::Sb;
                    }
                    _ => self.st = St::Data,
                },
                St::Cmd(cmd) => {
                    self.negotiate(cmd, b, reply);
                    self.st = St::Data;
                }
                St::Sb => {
                    if b == IAC {
                        self.st = St::SbIac;
                    } else if self.sb.len() < MAX_SB {
                        self.sb.push(b);
                    }
                }
                St::SbIac => {
                    if b == SE {
                        self.subnegotiate(reply);
                        self.st = St::Data;
                    } else {
                        if self.sb.len() < MAX_SB {
                            self.sb.push(b);
                        }
                        self.st = St::Sb;
                    }
                }
            }
        }
    }

    fn negotiate(&mut self, cmd: u8, opt: u8, reply: &mut Vec<u8>) {
        match cmd {
            WILL => {
                if matches!(opt, OPT_ECHO | OPT_SGA) {
                    if self.him.insert(opt) {
                        reply.extend([IAC, DO, opt]);
                    }
                } else {
                    reply.extend([IAC, DONT, opt]);
                }
            }
            DO => {
                if matches!(opt, OPT_TTYPE | OPT_NAWS | OPT_SGA) {
                    if self.us.insert(opt) {
                        reply.extend([IAC, WILL, opt]);
                        if opt == OPT_NAWS {
                            reply.extend(self.naws());
                        }
                    }
                } else {
                    reply.extend([IAC, WONT, opt]);
                }
            }
            WONT => {
                self.him.remove(&opt);
            }
            DONT => {
                self.us.remove(&opt);
            }
            _ => {}
        }
    }

    fn subnegotiate(&mut self, reply: &mut Vec<u8>) {
        // TTYPE SEND
        if self.sb.first() == Some(&OPT_TTYPE) && self.sb.get(1) == Some(&1) {
            reply.extend([IAC, SB, OPT_TTYPE, 0]);
            reply.extend(b"xterm-256color");
            reply.extend([IAC, SE]);
        }
    }

    /// Escape user input for the wire: IAC doubled, Enter becomes CR LF.
    pub fn encode(input: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(input.len());
        for &b in input {
            match b {
                IAC => v.extend([IAC, IAC]),
                b'\r' => v.extend([b'\r', b'\n']),
                _ => v.push(b),
            }
        }
        v
    }
}

pub async fn run(
    p: &Profile,
    params: Params,
    em: Emitter,
    mut rx: UnboundedReceiver<Ctl>,
    tx: UnboundedSender<Ctl>,
) -> Result<()> {
    let addr = format!("{}:{}", p.host, if p.port == 0 { 23 } else { p.port });
    let mut stream = tokio::time::timeout(Duration::from_secs(15), TcpStream::connect(&addr))
        .await
        .context("connection timed out")?
        .with_context(|| format!("cannot connect to {addr}"))?;
    stream.set_nodelay(true)?;
    em.status("connected", &format!("Connected to {addr}"));

    let mut t = Telnet::new(params.cols, params.rows);
    let mut auto = AutoLogin::new(Some(p.username.clone()), saved_password(p, &params.password));
    let mut buf = vec![0u8; 8192];
    loop {
        tokio::select! {
            n = stream.read(&mut buf) => {
                let n = n?;
                if n == 0 { break; }
                let (mut out, mut reply) = (Vec::new(), Vec::new());
                t.feed(&buf[..n], &mut out, &mut reply);
                if !reply.is_empty() { stream.write_all(&reply).await?; }
                if !out.is_empty() {
                    em.data(&out);
                    if let Some(send) = auto.scan(&out) { let _ = tx.send(Ctl::Input(send)); }
                }
            }
            c = rx.recv() => match c {
                Some(Ctl::Input(d)) => stream.write_all(&Telnet::encode(&d)).await?,
                Some(Ctl::Resize(c, r)) => {
                    t.cols = c; t.rows = r;
                    if t.naws_active() { stream.write_all(&t.naws()).await?; }
                }
                Some(Ctl::Close) | None => break,
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_and_strips_iac() {
        let mut t = Telnet::new(80, 24);
        let (mut out, mut reply) = (vec![], vec![]);
        t.feed(&[IAC, WILL, OPT_ECHO, IAC, DO, OPT_NAWS, b'h', b'i', b'\r', 0, IAC, IAC], &mut out, &mut reply);
        assert_eq!(out, vec![b'h', b'i', b'\r', IAC]);
        assert!(reply.starts_with(&[IAC, DO, OPT_ECHO, IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]));
        // repeated offers do not loop
        reply.clear();
        t.feed(&[IAC, WILL, OPT_ECHO], &mut out, &mut reply);
        assert!(reply.is_empty());
    }

    #[test]
    fn answers_terminal_type() {
        let mut t = Telnet::new(80, 24);
        let (mut out, mut reply) = (vec![], vec![]);
        t.feed(&[IAC, SB, OPT_TTYPE, 1, IAC, SE], &mut out, &mut reply);
        assert!(reply.starts_with(&[IAC, SB, OPT_TTYPE, 0]));
    }

    #[test]
    fn subnegotiation_buffer_is_bounded() {
        let mut t = Telnet::new(80, 24);
        let (mut out, mut reply) = (vec![], vec![]);
        t.feed(&[IAC, SB, 99], &mut out, &mut reply);
        t.feed(&vec![7u8; 1_000_000], &mut out, &mut reply);
        assert!(t.sb.len() <= MAX_SB);
    }

    #[test]
    fn encodes_input() {
        assert_eq!(Telnet::encode(&[b'a', IAC, b'\r']), vec![b'a', IAC, IAC, b'\r', b'\n']);
    }
}
