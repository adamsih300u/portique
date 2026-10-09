# ADR-0007: Nothing merges into `main` or `dev` without the maintainer's approval

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`merge-approval`](../changes/merge-approval.md) (D1)
- **Superseded by:** none

- **Context:** The maintainer is the only collaborator, and GitHub does not let an author approve their own PR.
- **Decision:** One required approval, with the admin role as a bypass actor in pull-request mode.
- **Consequences:** Contributors need the maintainer's approval. The maintainer can still merge their own PRs. Anyone holding the maintainer's token could bypass, hence the agent deny rules.
- **Alternatives considered:** No bypass (blocks the maintainer until a second reviewer exists).
