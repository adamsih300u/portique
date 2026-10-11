# Keep the bottom of the window clear of the taskbar when maximised

- **Branch:** `fix/maximized-bottom-inset`
- **PR:** see the pull request for this branch
- **Status:** draft
- **Author:** Claude (for Adam)

## Summary

When maximised on Windows, the last row of the terminal could sit behind the taskbar. The app now shrinks by however far the window overshoots the screen's work area, so nothing is hidden.

## Why

The window is frameless (`decorations: false`). A maximised frameless window on Windows overshoots the work area by its invisible resize border, which pushes the bottom edge under the taskbar.

## What changed

- `src/window-controls.ts`: when the maximised state is synced, measure the overshoot (`screenY + innerHeight` against the work area's bottom) and store it in the `--inset-bottom` CSS variable. It resets to 0 when restored.
- `src/styles.css`: `#app` height is `calc(100% - var(--inset-bottom, 0px))`.

## How to review

Start with `syncInset` in `src/window-controls.ts`. It uses web APIs only, so no new Tauri permissions.

## What was tested

`tsc --noEmit` and `vite build` pass. **Not run on Windows**, where the bug shows, so the fix is unconfirmed there.

## Not done / follow-ups

It assumes a taskbar along the bottom edge. A taskbar on the top or a side is not handled. If the measurement proves unreliable across DPI scales, the alternative is to read the monitor work area through the Tauri window API.

## Decisions

### D1. Measure the overshoot at runtime instead of hard-coding a border size

- **Status:** accepted
- **Context:** The invisible border varies with Windows version and display scaling.
- **Decision:** Compare the window's bottom edge to the screen's available height and inset by the difference.
- **Consequences:** Self-correcting, but relies on `screen.availHeight` matching window coordinates in the webview.
- **Alternatives considered:** A fixed 8px inset (breaks on other scales); turning decorations back on (loses the custom title bar).
