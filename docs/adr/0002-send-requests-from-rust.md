# ADR-0002: API requests are sent from Rust

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`api-roadmap`](../changes/api-roadmap.md), decision D2
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** A browser `fetch` is bound by CORS, rejects self-signed certificates, cannot use an SSH proxy and would hold secrets in the page.
- **Decision:** Route every request through the `http_send` command, which uses `reqwest`.
- **Consequences:** Requests ignore CORS, control TLS and proxies fully, and can be cancelled. The build gains a dependency, and its TLS library needs `nasm` and `cmake` to cross-compile for Windows.
- **Alternatives considered:** `fetch` through a CORS proxy is fragile and unsafe. The Tauri HTTP plugin offers less control over TLS and proxies.
