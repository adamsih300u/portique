# A profile can override the theme's font family

- **Branch:** `feat/font-family-override`
- **PR:** #46
- **Status:** in review
- **Author:** Claude (for Adam)

## Summary

A profile can now pick its terminal font whatever the theme is. The theme's font is only a default: leave the Font field empty ("Theme default") and the theme decides; type a family and it wins.

## Why

Picking a theme such as SGI IRIX used to overwrite the Font field, and the profile stored a concrete font string either way, so a theme's font and the user's own choice looked the same. People want their favourite font on any theme.

## What changed

- `src/themes.ts`: `DEFAULT_FONT` and `effectiveFont()`, which resolves the profile's override, then the theme's font, then the stock stack.
- `src/terminal-tab.ts`, `src/panes.ts`, `src/main.ts`: use `effectiveFont()` instead of reading `appearance.fontFamily` directly. A theme's letter spacing still applies only while the theme's own font is the one in use.
- `src/editors.ts`: the Font field is empty by default with a "Theme default" placeholder; choosing a theme no longer rewrites it (it still sets the theme's font size). The suggestion list gained IBM Plex Mono, Inconsolata, Iosevka, Roboto Mono, Noto Sans Mono, Geist Mono and Intel One Mono. They are suggestions for fonts the person has installed; nothing new is bundled.

## How to review

Start with `effectiveFont()` in `src/themes.ts`, then the theme-change handler in `src/editors.ts`. No Rust or stored-data changes.

## What was tested

Type check and lint/tests/clippy/build run in CI. I did not run the app by hand, so the editor flow (pick IRIX, type a font, switch theme) is untested on screen.

## Not done / follow-ups

- No font is bundled beyond Irix Screen Mono and Cormorant Garamond. Bundling a few OFL monospace families (JetBrains Mono, IBM Plex Mono, Source Code Pro) would be a separate branch with notices in `THIRD-PARTY-NOTICES.md`.
- The font-size field still follows the theme; only the family became an override.

## Decisions

### D1. An empty font field means "follow the theme"

- **Status:** accepted
- **Context:** profiles stored a concrete font string, copied from the theme on pick, so a user's choice and a theme default could not be told apart.
- **Decision:** `appearance.fontFamily` is the override. Empty, or the stock default string older builds saved, counts as no override.
- **Consequences:** no migration and no Rust change. Old profiles that saved the stock default now follow their theme. A profile that saved a theme's font (for example IRIX) keeps it as an explicit override. Typing the full stock string by hand is the same as "Theme default".
- **Alternatives considered:** a separate nullable field (needs a store migration); remembering a font per theme id (more state for little gain).
