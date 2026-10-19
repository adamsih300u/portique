# Add a Christmas look: "Noël" interface and "Portique Noël" terminal theme

- **Branch:** `feat/noel-theme`
- **PR:** https://github.com/adamsih300u/portique/pull/76
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Adds a seasonal Christmas look. **Noël** joins the interface looks (pine-green sidebar, cranberry top bar, gold accent), and **Portique Noël** joins the built-in terminal themes (snow-white text on pine, holly red, gold cursor). Pick them like any other look or theme; nothing changes automatically.

## Why

Requested: "would it be possible to have a Christmas UI theme?"

## What changed

- `src/chrome.ts`: new `Noël` entry in `PRESETS` (shows up in Interface colours… and as "Interface look: Noël" in the palette).
- `src/themes.ts`: new built-in `portique-noel` terminal theme.
- `docs/using-portique.md`: both names added to the lists.

## How to review

Two array entries. Look at the colours: the gold accent is from the laiton family, a little warmer.

## What was tested

- `tsc --noEmit` and `vite build`.
- Contrast of each ANSI colour against the `#0b1f16` background (WCAG): foreground 15:1, all normal colours at least 4.5:1; bright black is 2.3:1, as in the other dark themes.
- Not looked at in the running app or on Windows/macOS.

## Not done / follow-ups

- No automatic seasonal switching and no decorations (snowfall, emblem wreath); both add moving parts and clutter. Easy to add separately if wanted.

## Decisions

### D1. Opt-in look and theme, no seasonal automation or decorations

- **Status:** accepted
- **Context:** A Christmas look should be fun without fighting the uncluttered UI.
- **Decision:** Ship it as one more interface preset and one more built-in terminal theme, chosen by hand.
- **Consequences:** No new settings or code paths; the user switches back when the season ends.
- **Alternatives considered:** Auto-enable in December (surprising, needs an opt-out setting); CSS snowfall (distracting over a terminal, costs GPU).
