# Keep unlocked secrets sealed in memory

- **Branch:** `feat/vault-sealed-memory`
- **PR:** (not open yet; push is queued for after working hours)
- **Status:** draft
- **Author:** Claude, for Adam
- **Builds on:** [vault-rollback-counter](vault-rollback-counter.md), which this branch starts from

## Summary

Unlocking the vault no longer leaves every saved password and key as plain text in memory. Each secret stays sealed, and Rust opens only the one it needs, for as long as it needs it, then wipes the copy. Nothing changes in how the app looks or behaves.

## Why

Auto-lock bounds how long the vault stays open, but until the lock fires, the whole set sat readable in the process, and `get` handed out copies that were never wiped. A memory dump, swap file or crash report from that window would have held every secret. Supports: [ADR-0003](../adr/0003-secrets-never-read-back.md) (secrets already stay in Rust). New record: [ADR-0014](../adr/0014-secrets-sealed-in-memory.md).

## What changed

- `vault.rs` gains `Secrets`: a random 256-bit key made at each unlock seals every value (XChaCha20-Poly1305, fresh nonce, the secret's name as associated data). `unlock` seals what it reads and wipes the plain copy.
- `Vault::get` returns `Option<Zeroizing<String>>`. `set` and `delete` seal or remove one entry. A save opens all secrets for the length of the write only, into a buffer that is wiped on drop.
- `change_password` swaps only the file key; the sealed secrets are untouched.
- Callers: `keys.rs` keeps the key and passphrase wiped after use; `http.rs` and `session.rs` still need a plain `String` for the request or the login, so they take a copy at that point.

## How to review

`Secrets` and `Vault::get`/`save` in `src-tauri/src/vault.rs`, then the five new tests at the end of that file.

## What was tested

`cargo test --lib`: 40 passed, 4 ignored (they need a local sshd; not run). New tests check that sealed blobs hold no plain text, that swapping two blobs between names fails, that a damaged blob is an error, that every unlock uses a new key and a password change leaves the blobs alone, and that overwrite and delete persist. `cargo clippy` shows nothing new. I did not run the app, a real SSH login, or an API request with secrets.

## Not done / follow-ups

- **This is not protection from an attacker who can read the whole process:** the keys live in the same memory. It narrows what lingers and what a stray dump or swap page can hold.
- Lock the key pages (`mlock` / `VirtualLock`) and turn off core dumps and same-user debugging (`PR_SET_DUMPABLE`), so the key itself cannot reach swap or a dump. Needs `unsafe` or a new dependency and a Windows check; it deserves its own branch.
- Hand passwords to `russh` and the API sender without a `String` copy.
- The master key stays in memory while unlocked, since every save needs it.

## Decisions

### D1. Seal each secret under a random per-unlock key

- **Status:** accepted, recorded as [ADR-0014](../adr/0014-secrets-sealed-in-memory.md)
- **Context:** The request was to avoid loading secrets until needed. Secrets cannot stay on disk and be read per use without keeping the master key and re-reading the file, and then each read exposes the whole vault.
- **Decision:** Seal per secret in memory; open one at a time into a self-wiping value.
- **Consequences:** Smaller exposure per use and a cheap password change. Plain text is shorter-lived, not gone: a save opens everything briefly, and protocol code takes copies.
- **Alternatives considered:** See the ADR.

### D2. A separate key, not the master key

- **Status:** accepted
- **Context:** The master key is already in memory, so sealing under it adds no strength.
- **Decision:** Use a fresh random key per unlock that has nothing to do with the password.
- **Consequences:** A password change does not re-seal anything, and the sealed set is useless without that unlock's key. Costs 32 more bytes held.
- **Alternatives considered:** The master key: re-seals on every password change for no gain.
