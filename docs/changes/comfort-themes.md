# Bundle four soft terminal themes: Ambre doux, Everforest Dark, Kanagawa, Gruvbox Light

- **Branch:** `feat/comfort-themes`
- **PR:** https://github.com/adamsih300u/portique/pull/78
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Four new built-in terminal themes for long sessions. **Ambre doux** is Amber at about 80% brightness. **Everforest Dark** (sage and beige), **Kanagawa** (parchment on ink blue) and **Gruvbox Light** (dark brown on cream, for daytime) are well-known palettes. They're chosen like any other theme.

## Why

Amber was singled out as easy on the eyes: a warm colour on a near-black background, with no bright white and few hues. The bundled set had nothing else like that, and only one light theme (Portique Ivoire). Terminal themes don't colour the rest of the interface, so [ADR-0005](../adr/0005-interface-follows-the-look.md) still holds.

## What changed

- `src/themes.ts`: four entries in `BUILTIN_THEMES`, after Amber.
- `docs/using-portique.md`: one sentence naming them.

## How to review

Read the colour lists. Everforest Dark and Kanagawa use their authors' terminal palettes. Everforest's bright colours are a small lift of its normal ones, because the original repeats them. Gruvbox Light is adapted (see D2).

## What was tested

- `tsc --noEmit` and `vite build`.
- WCAG contrast of every colour against its background:
  - Text: Ambre doux 6.8:1, Everforest 7.4:1, Kanagawa 11.3:1, Gruvbox Light 10.2:1.
  - Normal colours mostly at least 4.5:1. Ambre doux's red and blue slot were nudged up to clear it. Kanagawa's red (3.2:1) and Gruvbox Light's yellow (3.3:1) are the authors' values and were kept so the themes look as people expect.
  - Gruvbox Light's bright colours are 2.2 to 4.8:1, as in the original.
- Not looked at in the running app.

## Not done / follow-ups

- Zenburn and Rosé Pine were also suggested; easy to add the same way.
- Licences: Everforest (sainnhe), Kanagawa (rebelot) and Gruvbox (morhetz) are MIT. Like the existing Dracula, Nord and Gruvbox Dark entries, they're credited in a code comment, not in `THIRD-PARTY-NOTICES.md`.

## Decisions

### D1. Add a dimmer Amber rather than change Amber

- **Status:** accepted
- **Context:** Amber is liked as it is, but its full-brightness text is a lot at night.
- **Decision:** A separate "Ambre doux" theme, every colour scaled to about 80%, with red and the blue slot nudged up to 4.5:1.
- **Consequences:** Profiles already on Amber don't change.
- **Alternatives considered:** Dimming Amber itself (changes existing profiles); a brightness slider (new setting and UI).

### D2. Gruvbox Light uses dark text colours for black and the normal colours

- **Status:** accepted
- **Context:** Gruvbox Light's original terminal palette sets black to the cream background and uses mid-tone accents, so black text vanishes and several colours are hard to read on cream.
- **Decision:** Black is the dark text colour, white a light tan. Normal colours use Gruvbox's darker "faded" accents and the brights use its usual mid-tones.
- **Consequences:** It reads like Portique Ivoire, our other light theme. It is not a byte-for-byte copy of the original.
- **Alternatives considered:** The original palette (black text disappears).
