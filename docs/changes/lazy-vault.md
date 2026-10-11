# Create the vault when the first secret is saved

- **Branch:** `feat/vault-on-first-secret`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

A fresh install no longer opens with a "create vault" dialog. Portique goes straight to the app, and asks for a master password the first time you save something secret: a password, a key, a passphrase or an API token. If you answer "Not now", that save is cancelled and nothing else changes.

## Why

The wall came before the user had seen anything, and it asked them to protect a file that had nothing in it. Profiles hold no secrets, so plenty of people connect with a typed password and never need a vault. Supported by [ADR-0003](../adr/0003-secrets-never-read-back.md): the interface already treats the vault as write-only storage, so creating it late changes nothing about how secrets are read.

## What changed

- `vault.rs`: with no `vault.bin`, `get`, `contains` and `delete` answer "nothing" instead of "locked". `set` still fails as locked, which is what starts the create dialog. A new test covers both.
- `session.rs`: a session asks for an unlock only if a vault exists and is locked.
- `vault-ui.ts`: the create dialog says why it appeared and has a **Not now** button (and Escape). Declining rejects the pending save with a plain message. New `unlockIfExists` (startup) and `lockNow` (button and palette command). *Change master password…* explains there is no vault yet instead of failing.
- `main.ts`: startup unlocks only an existing vault; the 🔒 button stays hidden until a vault exists.
- ADR-0020, a line in *Standing decisions*, and the user guide's vault entry.

## How to review

Read `vault.rs` (`absent`) then `ensureUnlocked` in `vault-ui.ts`. The path to check is: save a profile with a password on a clean data directory, expect the dialog, then repeat and choose Not now.

## What was tested

`npx tsc --noEmit`, `npm run lint` (0 errors), `npx vitest run` (154 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (164, including the vault test for "no vault yet"). Rebuilt on top of the vault hardening (sealed secrets, rollback counter, raw-byte password path): `get`, `contains` and `delete` keep `dev`'s sealed-secret code and add the "no vault yet" answer in front of it.

In headless Chromium against a mocked backend, dark look: a fresh install opens on the empty sidebar with no dialog and no lock button; generating the first key (a secret write) opens *Create vault* with the "you are saving a secret" wording and a *Not now* button.

**Not run:** the real backend from a window (the browser used a mock; the vault behaviour is covered by the unit test), choosing *Not now* and then retrying, the Escape path, a light look, and the profile editor's "not saved" path with a real password.

## Not done / follow-ups

- A `vault.bin` that is deleted or not synced reads as a fresh install: the person sees no saved passwords and is offered a new vault on the next secret. The rollback note (`vault.seen`) would let the app say "a vault was here before"; not done here.
- The profile editor shows the "not saved" error inside its own dialog; a friendlier inline note is possible.
- Encrypting the profile list as well: see D2.

## Decisions

### D1. Create the vault when the first secret is saved

- **Status:** accepted, recorded as [ADR-0020](../adr/0020-vault-created-on-first-secret.md)
- **Context:** The vault was required at launch, before any secret existed.
- **Decision:** A missing vault reads as empty; the first write creates it, after a prompt that explains itself and can be declined.
- **Consequences:** First launch is friction-free. Anything that stores a secret must go through `guarded`. A user who never saves a secret never has a vault.
- **Alternatives considered:** Keep the upfront prompt (the wall). Make a vault silently with a random key (no protection from a disk reader, and the user could not move it).

### D2. Only secrets are encrypted; the profile list stays plain

- **Status:** accepted
- **Context:** Host names, user names and ports are also somewhat sensitive. Password managers encrypt everything; OpenSSH and most terminal clients keep the host list in plain text.
- **Decision:** Keep `profiles.json` readable. Imports, search, the palette and backups all work without an unlock, and no one has to type a master password to see their own host list.
- **Consequences:** Someone reading the disk can see which hosts you use, though not any credential. An "encrypt everything" option can be added later; it would bring back an unlock at launch for those who choose it.
- **Alternatives considered:** Encrypt everything by default: strongest, but it returns the launch prompt and makes imported or hand-edited profiles harder.
