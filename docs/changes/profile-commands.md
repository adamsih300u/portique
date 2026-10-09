# Saved commands for each profile

- **Branch:** `feat/profile-commands` (stacked on `feat/palette-quick-connect`)
- **PR:** (draft, see GitHub)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

A profile can keep a list of commands. While one of its terminal tabs is connected, they appear in the command palette under the profile's name. Choosing one types it into the focused pane, and presses Enter unless the command is set to *Type only*. `{{name}}` in a command asks for a value first.

## Why

People repeat the same few commands on the same host (`docker ps`, a log tail, a service restart). The palette already finds hosts and actions, so it is the natural place to find these without leaving the keyboard. This follows the standing decision to keep the interface quiet: the editor section is collapsed, and there is no new button in the terminal. It builds on [palette-quick-connect](palette-quick-connect.md), which added the palette's `dynamic` hook; saved commands do not use it, since they do not depend on the typed text.

[ADR-0003](../adr/0003-secrets-never-read-back.md) constrains this change: it is why commands are *not* kept in the vault (see D1).

## What changed

- `Profile.commands` in `store.rs` is opaque JSON, as `api` is; the frontend owns the shape (`src/saved-commands.ts`: `id`, `name`, `text`, `mode`). Older profiles have none.
- `editors.ts` adds a collapsed *Saved commands* section to the profile editor (hidden for API connections).
- `main.ts` lists the focused pane's commands in the palette when it is connected, and `runSavedCommand` asks for any `{{values}}` first.
- `TerminalTab.typeCommand` sends the text as a paste, so a multi-line command is safe in a shell that supports bracketed paste.

## How to review

Start with `saved-commands.ts` and its tests, then `runSavedCommand` and `typeCommand`.

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (28 tests), `npm run build`, `cargo test --lib` (29 passed, 4 ignored as before). **Not run:** the app, a real SSH or Telnet session, Windows, the editor section on a light look.

## Not done / follow-ups

- Commands for every profile ("global" commands) and toolbox commands such as a name lookup are separate branches. The palette's `dynamic` hook is ready for the latter.
- No import or export of commands, and no reordering: they list in the order they were added.
- *Run* does not ask for confirmation; use *Type only* for anything destructive.
- The palette hides a profile's commands until its session is connected, rather than showing them greyed out.

## Decisions

### D1. Commands are plain profile data, not vault secrets

- **Status:** accepted
- **Context:** The first proposal was to store commands in the encrypted vault, since a command can carry a token. [ADR-0003](../adr/0003-secrets-never-read-back.md) says the interface can write a secret but never read it back. A command has to be shown, edited and typed by the interface, so it cannot be a vault secret.
- **Decision:** Commands are saved in `profiles.json` beside the host name. The editor says so and tells people to keep passwords out.
- **Consequences:** Commands show in backups and exports of `profiles.json`. Nothing stops someone pasting a secret in; the note is the only guard.
- **Alternatives considered:** Vault storage means the interface could not list them. A `{{secret}}` placeholder filled by Rust, as API environments do, is a larger change and fits a later branch.

### D2. Run and Type only are per command

- **Status:** accepted
- **Context:** Some commands are safe to fire (`uptime`), others should be read first.
- **Decision:** Each command has a mode: *Run* presses Enter, *Type only* leaves the text on the line.
- **Consequences:** One setting stands in for a confirmation dialog, so there is none to click through.
- **Alternatives considered:** A separate "confirm" flag adds a dialog to every run of a command that was already marked risky.
