# Notice when an older vault file is put back

- **Branch:** `feat/vault-rollback-counter`
- **PR:** (not open yet; push is queued for after working hours)
- **Status:** draft
- **Author:** Claude, for Adam
- **Builds on:** [vault-password-strength](vault-password-strength.md) (same file, so this branch starts from it)

## Summary

If the `vault.bin` on this computer is older than the newest one it has opened, unlock now stops and says so. Pressing **Unlock** a second time opens it anyway. Normal use looks the same as before.

## Why

An old copy of the vault is a perfectly valid file, so restoring one fails silently. It brings back deleted secrets and, worse, the old master password after a change. Records: [ADR-0013](../adr/0013-older-vault-is-refused.md) (new). [ADR-0003](../adr/0003-secrets-never-read-back.md) is unaffected.

## What changed

- The encrypted payload gains `generation`, which rises on every save. Vaults saved before this read as 0, so no format version changes and `termix-vault` authenticated data stays as it is.
- Each computer records the highest generation it has opened in `vault.seen`, under the machine-local data folder (`~/.local/share/portique` on Linux, `%LOCALAPPDATA%` on Windows).
- `Vault::unlock` takes `accept_older`. A lower generation fails with "vault is older than the last one opened on this computer" unless it is true. A confirmed older vault lowers the note to match.
- `create` starts a new history. `change_password` checks the old password with the new `read()` helper instead of a throwaway second vault.
- `vault_unlock` takes `acceptOlder`; the unlock dialog shows the warning and asks for a second press of Unlock.

## How to review

`unlock`, `save` and `record_seen` in `src-tauri/src/vault.rs`, then the rollback tests.

## What was tested

`cargo test --lib`: 35 passed, 4 ignored (need a local sshd; not run). New tests: restoring an older file is refused and then accepted; rollback past a password change is caught; a computer with no note trusts the file and tracks it from then on; the generation rises per save and a failed write does not count; payloads without the field still load. I did not run the app, so the dialog flow is unchecked.

## Not done / follow-ups

- The note is plain and per user. Someone able to write both folders can reset it (see D1).
- An older build that saves the vault drops `generation`; the newer build then asks for confirmation once.
- Deleting `vault.seen` turns the check off for that computer.

## Decisions

### D1. Detect rollback with a counter and a machine-local note

- **Status:** accepted, recorded as [ADR-0013](../adr/0013-older-vault-is-refused.md)
- **Context:** The vault is portable on purpose: you copy its files between machines. Any detection has to survive that and still catch a stale file.
- **Decision:** Counter inside the authenticated payload; highest-seen note outside the portable set; refuse lower, with an explicit confirm.
- **Consequences:** No format bump, no new dependency, and moving the vault to a new computer just works. The protection is advisory against an attacker who controls the whole account.
- **Alternatives considered:** See the ADR.

### D2. Confirm in the same dialog, not a new one

- **Status:** accepted
- **Context:** The interface stays quiet, and this event is rare.
- **Decision:** Show the warning in the dialog's error line; the next press of Unlock confirms. Editing the password field cancels the confirmation.
- **Consequences:** No new screen. The confirm is less prominent than a dedicated dialog.
- **Alternatives considered:** A separate yes/no dialog: more UI for a rare case. Opening with a banner instead of stopping: easy to miss.
