# Drop a dragged tab in the empty tab-bar space to move it last

- **Branch:** `fix/tab-drop-at-end`
- **PR:** not open yet
- **Status:** draft
- **Author:** Claude (for Adam)

## Summary

When reordering tabs by drag, there was no way to put a tab after the last one. Dropping anywhere in the empty part of the tab bar now moves the dragged tab to the end.

## Why

Follow-up to [number, rename and reorder tabs](tab-numbering-rename.md): a drop was only recognised on another tab, and the last tab's "after" half is the only edge that could place a tab last, which is hard to hit.

## What changed

- `src/main.ts`: the tab bar accepts drops outside any tab and moves the dragged tab last, with the same drop bar shown on the right edge of the last tab. The move itself is now one shared `moveTab()`.

## How to review

`moveTab()` and the three tab-bar listeners just below `dragReorder()` in `src/main.ts`. Drops on a tab are unchanged.

## What was tested

Type check. Not run by hand in the app: no drag was exercised on a real window.

## Not done / follow-ups

None.

## Decisions

None.
