# Let the terminal run to the bottom edge when maximised, with the text kept clear

- **Branch:** `fix/maximized-text-inset`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (for Adam)

## Summary

The earlier fix (`maximized-bottom-inset`) shrank the whole app when maximised on Windows. That cleared the taskbar but left a black strip under the terminal and stopped the terminal short of the window edge. Now the terminal and sidebar stay full-bleed and only their contents are padded up by the overshoot.

## Why

The terminal should reach the bottom of the maximised window; only the text needs room. Supersedes the "shrink `#app`" approach in [maximized-bottom-inset](maximized-bottom-inset.md).

## What changed

- `src/styles.css`: `#app` is full height again. `.term-host` bottom padding is `4px + --inset-bottom` (a little breathing room, plus the overshoot); `aside` gets the same inset so its footer stays reachable.
- `src/terminal-tab.ts`: the host takes the terminal theme's background, so the padding looks like part of the terminal rather than the app background. Re-applied when the profile is edited.
- `src/window-controls.ts`: comment only. The measurement is unchanged.

## How to review

Look at the `.term-host` and `aside` rules, then `paintHost` in `src/terminal-tab.ts`. The xterm fit addon already subtracts the host's padding, so no refit change was needed.

## What was tested

`tsc` shows only the missing-`vitest` errors that the shared `node_modules` always gives. **Not run on Windows**, where the bug shows.

## Not done / follow-ups

Only terminal tabs and the sidebar get the inset. The file, API and HTTP tabs may still sit partly behind the taskbar when maximised. It still assumes a bottom taskbar.

## Decisions

### D1. Pad the contents instead of shrinking the app

- **Status:** accepted; supersedes D1 of `maximized-bottom-inset`
- **Context:** Shrinking `#app` exposed the window background and shortened the terminal relative to the tab bar.
- **Decision:** Keep every surface full-bleed and inset only the content that must stay visible.
- **Consequences:** No stray strip, and the terminal reaches the window edge. Each surface that holds important bottom content needs the inset.
- **Alternatives considered:** Painting a matching background under the shrunk app (still leaves the terminal short of the edge).
