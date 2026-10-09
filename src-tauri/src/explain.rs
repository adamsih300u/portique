//! Turns a failed connection into something a person can act on: what happened, what to try, and
//! the original error underneath for anyone who needs it.
//!
//! The first line is the headline. The terminal tab uses only that line to decide whether a failure
//! is worth retrying on its own, so headlines for sign-in problems keep the word "Authentication".

use crate::store::{Profile, Protocol};
use std::io::ErrorKind;

/// Words in lookup failures from the system resolver, which Rust reports as a plain "other" I/O error.
const DNS_HINTS: [&str; 5] = [
    "failed to lookup address",
    "name or service not known",
    "no such host",
    "nodename nor servname",
    "temporary failure in name resolution",
];

fn io_kind(e: &anyhow::Error) -> Option<ErrorKind> {
    e.chain().find_map(|c| c.downcast_ref::<std::io::Error>()).map(std::io::Error::kind)
}

fn what_to_try(headline: String, advice: &str, raw: &str) -> String {
    format!("{headline}\n{advice}\n\nDetails: {raw}")
}

/// A readable account of why `e` stopped a connection to `p`. Errors that are already clear pass through.
pub fn friendly(e: &anyhow::Error, p: &Profile) -> String {
    let raw = format!("{e:#}");
    let lower = raw.to_lowercase();
    if raw.starts_with("HOST KEY") || raw.starts_with("Host key") {
        return raw; // already says what is wrong and what to do
    }
    let addr = match p.protocol {
        Protocol::Serial => p.serial.port.clone(),
        _ if p.port == 0 => p.host.clone(),
        _ => format!("{}:{}", p.host, p.port),
    };
    let user = if p.username.is_empty() { "this user".to_string() } else { p.username.clone() };
    let kind = io_kind(e);
    let net = !matches!(p.protocol, Protocol::Serial);

    if p.protocol == Protocol::Serial {
        return match kind {
            Some(ErrorKind::PermissionDenied) => what_to_try(
                format!("Not allowed to open {addr}."),
                if cfg!(windows) {
                    "Another program may already be using the port. Close it and try again."
                } else {
                    "On Linux the port usually belongs to the dialout (or uucp) group: add your user to it, then sign out and back in."
                },
                &raw,
            ),
            Some(ErrorKind::NotFound) => what_to_try(format!("There is no serial port called {addr}."), "The adapter may be unplugged, or the port may have a new name. Reconnect it and pick the port again in the profile.", &raw),
            _ => raw,
        };
    }
    if net && DNS_HINTS.iter().any(|h| lower.contains(h)) {
        return what_to_try(
            format!("The name {} could not be resolved.", p.host),
            "Check the spelling, and that your network (or VPN) is connected.",
            &raw,
        );
    }
    if net && (kind == Some(ErrorKind::ConnectionRefused) || lower.contains("connection refused")) {
        return what_to_try(
            format!("{addr} refused the connection."),
            "The computer answered, but nothing is accepting connections on that port. Check the port number and that the service is running.",
            &raw,
        );
    }
    if net && (kind == Some(ErrorKind::TimedOut) || lower.contains("timed out")) {
        return what_to_try(
            format!("No answer from {addr}."),
            "The address may be wrong, the computer may be off, or a firewall may be dropping the traffic. If this host needs a VPN, connect it first.",
            &raw,
        );
    }
    if net && matches!(kind, Some(ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable)) {
        return what_to_try(
            format!("There is no route to {addr}."),
            "Check that you are on the right network, or connect the VPN this host needs.",
            &raw,
        );
    }
    if net && lower.contains("cannot connect") && matches!(kind, Some(ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::UnexpectedEof | ErrorKind::BrokenPipe)) {
        return what_to_try(
            format!("{addr} closed the connection while signing in."),
            "The server may limit who can connect, or be overloaded. Try again in a moment; if it keeps happening, the server's log will say why.",
            &raw,
        );
    }
    if lower.contains("key authentication rejected") {
        return what_to_try(
            format!("Authentication failed: the server rejected the key for {user}."),
            "Check that the matching public key is in that account's authorized_keys on the server, and that this profile uses the right key.",
            &raw,
        );
    }
    if lower.contains("authentication failed") {
        return what_to_try(
            format!("Authentication failed for {user}@{}.", p.host),
            "Check the user name and password. If the account signs in with a key, choose the key in this profile.",
            &raw,
        );
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    fn prof() -> Profile {
        Profile { host: "web.example".into(), port: 22, username: "deploy".into(), ..Profile::default() }
    }
    fn io(kind: ErrorKind, msg: &str) -> anyhow::Error {
        anyhow::Error::from(std::io::Error::new(kind, msg.to_string())).context("cannot connect to web.example:22")
    }
    fn head(s: &str) -> &str {
        s.lines().next().unwrap()
    }

    #[test]
    fn refused_timeout_dns_and_route_get_their_own_advice() {
        let p = prof();
        assert!(head(&friendly(&io(ErrorKind::ConnectionRefused, "Connection refused (os error 111)"), &p)).contains("web.example:22 refused"));
        assert!(head(&friendly(&anyhow!("connection timed out"), &p)).contains("No answer from web.example:22"));
        assert!(head(&friendly(&io(ErrorKind::Other, "failed to lookup address information: Name or service not known"), &p)).contains("could not be resolved"));
        assert!(head(&friendly(&io(ErrorKind::HostUnreachable, "No route to host"), &p)).contains("no route"));
    }

    #[test]
    fn the_original_error_is_kept_underneath() {
        let out = friendly(&io(ErrorKind::ConnectionRefused, "Connection refused (os error 111)"), &prof());
        assert!(out.contains("Details: cannot connect to web.example:22: Connection refused (os error 111)"), "{out}");
    }

    #[test]
    fn sign_in_failures_say_authentication_so_they_are_not_retried() {
        let p = prof();
        let a = friendly(&anyhow!("authentication failed (check username/password)"), &p);
        let k = friendly(&anyhow!("key authentication rejected"), &p);
        for s in [&a, &k] {
            assert!(head(s).contains("Authentication"), "{s}");
        }
        assert!(head(&a).contains("deploy@web.example"));
    }

    #[test]
    fn network_headlines_avoid_the_words_that_stop_auto_reconnect() {
        let p = prof();
        for e in [
            io(ErrorKind::ConnectionRefused, "refused"),
            anyhow!("connection timed out"),
            io(ErrorKind::Other, "failed to lookup address information"),
            io(ErrorKind::HostUnreachable, "unreachable"),
        ] {
            let h = friendly(&e, &p);
            let first = head(&h).to_lowercase();
            assert!(!["authenticat", "rejected", "not found", "not accepted"].iter().any(|w| first.contains(w)), "{first}");
        }
    }

    #[test]
    fn host_key_messages_and_unknown_errors_pass_through() {
        let p = prof();
        assert_eq!(friendly(&anyhow!("HOST KEY CHANGED for x"), &p), "HOST KEY CHANGED for x");
        assert_eq!(friendly(&anyhow!("something odd"), &p), "something odd");
    }

    #[test]
    fn serial_permission_problems_are_explained() {
        let mut p = prof();
        p.protocol = Protocol::Serial;
        p.serial.port = "/dev/ttyUSB0".into();
        let e = anyhow::Error::from(std::io::Error::new(ErrorKind::PermissionDenied, "Permission denied")).context("cannot open /dev/ttyUSB0");
        assert!(head(&friendly(&e, &p)).contains("Not allowed to open /dev/ttyUSB0"));
    }
}
