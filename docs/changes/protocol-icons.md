# Show a connection's kind with an icon, not a swatch and a label

- **Branch:** `feat/protocol-icons`
- **PR:** https://github.com/adamsih300u/portique/pull/25
- **Status:** draft
- **Author:** Claude

## Summary

Each sidebar row now starts with a small icon for its kind of connection (SSH, Telnet, Serial, API, saved workspace) in place of a coloured square and an upper-case word on the right. The file browser and API tab headers use the same icons instead of the `SFTP` and `API` text badges.

## Why

The square was the profile's terminal theme (its background, with the theme's blue as the border), not a marker of the protocol, so an SSH, a Telnet and a Serial profile that shared a theme looked identical. The protocol was only in the word at the right. One icon says the same thing at a glance, frees the right-hand column and fits the quiet interface the maintainer asked for. [ADR-0005](../adr/0005-interface-follows-the-look.md) supports this: the tints are the existing `--info`, `--warn`, `--violet` and `--accent` variables, so they follow each look and keep their contrast.

## What changed

- New `src/proto-icon.ts`: five connection glyphs plus a folder (SFTP) and a grid (workspace), drawn as 16 px strokes in `currentColor`, built with `createElementNS`. Each carries its name as a tooltip and `aria-label`.
- `src/main.ts`: profile and workspace rows use the icon; the theme lookup in `profileRow` and the protocol word are gone. The workspace row keeps its "N tabs" count, which is information, not a label.
- `src/file-tab.ts`, `src/api-tab.ts`: the text badge becomes the icon.
- `src/styles.css`: `.pi` rules and per-kind tints; the old `.dot`, `.dot.ws`, `.dot.api` and the two text-badge rules are removed.
- `docs/using-portique.md`: one bullet describing the icons.

## How to review

Start with `proto-icon.ts` (the glyph paths), then the three one-line call sites. Look at the tints in a light look.

## What was tested

- `npx tsc --noEmit`, `npx eslint .` (0 errors; the warnings were there before), `npm test` (20 passed) and `npm run build` all pass.
- Rendered the icons on the real stylesheet in headless Chromium, once with the dark Portique variables and once with a light look's, including the right-clicked row and both tab badges. They read clearly and keep their contrast in both.
- Not run: the full app under Tauri, the other bundled looks, and the Large text size (the icon is a fixed 16 px, so it does not scale with it).

## Not done / follow-ups

- The profile's terminal theme is no longer visible in the sidebar; it is still shown in the profile editor and in the tab itself.
- Terminal tab headers have no protocol marker today and were left alone.

## Decisions

### D1. Tint by protocol, from the semantic colour variables

- **Status:** accepted
- **Context:** The old square carried the theme colour, which says nothing about the connection. The icon needs a colour that separates kinds without clashing with the look.
- **Decision:** Shape is the primary signal; the tint reinforces it: SSH `--info`, Telnet `--warn`, Serial `--violet`, API `--accent`, workspace and SFTP `--muted`.
- **Consequences:** The tints follow every look through `chrome.ts` and keep its contrast. Colour is never the only cue, so it works for colour-blind users. `--warn` on Telnet echoes that Telnet is unencrypted, but a warning colour on every Telnet row means a row may read as a warning to some people.
- **Alternatives considered:** Tinting by the profile's theme (keeps the old information, but then colour no longer separates protocols); one neutral colour for all icons (quietest, but slower to scan).

### D2. Icons replace the text badges on the SFTP and API tabs too

- **Status:** accepted
- **Context:** The sidebar and the tab headers named the same things in two styles.
- **Decision:** Both use `protoIcon`, with the name in the tooltip.
- **Consequences:** One look everywhere. A new user has to hover to learn the folder icon means the file browser.
- **Alternatives considered:** Changing only the sidebar (smaller diff, but leaves two styles).
