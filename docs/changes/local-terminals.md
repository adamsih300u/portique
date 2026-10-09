# Local terminals: shells on this computer as tabs

- **Branch:** `feat/local-terminals`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Settings has a new *Local terminals* section. Turn on *Show local terminals* and tick the shells you want: Portique lists them under *Local* in the sidebar and in the command palette, and each opens in a tab like an SSH session. On Windows it finds PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and every WSL distribution; on Linux and macOS it reads `/etc/shells`. The feature is off until the user turns it on.

## Why

The request: "a 'local' terminal; e.g., cmd on Windows or PowerShell, or even WSL, along with local terminal on Linux", switched on in settings with a choice of which. It fits the existing shape: a protocol module that takes input, resize and close, and streams bytes to xterm.js.

Constrained by [ADR-0005](../adr/0005-interface-follows-the-look.md) (the new icon and sidebar section use the interface variables, `--ok` for the icon) and the standing "interface stays quiet" rule (no new buttons: a settings section, a sidebar group and palette entries only). It follows the quick-connect precedent of in-memory profiles resolved in `store::get_profile` ([palette-quick-connect](palette-quick-connect.md)). No record conflicts. D1 became [ADR-0010](../adr/0010-local-shells-start-by-id.md).

## What changed

- **`local.rs` (new):** finds shells (`/etc/shells` plus `$SHELL`; on Windows the five kinds above, with `wsl.exe -l -q` decoded from UTF-16) and runs one on a pseudo-terminal with the `portable-pty` crate (ConPTY on Windows). Resize, input and close use the same `Ctl` messages as the other protocols. The shell starts in the home folder with `TERM=xterm-256color`.
- **`store.rs`, `session.rs`:** `Protocol::Local`; `get_profile` resolves `local:<id>` ids; a local session skips the vault-unlocked check, since it needs nothing from it.
- **`window.rs`, `lib.rs`:** settings `localTerminals` and `localShells`; commands `list_local_shells`, `list_local_terminals`, `set_local_terminals`; `save_profile` refuses local profiles.
- **Look per shell:** right-click a Local row (or use the palette while a local tab is focused) → *Appearance…* opens the same theme, font, cursor and scrollback form as the profile editor. `set_local_look` validates it (`Appearance::valid`) and keeps it in `settings.json` under `localLook`, by shell id. Zooming a local tab with Ctrl+wheel is remembered the same way, so every tab on that shell shares one look.
- **Interface:** a *Local* sidebar section (menu: open, split right, split below; no edit, delete or drag), palette entries under *Connect*, a prompt icon, the settings section, and tab restore for local tabs.
- **Docs:** `using-portique.md`, README line, code-layout tables, ADR-0010.

## How to review

Start with `local.rs` (`profile_for`, `pump`), then the three lines in `store::get_profile` and `session::start`. Look hardest at the gate: the interface sends only an id, and `profile_for` also checks the settings. `editors.ts` changed shape without changing behaviour: the profile editor's appearance block moved into `appearanceForm`, which the editor and the new local dialog share; check the profile editor still looks and saves the same. Left alone on purpose: the quick-connect code.

## What was tested

- `cargo test --lib`: 37 pass. New tests cover the saved look reaching a shell's profile (and other shells keeping the defaults), the look's range checks, shell-list parsing, the UTF-16 WSL list, the settings gate, a real `/bin/sh` on a PTY (input, a resize reaching the terminal, output, exit) and closing a running shell. The PTY tests ran three times in a row without flaking.
- `cargo clippy --all-targets -D warnings` clean for `local.rs`; `cargo check --target x86_64-pc-windows-gnu` compiles the Windows code paths.
- `tsc --noEmit`, `npm run lint` (0 errors), `npm test` (34) and `npm run build` pass.
- The interface in a headless browser with a mocked backend: settings section (preselects the usual shell, ticks, saves), the *Local* sidebar group, and a double-click calling `connect_session` with `local:bash`. Then the *Appearance…* dialog: it saves with the right id, and an already-open tab on that shell took the new font size at once. The profile editor still shows its theme field and preview after the refactor. I did not click through saving a profile from that editor.
- **Not run:** the real desktop app (no display here), anything on Windows or macOS (the Windows detection, ConPTY and `wsl.exe` paths are compiled but never executed), and PowerShell/WSL/Git Bash detection.

## Not done / follow-ups

- Windows and macOS need a real run before anyone relies on them. On Windows, ConPTY does not report the end of output when the shell exits, so `pump` waits up to 300 ms for the last bytes, then closes the console; look at this first if output goes missing at exit.
- The shell list is read when the settings pane opens and at start-up, so a shell installed later needs one of those.
- A tab title does not follow the shell's own title or working folder.

## Decisions

### D1. A local terminal starts from a shell Rust found, by id

- **Status:** accepted ([ADR-0010](../adr/0010-local-shells-start-by-id.md))
- **Context:** This is the first feature that runs a program on this computer, and the interface is a web view.
- **Decision:** The profile id is `local:<shell id>`; `store::get_profile` resolves it only for a detected shell the settings turn on. Local profiles are never saved.
- **Consequences:** The interface can open only the listed shells, and only once the user turned the feature on. No custom commands or arguments.
- **Alternatives considered:** A command stored in a profile makes `profiles.json` a launcher; a Tauri shell-plugin scope cannot say "whatever shells are installed".

### D2. Local terminals are separate from the saved profiles

- **Status:** accepted
- **Context:** The sidebar, palette and tab code all work from profiles. Putting synthetic ones in `profiles` would let them be edited, dragged into groups, deleted, or saved by font zoom.
- **Decision:** The interface keeps them in their own list (`localTerms`) and `findProfile` looks in both.
- **Consequences:** None of the profile-editing paths can touch them; each place that lists connections must include `localTerms` on purpose.
- **Alternatives considered:** Marking them read-only inside `profiles` needs every editing path to check the mark.

### D3. A local shell's look is kept in settings, by shell id

- **Status:** accepted
- **Context:** Local profiles are never saved, so there is no profile to hold a theme and font, yet people want each shell to look the way they set it.
- **Decision:** `settings.json` gets `localLook`, a map from shell id to the usual appearance fields. `local::profile_of` puts the saved look on the profile it builds; `set_local_look` validates and stores it. The dialog is the profile editor's own appearance form.
- **Consequences:** The look survives restarts and is shared by every tab on that shell. A shell that is turned off keeps its look for when it comes back. A look names a theme by id, so deleting that theme falls back to the default colours.
- **Alternatives considered:** Saving a real profile per shell breaks D2 and ADR-0010. One look for all local shells is simpler but cannot make PowerShell blue and a Linux shell green.

### D4. Off by default, with one preselected shell on first use

- **Status:** accepted
- **Context:** A Windows machine can offer six or more entries; a Linux one a handful. Showing them all unasked would clutter the sidebar.
- **Decision:** `localTerminals` defaults to false. Turning it on with nothing chosen ticks the usual shell (the first on Windows, `$SHELL` elsewhere).
- **Consequences:** The toggle does something visible straight away, and people add more from the list.
- **Alternatives considered:** Ticking everything is noisy; ticking nothing makes the toggle look broken.
