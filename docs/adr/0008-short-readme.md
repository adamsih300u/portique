# ADR-0008: The README stays short and links to `docs/`

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`repo-guides`](../changes/repo-guides.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** The README had grown into the manual, the build guide and the release process at once, and was too long to skim.
- **Decision:** The README says what Portique is and where to read more. The feature tour lives in `docs/using-portique.md` and contributor material in `CONTRIBUTING.md`.
- **Consequences:** The README reads in a minute. Each piece of information needs a home in the right file, and links between files need upkeep.
- **Alternatives considered:** A long README with a table of contents is still long.
