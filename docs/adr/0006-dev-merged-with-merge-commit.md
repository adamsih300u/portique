# ADR-0006: `dev` is merged into `main` with a merge commit

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`dev-prereleases`](../changes/dev-prereleases.md) (D2)
- **Superseded by:** none

- **Context:** The prediction counts commits reachable from `dev` but not from the last tag. A squash merge makes new commits on `main` and leaves the `dev` ones unreleased in git's eyes.
- **Decision:** Merge `dev` into `main` with a merge commit. PRs into `dev` are still squashed.
- **Consequences:** The next version stays right with no back-merge of `main`. The merge setting is a convention, not enforced.
- **Alternatives considered:** Squash with a back-merge (every release needs a manual step).
