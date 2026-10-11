# ADR-0004: Requests through an SSH host use a local SOCKS5 proxy

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`api-roadmap`](../changes/api-roadmap.md), decision D4
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** Adam wanted requests to reach services that only an SSH server can see. The app already had a SOCKS5 forwarder for port forwards.
- **Decision:** A new session type logs in, opens the forwarder on an ephemeral local port and reports that port. Requests use `socks5h://127.0.0.1:<port>`, so the server resolves names. Each profile keeps one login and reuses it.
- **Consequences:** Names that resolve only on the server work, redirects to other hosts stay inside the tunnel, and jump hosts apply. The login stays open until the connection drops.
- **Alternatives considered:** A local forward per destination with a DNS override breaks on redirects to new hosts. A custom connector in the HTTP client takes more code for the same result.
