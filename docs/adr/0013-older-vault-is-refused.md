# ADR-0013: A vault older than the last one opened is refused

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`vault-rollback-counter`](../changes/vault-rollback-counter.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** The vault file is authenticated, but an old copy is a valid file. Restoring one undoes deletions and password changes without any failure.
- **Decision:** Every save raises a `generation` counter inside the encrypted payload. Each computer records the highest generation it has opened in `vault.seen`, in its local data folder, not beside `vault.bin`. Unlock refuses a lower generation until the person confirms.
- **Consequences:** Restoring an old `vault.bin` on a computer that opened a newer one is noticed, including a rollback past a password change. A computer that has no note trusts the file. Someone who can write both the config and local data folders can reset the note, so this guards against stale or swapped files, not a full compromise of the account.
- **Alternatives considered:** A counter in the file alone: a restored file carries its own old counter. A note beside `vault.bin`: copies and sync tools carry it with the file. The system keyring or a TPM counter: stronger, but ties the vault to one machine and breaks copying it.
