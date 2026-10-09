# ADR-0007: The maintainer approves every merge into `main` and `dev`

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`merge-approval`](../changes/merge-approval.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** The maintainer is the only collaborator, and GitHub does not let an author approve their own PR.
- **Decision:** Require one approving review, with the admin role as a bypass actor in pull-request mode. Agents hold deny rules for merging, approving and editing protection settings.
- **Consequences:** Contributors wait for the maintainer's approval, and the maintainer can merge their own PRs. Anyone holding the maintainer's token can bypass the rule, which the agent deny rules account for.
- **Alternatives considered:** Removing the bypass blocks the maintainer until a second reviewer exists.
