# ADR-0005: The interface follows the interface look outside terminals

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`api-roadmap`](../changes/api-roadmap.md), decision D6
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** Under a light look, dialogs and menus stayed dark because they sit outside the themed regions, and the pastel status colours reached a contrast of about 1.4:1.
- **Decision:** `chrome.ts` paints the document root with the content look. It also sets `--ok`, `--warn`, `--danger`, `--info`, `--violet` and the JSON colours per region, choosing a dark or deeper set by the region's lightness. Styles use these variables.
- **Consequences:** Every surface follows the look and keeps at least 4.5:1 contrast on the bundled looks. A new colour that carries meaning joins the variable set and appears in styles through its variable.
- **Alternatives considered:** Per-component overrides for each dialog are easy to miss. The terminal theme conflicts with Adam's brief.
