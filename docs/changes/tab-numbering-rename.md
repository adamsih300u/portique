# Number, rename and reorder tabs

- **Branch:** `feat/tab-order`
- **PR:** #26
- **Status:** draft
- **Author:** Claude (for Adam)

## Summary

Terminal tabs on the same profile are numbered (`prod 1`, `prod 2`, …). Right-click a tab to rename it, and drag tabs to put them in a new order. Custom names and tab order come back after a restart and in saved workspaces.

## Why

Opening several tabs on one profile gave identical labels, so there was no telling them apart or keeping track of what each was for. Numbering fixes the default, renaming lets you label by purpose, and dragging lets you group related tabs.

## What changed

- `src/panes.ts`: a tab has an optional custom name and a derived number; its title shows the custom name, else the profile name plus the number. The custom name is stored as `n` on the root `Layout` node.
- `src/main.ts`: `renumber()` numbers tabs per profile in tab order (a lone tab keeps its plain name); "Rename tab…" and "Reset tab name" in the tab context menu; `dragReorder()` adds drag-to-reorder to every tab header.
- `src/styles.css`: a drop bar and faded style while dragging.

## How to review

Start with `Tab.title` and `layout()` in `panes.ts`, then `renumber()` and `dragReorder()` in `main.ts`. The saved layout format only gains an optional `n`; older data loads unchanged.

## What was tested

Type check and CI (lint, types, tests, clippy, Linux and Windows builds). Not run by hand in the app: no drag, rename or restore was exercised on a real window.

## Not done / follow-ups

- Rename and numbering apply to terminal tabs only; file-browser and API tabs keep their own labels.
- File and API tabs are not saved, so their position is not either.
- Numbering follows the focused pane, so a split tab whose focus moves to another profile can change its number.

## Decisions

### D1. Numbers are derived, names are stored

- **Status:** accepted
- **Context:** Numbering could be stored per tab or computed from the open tabs.
- **Decision:** Compute numbers from tab order each time; store only user-chosen names.
- **Consequences:** No stale numbers in saved data and nothing to migrate. Closing `prod 1` turns `prod 2` into `prod 1`; rename a tab for a label that never shifts.
- **Alternatives considered:** Persisting the number: stable labels, but gaps and collisions after a restore.

### D2. Rename and reorder stay out of the visible UI

- **Status:** accepted
- **Context:** The UI should stay uncluttered.
- **Decision:** Rename is a context-menu entry (plus a reset entry when relevant); reorder is plain drag with a thin drop bar. No new buttons.
- **Consequences:** Rename is only discoverable by right-clicking, like the other tab actions.
- **Alternatives considered:** Double-click to rename inline; rejected for now because it would compete with other tab gestures.
