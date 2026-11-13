# Type the saved password into a terminal

- **Branch:** `feat/type-saved-password`
- **PR:** (not opened yet; pushed after working hours)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

**Ctrl+Shift+S** (or *Type the saved password* in the palette) types the focused terminal's profile's saved password, then Enter, into the session. It is meant for `sudo` and `su` prompts on a box you already saved a password for. A dialog naming the profile always appears first; Enter confirms and Esc cancels.

## Why

A saved password only helped at login. The next password prompt, usually `sudo`, meant typing it by hand even though Portique held it.

Supported by [ADR-0003](../adr/0003-secrets-never-read-back.md), [ADR-0014](../adr/0014-secrets-sealed-in-memory.md) and [ADR-0015](../adr/0015-keys-pinned-and-process-hardened.md): the password is read in Rust and sent to the session there, so the page never holds it. Related to [ADR-0012](../adr/0012-server-changes-show-their-command-first.md), which says no *server tool* enters a password. This is not a tool: the person asks for it, in their own terminal, and sees a confirmation. It does not conflict, and ADR-0012 itself points people at the terminal for a password. The interface stays quiet (a shortcut and a palette entry, no new button). No record conflicts.

## What changed

- `lib.rs`: new `session_type_password(id, profile_id)`. It reads the vault entry, sends the password and `\r` to the session as input, and returns false when the profile has no password saved. `password_keystrokes` builds the bytes and has two unit tests.
- `api.ts`: `typePassword` wrapper.
- `terminal-tab.ts`: `typeSavedPassword()` shows the dialog (primary button focused), then calls Rust. It takes the keyboard from an agent first, like any typing. If the profile has no password it says so instead.
- `main.ts`: Ctrl+Shift+S, and a *This tab* palette entry for a connected, non-quick SSH or Telnet profile. `help.ts`: a row in the shortcuts panel.
- Docs: `using-portique.md`, `command-palette.md`, ADR-0021 and its line in `AGENTS.md`.

## How to review

Start at `session_type_password` in `src-tauri/src/lib.rs`, then `typeSavedPassword` in `src/terminal-tab.ts`. Look hardest at the order in the second: nothing reaches Rust until the dialog's button is pressed, and a changed session id cancels it.

## What was tested

- `cargo test --lib` (172 passed), `cargo clippy --all-targets -- -D warnings`, `npx tsc --noEmit`, `npm run lint` (0 errors) and `npm test` (154 passed).
- Built the bundle and drove it in headless Chromium with a mocked backend: the shortcut opens the dialog with *Type password* focused and nothing sent yet; pressing it calls `session_type_password` once; Esc closes the dialog and sends nothing; a profile with no saved password gets an *OK* notice and sends nothing.
- Not run: the real backend against a real vault and SSH server (so not seen reaching a real `sudo` prompt), a Windows build, a light theme, a Telnet session.

## Not done / follow-ups

- No separate *sudo password* per profile. Servers whose `sudo` password differs from the login password still need the terminal.
- No detection of a password prompt to skip the dialog; ADR-0021 records why it always asks.
- The hotkey is fixed (Ctrl+Shift+S), not configurable.

## Decisions

### D1. Always ask before typing, and let Rust do the typing

- **Status:** accepted, recorded as [ADR-0021](../adr/0021-saved-password-typed-after-confirmation.md)
- **Context:** Typing a password into a prompt that is not asking for one shows it on screen and puts it in shell history, or sends it to an editor or a chat client. A page that could read the password could also leak it.
- **Decision:** The dialog appears on every use and names the profile. `session_type_password` reads the vault and writes to the session in Rust.
- **Consequences:** One extra Enter per use, and the password never reaches the page. Nothing in the app can type it without the dialog.
- **Alternatives considered:** Typing straight away is a single key but nothing stops a slip. Showing the dialog only when the last output is not a password prompt is quicker for `sudo` but trusts text a server controls. Letting the page fetch the password breaks ADR-0003.
