# ADR-0020: The vault is created when the first secret is saved

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`lazy-vault`](../changes/lazy-vault.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** [ADR-0003](0003-secrets-never-read-back.md)

- **Context:** A new user met a "create vault" wall before seeing the app, although profiles hold no secrets and many connections never need one.
- **Decision:** `vault.rs` treats a missing `vault.bin` as an empty store: `get`, `contains` and `delete` answer "nothing" and a session starts without a prompt. A write fails with the usual locked error, and `guarded` in `api.ts` turns that into the create dialog, then retries. Declining rejects the write. Startup unlocks only a vault that exists.
- **Consequences:** The first launch goes straight to the app. The create dialog says why it appears, and the lock button and command do nothing until a vault exists. Code that stores a secret must go through `guarded`.
- **Alternatives considered:** Creating the vault at install time repeats the wall. A vault made silently with a generated key protects nothing from someone with the disk.
