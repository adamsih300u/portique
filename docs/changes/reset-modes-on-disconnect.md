# Reset the terminal's modes when a connection drops

- **Branch:** `fix/reset-modes-on-disconnect`
- **PR:** (not opened yet; no GitHub sign-in in this session)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

After a dropped connection, moving the mouse or trackpad over the terminal typed strings of numbers (like `35;120;40M`) at the prompt. A program such as tmux, vim or htop had turned on mouse reporting; the connection died under it, so it never turned it off, and Portique went on reporting every mouse move to the new shell after the automatic reconnect. The tab now resets the terminal's input modes when a session is lost or ends.

## Why

Reported while docking and undocking a laptop, which changes the network and drops SSH connections. With auto-reconnect on, the new shell is a fresh login that knows nothing about mouse reporting, so it echoes the reports as text.

No record in `docs/adr/` touches this; [ADR-0018](../adr/0018-commands-finish-with-markers-in-the-open-shell.md) is unaffected because the reset only writes to the screen and sends nothing to the connection. No conflicts.

## What changed

- `terminal-tab.ts`: a `RESET_MODES` string written to the terminal (not the connection) on the `lost` status and in `ended()`, which covers a closed session, a failed or cancelled login and a stop to reconnecting. It leaves the alternate screen, turns off every mouse mode and encoding, focus reports, bracketed paste and application keys, and shows the cursor.

## How to review

Start at `RESET_MODES` and its two uses in `src/terminal-tab.ts`. The string is what a `reset` command clears for input, minus clearing the screen or scrollback.

## What was tested

- Headless Chromium with a mocked backend. A program turns on alternate screen, any-motion mouse tracking and the SGR encoding; five mouse moves send five mouse reports; the connection is reported lost; auto-reconnect makes a second session; five more mouse moves are made. Before the fix the new shell received 5 reports. After it, 0. The five during the live program are unchanged, so mouse support inside tmux or vim still works.
- `npx tsc --noEmit` clean, `npm run lint` 0 errors, `npm test` 154 passed.
- Not run: a real docking station, a real SSH server with tmux, Windows, or a manual **Enter** reconnect after `closed` (it goes through the same `ended()` write).

## Not done / follow-ups

- If a dock or undock does not drop the connection and the flood still happens, this is not the cause. Then a program is leaving mouse reporting on while the connection stays up, and the next step is to see which one.
- A running program that was using the alternate screen is left on the normal screen after the reset, as `reset` would do. Its output is gone from view but not from scrollback.

## Decisions

### D1. Reset the screen's modes on the client when a session ends

- **Status:** accepted
- **Context:** The terminal's modes belong to the program running in it. When the program's connection dies, nothing is left to turn them off, and the next shell inherits them.
- **Decision:** Portique writes a fixed reset sequence to its own terminal when a session is lost or ends, before the reconnect notice.
- **Consequences:** A reconnected shell starts with clean input modes. A fixed list must grow if a new mode causes the same trouble. Nothing is sent to the server.
- **Alternatives considered:** Calling xterm's full `reset()` would also clear the screen and scrollback the person may still want to read. Resetting only when the reconnect succeeds leaves the mouse flooding the "Reconnecting…" screen. Having Rust send a reset to the new shell on connect would put input into a session the person did not type into.
