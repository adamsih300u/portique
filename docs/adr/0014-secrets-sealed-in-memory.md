# ADR-0014: Secrets stay sealed in memory and open one at a time

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`vault-sealed-memory`](../changes/vault-sealed-memory.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0003 (supports: secrets already stay in Rust; this narrows how long they are plain there)

- **Context:** An unlocked vault kept every secret as plain text for as long as it stayed unlocked, 15 minutes by default, and `get` returned copies that were never wiped.
- **Decision:** `vault.rs` seals each secret in memory under a random per-unlock key, with the secret's name as associated data. `get` opens one secret into a `Zeroizing<String>` that wipes itself on drop. The full set is opened only for the moment a save needs it.
- **Consequences:** Plain text lives for the length of one use instead of the whole unlocked session, and a password change no longer touches the sealed secrets. This does not stop an attacker who can read the whole process, because the keys sit in the same memory; swap and core-dump protection needs locked memory, which is a follow-up. Callers that need a plain `String` for a protocol still take a copy.
- **Alternatives considered:** Decrypting the whole file on every read: puts all secrets in plain text each time. Per-secret sealing under the master key: ties the sealed set to the password and re-seals on change. An OS keyring or hardware key: stronger, but breaks copying the vault between machines. A separate agent process, as ssh-agent does: a larger change to isolate the same secrets.
