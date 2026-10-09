# Put the cursor in the terminal once a connection is up

- **Branch:** `fix/terminal-focus-on-connect`
- **PR:** not pushed yet (no pushes during work hours)
- **Status:** draft
- **Author:** Claude

## Summary

After double-clicking a profile and the connection succeeded, you had to click the terminal before typing. Now the terminal takes focus when the session reports "connected".

## Why

Focus was only requested when the tab was shown, which is before the connection finishes. A password or host-key dialog in between (or the sidebar row) left focus elsewhere.

## What changed

- `src/terminal-tab.ts`: on the `connected` frame, `takeFocusIfIdle()` focuses the terminal if the pane is visible and nothing else has focus.

## How to review

Look at `takeFocusIfIdle()`: it must never steal focus from a dialog, an input, or another pane being typed in.

## What was tested

`tsc --noEmit` passes for non-test sources. Unit tests not run (vitest is missing from the shared node_modules). Not run against a real server or by hand in the app.

## Not done / follow-ups

SFTP and API tabs were not touched.

## Decisions

### D1. Focus on "connected", only if focus is idle

- **Status:** accepted
- **Context:** Reconnects and background tabs also reach "connected"; grabbing focus there would interrupt typing elsewhere.
- **Decision:** Take focus only when the pane is on screen and `document.activeElement` is the body.
- **Consequences:** Dialogs and other panes keep focus; the common double-click path just works.
- **Alternatives considered:** Always focusing on connect (steals focus on auto-reconnect); focusing on dblclick only (misses the dialog case).
