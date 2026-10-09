# ADR-0004: Sending through an SSH host uses a local SOCKS5 proxy

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`api-roadmap`](../changes/api-roadmap.md) (D4)
- **Superseded by:** none

- **Context:** Adam wanted requests to reach services only an SSH server can see. The app already had a SOCKS5 forwarder for port forwards.
- **Decision:** A new session type logs in, opens the forwarder on an ephemeral local port, and reports the port. Requests use `socks5h://127.0.0.1:<port>`, so the **server** resolves the name. One login is kept per profile and reused.
- **Consequences:** Hostnames that only resolve on the server work, redirects to other hosts stay inside the tunnel, and jump hosts are honoured. The login stays open until the connection drops.
- **Alternatives considered:** a local forward per destination with a DNS override (breaks on redirects to new hosts); a custom connector in the HTTP client (more code for the same result).
