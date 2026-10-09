# ADR-0003: Secret values are filled in by Rust and never read back

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`api-roadmap`](../changes/api-roadmap.md) (D3)
- **Superseded by:** none

- **Context:** Tokens and client secrets must not end up in saved requests, exports, copied cURL commands, or the page's memory longer than needed.
- **Decision:** Secret environment values are stored in the vault as `apienv:<envId>:<name>`. The interface can write one but can't read one. `http.rs` expands `{{name}}` itself, looking up plain values the interface sends and secrets in the vault. Exports and cURL keep `{{name}}`.
- **Consequences:** Secrets are safe by construction, but the interface can't show a secret's value, and a request preview can't show the final secret.
- **Alternatives considered:** keeping secrets in `api.json` (plain text on disk); returning them to the page on demand (they would reach saved state and screenshots).
