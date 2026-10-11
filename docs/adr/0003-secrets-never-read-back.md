# ADR-0003: Secret values stay in Rust once written

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`api-roadmap`](../changes/api-roadmap.md), decision D3
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** Tokens and client secrets have to stay out of saved requests, exports, copied cURL commands and the page's memory.
- **Decision:** Store secret environment values in the vault as `apienv:<envId>:<name>`. The interface may write one and has no way to read it. `http.rs` expands `{{name}}` itself, using plain values sent by the interface and secrets from the vault. Exports and cURL keep `{{name}}`.
- **Consequences:** Secrets are safe by construction. The interface shows no secret value, and a request preview shows the placeholder in its place.
- **Alternatives considered:** Keeping secrets in `api.json` leaves them as plain text on disk. Returning them to the page on demand lets them reach saved state and screenshots.
