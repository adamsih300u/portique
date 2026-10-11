# ADR-0009: Italic is for the app's voice only

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`typography`](../changes/typography.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0005 (supports: styles use variables, and this adds `--mono` and the `--fs-*` sizes)

- **Context:** Italic had spread to eight places, including buttons and labels, where thin italic Cormorant at 14 to 15px was hard to read and said nothing.
- **Decision:** Serif italic appears on the wordmark, the tagline and empty-state or placeholder messages. Controls, titles and category labels are upright; category labels are serif small-caps. A sans italic marks an unsaved draft. Interface monospace is `--mono`.
- **Consequences:** Italic carries meaning again. A new button or label is upright, and a new italic must fit this list.
- **Alternatives considered:** Italic on small labels is too thin to read. No italic anywhere loses the one place the brand's tone shows.
