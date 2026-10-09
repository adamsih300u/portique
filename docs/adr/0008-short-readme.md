# ADR-0008: The README is short; detail goes in `docs/`

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`repo-guides`](../changes/repo-guides.md) (D1)
- **Superseded by:** none

- **Context:** The README had grown into the manual, the build guide and the release process at once, and nobody could skim it.
- **Decision:** The README says what Portique is and where to read more. The feature tour is `docs/using-portique.md`; contributor material is in `CONTRIBUTING.md`.
- **Consequences:** Easy to read first. Information has to be kept in the right file, and links between files need care.
- **Alternatives considered:** leave it long and add a table of contents (still not brief).
