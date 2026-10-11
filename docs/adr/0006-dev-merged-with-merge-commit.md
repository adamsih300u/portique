# ADR-0006: `dev` merges into `main` with a merge commit

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`dev-prereleases`](../changes/dev-prereleases.md), decision D2
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** The version prediction counts commits reachable from `dev` and absent from the last tag. A squash merge creates new commits on `main` and leaves the `dev` commits unreleased as far as git can tell.
- **Decision:** Merge `dev` into `main` with a merge commit. PRs into `dev` are still squashed.
- **Consequences:** The predicted version stays correct without a back-merge of `main`. The merge setting is a convention that GitHub does not enforce.
- **Alternatives considered:** Squashing with a back-merge adds a manual step to every release.
