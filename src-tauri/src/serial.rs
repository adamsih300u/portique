//! Serial console sessions via the `serialport` crate.

use crate::session::{saved_password, AutoLogin, Ctl, Emitter, Params};
use crate::store::Profile;
use anyhow::{Context, Result};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::{
    io::{ErrorKind, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

pub async fn run(
    p: &Profile,
    params: Params,
    em: Emitter,
    mut rx: UnboundedReceiver<Ctl>,
    tx: UnboundedSender<Ctl>,
) -> Result<()> {
    let s = &p.serial;
    let mut port = serialport::new(&s.port, if s.baud == 0 { 9600 } else { s.baud })
        .data_bits(match s.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(match s.parity.as_str() {
            "odd" => Parity::Odd,
            "even" => Parity::Even,
            _ => Parity::None,
        })
        .stop_bits(if s.stop_bits == 2 { StopBits::Two } else { StopBits::One })
        .flow_control(match s.flow.as_str() {
            "software" => FlowControl::Software,
            "hardware" => FlowControl::Hardware,
            _ => FlowControl::None,
        })
        .timeout(Duration::from_millis(50))
        .open()
        .with_context(|| format!("cannot open {}", s.port))?;
    em.status("connected", &format!("Opened {} @ {} baud", s.port, s.baud));

    let mut reader = port.try_clone()?;
    let stop = Arc::new(AtomicBool::new(false));
    let (stop_r, em_r) = (stop.clone(), em.clone());
    let mut auto = AutoLogin::new(Some(p.username.clone()), saved_password(p, &params.password));
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !stop_r.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    em_r.data(&buf[..n]);
                    if let Some(send) = auto.scan(&buf[..n]) {
                        let _ = tx.send(Ctl::Input(send));
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
                Err(e) => {
                    em_r.status("error", &format!("Serial read failed: {e}"));
                    let _ = tx.send(Ctl::Close);
                    break;
                }
            }
        }
    });

    while let Some(c) = rx.recv().await {
        match c {
            Ctl::Input(d) => {
                let mut off = 0;
                while off < d.len() {
                    match port.write(&d[off..]) {
                        Ok(n) => off += n,
                        Err(e) if e.kind() == ErrorKind::TimedOut => {}
                        Err(e) => {
                            stop.store(true, Ordering::Relaxed);
                            return Err(e.into());
                        }
                    }
                }
            }
            Ctl::Resize(..) => {}
            Ctl::Close => break,
        }
    }
    stop.store(true, Ordering::Relaxed);
    Ok(())
}
