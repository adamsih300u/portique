# Duplicate a profile, and create several in a row

- **Branch:** `feat/duplicate-profile`
- **PR:** (not opened yet; pushed after working hours)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

Right-click a profile → **Duplicate…** opens the editor filled in from it, named "<name> copy". The new-profile editor now has **Create + Add Another**: it saves the profile and reopens the editor filled from the one you just made, with the name cleared. Both make a run of similar profiles (a rack of switches, a set of hosts in one group) quick to enter.

## Why

Most people add profiles in batches that differ by a name and an address. Retyping the group, user, key, jump host, forwards, theme and font for each one is the slow part.

Supported by the standing decision to keep the interface quiet: the entry lives in the existing right-click menu, and the extra button appears only in the create dialog. [ADR-0003](../adr/0003-secrets-never-read-back.md) constrains how the saved password is copied (D2). No record conflicts.

## What changed

- `editors.ts`: `editProfile` takes `{ template, name, onSaved }`. A template pre-fills a new profile (id cleared, so it saves as a new one). New and duplicate dialogs show *Cancel*, *Create + Add Another* and *Create*; editing an existing profile still shows *Cancel* and *Save*.
- `main.ts`: *Duplicate…* in the menu of every profile (terminal and API). `created()` refreshes the sidebar after each save, so rows appear as you go.
- `lib.rs`, `api.ts`: new `copy_password` command.
- A duplicate also carries the profile's saved commands, since they are part of the profile.

## How to review

Start at `editProfile` in `src/editors.ts`, then `duplicate()` in `src/main.ts`.

## What was tested

- `cargo check` passes. `npx tsc --noEmit` reports nothing in the changed files; its one error is that `vitest` is missing from this machine's shared `node_modules` (not from this change).
- Built the bundle and drove it in headless Chromium with a mocked backend: menu entry, prefilled title, name, host, port and group, password copy, *Create + Add Another* twice in a row, blank-name rejection, and that editing shows only *Save*. All passed.
- Not run: the real backend (`copy_password` against a real vault), a Windows build, a light theme, an API-connection duplicate end to end.

## Not done / follow-ups

- No keyboard shortcut or command-palette entry for Duplicate.
- A duplicated API connection copies its settings only (D3).

## Decisions

### D1. Create + Add Another reopens the editor filled from the profile just saved

- **Status:** accepted
- **Context:** "Add another" could clear the form or keep it. This feature exists for profiles that resemble each other.
- **Decision:** Keep everything except the name, which is cleared and focused. The group, user, key, jump host and so on carry over.
- **Consequences:** Batches of similar profiles take a name and an address each. Someone wanting a blank form uses Cancel and *New profile…*. The button shows only when creating, never when editing.
- **Alternatives considered:** A blank form repeats the slow part. A "keep fields" checkbox adds clutter.

### D2. A duplicate copies the saved password inside Rust

- **Status:** accepted
- **Context:** Hosts in a batch often share a login. The interface cannot read a password back ([ADR-0003](../adr/0003-secrets-never-read-back.md)).
- **Decision:** `copy_password(from, to)` copies the vault entry in Rust. The password box shows "leave blank to copy it", and a checkbox opts out. Nothing is copied for API connections, or for SSH profiles using only a key.
- **Consequences:** The secret never reaches the page. One new command to keep. Typing a password in the box replaces the copy.
- **Alternatives considered:** Leaving the password out means retyping it for every copy. Returning it to the page breaks ADR-0003.

### D3. A duplicated API connection copies its settings, not its requests or environments

- **Status:** accepted
- **Context:** An API connection's settings are in its profile; its requests and environments are in `api.json` ([ADR-0001](../adr/0001-api-endpoint-is-a-profile.md)), and secret environment values are in the vault.
- **Decision:** Duplicate copies the profile only.
- **Consequences:** The copy is a clean connection to the same kind of endpoint. Copying requests would also mean copying vault secrets per environment.
- **Alternatives considered:** A deep copy is a larger change and belongs in its own branch if wanted.
