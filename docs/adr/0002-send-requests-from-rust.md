# ADR-0002: API requests are sent from Rust, not the web view

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`api-roadmap`](../changes/api-roadmap.md) (D2)
- **Superseded by:** none

- **Context:** A browser `fetch` is bound by CORS, can't accept self-signed certificates, can't go through an SSH proxy, and would need secrets in the page.
- **Decision:** All requests go through a `http_send` command using `reqwest`.
- **Consequences:** No CORS, full control of TLS and proxies, cancellable. It adds a dependency and a TLS library that needs `nasm` and `cmake` to cross-compile for Windows.
- **Alternatives considered:** `fetch` with a CORS proxy (fragile and unsafe); the Tauri HTTP plugin (less control over the pieces above).
