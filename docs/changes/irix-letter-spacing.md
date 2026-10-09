# Add letter spacing to the SGI IRIX theme

- **Branch:** `fix/irix-letter-spacing`
- **PR:** not opened yet (held until after work hours)
- **Status:** draft
- **Author:** Claude

## Summary

Text in the SGI IRIX theme ran together, bold text especially. Themes can now carry a letter spacing and a line height, and the IRIX theme uses 1px and 1.1.

## Why

The IRIX font is a bitmap-style face whose glyphs fill their whole cell, so neighbours touch (`m`, `w`, bold). The terminal passed no spacing to xterm, so nothing separated the cells. No record in `docs/adr/` touches terminal fonts; the earlier IRIX theme work has no change file.

## What changed

- `Theme` in `src/api.ts` gets optional `letterSpacing` and `lineHeight`.
- The IRIX theme in `src/themes.ts` sets `letterSpacing: 1`, `lineHeight: 1.1`.
- `options()` in `src/terminal-tab.ts` passes them to xterm, only while the profile's font equals the theme's font.

## How to review

Start at `options()` in `terminal-tab.ts`. Nothing is stored in profiles, so nothing on disk changes.

## What was tested

`npx tsc --noEmit`: no errors in the changed files (the only error is the missing `vitest` module in the shared `node_modules`). Not run in the app: the effect on real glyphs, the WebGL against DOM renderers, and bold widths were not checked by eye.

## Not done / follow-ups

- The bold font file's advance width was not inspected; if bold still crowds, try `fontWeightBold: "normal"`.
- Values are a first guess; tune by eye.
- No editor field for spacing, to keep the interface quiet.

## Decisions

### D1. Spacing belongs to the theme and applies only with the theme's font

- **Status:** accepted
- **Context:** Spacing is a property of a font, but a profile can pick any font while using the IRIX colours.
- **Decision:** Store spacing on the theme and apply it only when the profile's font equals the theme's font.
- **Consequences:** No change to `Profile` (shared with Rust) or to saved data. A user who changes the font loses the spacing, which is correct for a different font.
- **Alternatives considered:** Spacing fields on the profile's appearance (needs Rust changes and a migration); always applying it with the theme (wrongly widens other fonts).
