# Make the F1 shortcuts panel follow the interface theme

- **Branch:** `fix/help-panel-theme`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The F1 shortcuts panel always showed the default dark palette, whatever interface colours the user had chosen. It now takes the sidebar's colours, so it matches the rest of the interface.

## Why

Interface colours are applied as variable overrides on three regions (`aside`, `main`, `.tabbar`) in `applyChrome`, not on the page root. The panel was appended to `document.body`, outside all three, so its `var(--panel)`, `var(--line)` and `var(--text)` resolved to the root defaults. The panel opens over the bottom-left of the sidebar, so the sidebar's colours are the ones it should match.

No record in `docs/adr/` touches this.

## What changed

- `src/help.ts`: the panel is appended to `aside` (falling back to `document.body` if there is none) instead of straight to `document.body`. Its CSS is unchanged and it is still `position: fixed`.

## How to review

It is a one-line change. Open Settings, pick a light or custom sidebar colour, press F1, and check the panel matches the sidebar.

## What was tested

- `npx tsc --noEmit` passes.
- Checked by reading that nothing on `aside` (transform, contain, filter, will-change) changes how `position: fixed` resolves.
- Not run in the app: no display was available in this session.

## Not done / follow-ups

- Other overlays appended to `document.body` (such as the context menu) may have the same problem. They were not checked.

## Decisions

### D1. Mount the panel inside the sidebar instead of painting it separately

- **Status:** accepted
- **Context:** Colours are set per region, so anything outside a region gets the defaults. The panel is anchored over the sidebar footer.
- **Decision:** Append the panel to `aside` so it inherits the sidebar's variables.
- **Consequences:** The panel always matches the sidebar and needs no colour code of its own. If the panel is ever moved away from the sidebar, it will still show the sidebar's colours rather than the area it sits over.
- **Alternatives considered:** Calling the colour painter on the panel duplicates the region logic. Setting the variables on the page root would recolour every region that has no override of its own.
