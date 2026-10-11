# Make the typography simpler: italic for voice only, one monospace, fewer sizes

- **Branch:** `refactor/typography`
- **PR:** (not opened yet; held until after 5 PM)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

Portique's type had three roles (a serif display face, a sans interface face, monospace for data) but drifted at the edges. Italic appeared in eight unrelated places, three different monospace stacks were in use, and font sizes ran in half-pixel steps. This change keeps the three roles and tidies the edges. The "Keyboard shortcuts" button is no longer italic.

## Why

Italic should mean one thing. Its uses covered the wordmark, the tagline and empty-state messages (the app speaking), but also a button (`.help-link`), the command palette's mode chip and group tag, and the file browser's title. Those are controls and labels, and thin muted italic Cormorant at 14 to 15px is the hardest text in the app to read. Category names are serif small-caps on every surface, which gives the identity a rule worth keeping, so that part stays.

Supports [ADR-0005](../adr/0005-interface-follows-the-look.md) (styles use variables, not literals). It conflicts with no record. The "interface stays quiet" standing decision in `AGENTS.md` favours it.

## What changed

All in `src/styles.css`:

- **Italic removed** from `.help-link` (now the plain sidebar font), `.fm-title` (upright), `.pal-mode` and `.pal-tag` (now serif small-caps like the other category labels).
- **Italic kept** for the wordmark, the tagline, `.fm-note` and `.api-hint`, plus `.rail-row.draft .rail-name` (sans italic marks an unsaved draft; that is a state, not the app's voice).
- **`--mono`** replaces three monospace stacks (`monospace`, `ui-monospace, Consolas, monospace`, and the one that listed Cascadia Mono). The terminal's own font setting is untouched.
- **Size variables** `--fs-xs` (11), `--fs-sm` (12) and `--fs-label` (15) replace the repeated `calc(Npx * var(--s))` values. The 11.5 and 12.5px values became 11 and 12. Category labels that were 14px (`.fm-col`, `.pal-group`) are now 15px like the rest.

## How to review

Read the `:root` block at the top of `src/styles.css` first, then the diff. Most of it is mechanical substitution. Look hardest at the four italic removals and at the two half-pixel roundings, which move text by half a pixel at most.

## What was tested

`vite build` succeeds. `tsc --noEmit` reports only a missing `vitest` module in `src/http-model.test.ts`, because the shared `node_modules` I used lacks it; I changed no TypeScript. I did **not** look at the result in a running app or a browser (none was available here), so the visual outcome is unchecked, in particular the small-caps `.pal-mode` and `.pal-tag` and the large text scale (`--s: 1.2`) with the new variables.

## Not done / follow-ups

- Sizes outside the three variables (9, 10, 13, 14, 17 to 25, 52px) remain literals. They are display sizes or single uses, and tokens for them would not make the CSS clearer.
- Look at the app, with the light look and the large text scale, before merging.

## Decisions

### D1. Italic means the app is speaking

- **Status:** accepted
- **Context:** Italic was used for eight unrelated things, including controls, so it no longer meant anything and made small text harder to read.
- **Decision:** Serif italic is for the wordmark, the tagline and empty-state or placeholder messages. Controls, titles and category labels are upright. A sans italic marks an unsaved draft.
- **Consequences:** Italic is a signal again. New UI must use upright type for buttons and labels, and a new italic needs a reason that fits this rule.
- **Alternatives considered:** Keeping italic on small labels was rejected because Cormorant italic is thin at 14 to 15px. Removing italic everywhere would lose the one place the brand's tone shows.

### D2. One monospace variable and three text sizes

- **Status:** accepted
- **Context:** Three monospace stacks and half-pixel sizes made the same kind of text render differently from one tab to the next.
- **Decision:** Interface monospace uses `--mono`. Secondary, field and label text use `--fs-xs`, `--fs-sm` and `--fs-label`.
- **Consequences:** A text-size or font change is one edit. The terminal font stays a separate user setting. Half-pixel sizes no longer exist.
- **Alternatives considered:** A variable for every size would mostly name one-off values. Leaving the stacks alone keeps the drift.
