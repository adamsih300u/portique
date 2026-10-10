# Terminal font override

A profile can now pick its terminal font whatever the theme is. The theme's font is only a default.

## What changed

- The profile's Font field is an optional override. Empty ("Theme default") means: use the theme's font, else the stock monospace stack.
- Choosing a theme no longer rewrites the Font field. (Before, picking SGI IRIX overwrote the font you had typed.)
- The font list gained a few open-licensed families (they must be installed on the machine; none are bundled).

## Decision: empty means "follow the theme"

- **Status:** accepted
- **Context:** profiles stored a concrete font string, copied from the theme when it was picked, so a theme change and a user choice were indistinguishable.
- **Decision:** `appearance.fontFamily` is the override. Empty, or the stock default string older builds saved, counts as no override. `effectiveFont()` in `src/themes.ts` resolves override, then theme font, then stock default.
- **Consequences:** no data migration and no Rust change. Existing profiles that saved the stock default follow their theme. A profile that saved a theme's font (for example the IRIX one) keeps it as an explicit override. Typing the full stock string by hand is the same as "Theme default".
- **Alternatives:** a separate nullable field (needs a store migration); remembering fonts per theme id (more state for little gain).
