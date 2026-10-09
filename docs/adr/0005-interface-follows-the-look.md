# ADR-0005: Outside terminals the interface follows the interface look

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`api-roadmap`](../changes/api-roadmap.md) (D6)
- **Superseded by:** none

- **Context:** Under a light look, dialogs and menus stayed dark (they sit outside the themed regions) and the pastel status colours were unreadable (about 1.4:1).
- **Decision:** `chrome.ts` also paints the document root with the content look, and sets `--ok`, `--warn`, `--danger`, `--info`, `--violet` and the JSON colours per region, choosing a dark or a deeper set by the region's lightness. Styles use the variables.
- **Consequences:** Everything follows the look and stays at least 4.5:1 on the bundled looks. New colours that mean something must be added to that set rather than written as hex.
- **Alternatives considered:** per-component overrides for each dialog (easy to miss one); using the terminal theme (wrong by Adam's brief).
