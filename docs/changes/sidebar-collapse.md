# Sidebar: hide it, or drag it to the width you like

- **Branch:** `feat/sidebar-collapse`
- **PR:** not pushed yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Ctrl+Shift+B hides the sidebar so the tabs use the full window width, and brings it back. Dragging the sidebar's right edge resizes it; double-clicking the edge resets it. The width can't go below the longest group or profile name, and the choice is remembered.

## Why

Terminals and, later, remote views want the whole window. A fixed 250px column gave no way to reclaim it, or to make long profile names fit.

## What changed

- `src/sidebar-layout.ts` (new): collapse state, drag handle, minimum-width measurement, saved state.
- `src/styles.css`: the sidebar column reads `--side-w`; a `side-hidden` class collapses it; the drag handle and an off-screen ruler used for measuring.
- `src/main.ts`: wires it up. Shortcut `Ctrl+Shift+B`, a checked "Sidebar" item in the "⋯" menu, a command-palette entry, and a refit when the list or the interface scale changes.
- `src/help.ts`: the two new lines in the shortcuts list.
- `src/sidebar-layout.test.ts`: the width limits and the saved-state parser.

## How to review

Start with `initSidebar` in `src/sidebar-layout.ts`, especially `minWidth()`.

## What was tested

`tsc --noEmit`, `eslint .` (no errors; existing warnings only) and `vitest run` (26 pass), on Linux. **Not run:** the app itself, so the drag feel, the measured minimum with real fonts, and the large interface scale are unchecked by eye; Windows and macOS.

## Not done / follow-ups

- Folded groups don't exist on `dev` yet (they live on `worktree-collapse-groups`). The minimum is computed from every profile, group and workspace name rather than from what is drawn, so it already holds once groups can fold. Worth a look when that branch lands.
- No button brings the sidebar back, by design. The "⋯" menu is inside the sidebar, so while it is hidden only the shortcut and the command palette work. A hover strip at the left edge would be the next step if that proves too hidden.

## Decisions

### D1. The shortcut is Ctrl+Shift+B

- **Status:** accepted
- **Context:** Ctrl+B is tmux's prefix and moves the cursor in readline, so a terminal app must not swallow it.
- **Decision:** Ctrl+Shift+B, like the other app shortcuts, and reserved so a terminal never receives it.
- **Consequences:** Nothing a shell commonly uses is taken.
- **Alternatives considered:** Ctrl+B (conflicts as above); a permanent button (against the quiet-interface rule).

### D2. The minimum width comes from all names, measured

- **Status:** accepted
- **Context:** The sidebar must never be narrower than the longest name, even when a search or a folded group hides it.
- **Decision:** Lay out an invisible copy of every group and row with the real classes and read its width, plus the scrollbar. Limits are in unscaled pixels so the interface scale still applies.
- **Consequences:** Accurate with any font or scale. If a longer name appears, the sidebar grows to fit it.
- **Alternatives considered:** Estimating from character counts (inexact with proportional and small-caps fonts).

### D3. State lives in the browser's local storage

- **Status:** accepted
- **Context:** It is a per-window layout convenience, and the same pattern is used for the palette's recent items and the last local folder.
- **Decision:** One `portique.sidebar` key, failures ignored.
- **Consequences:** No Rust or settings-file change. It isn't part of exported settings.
- **Alternatives considered:** A `Settings` field (needs Rust, `set_prefs` and the settings dialog changes for little gain).
