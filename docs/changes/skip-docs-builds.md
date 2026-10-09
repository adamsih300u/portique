# Skip builds when only docs or repo metadata changed

- **Branch:** `ci/skip-docs-builds`
- **PR:** https://github.com/adamsih300u/portique/pull/18
- **Status:** draft
- **Author:** Claude

## Summary

A pull request or a push to `dev` that only touches docs (a README edit, a change file) no longer runs the Linux and Windows builds, the lint/test/clippy checks, or publishes a dev prerelease. Anything else still does.

## Why

Every PR ran the full two-platform build and every push to `dev` published a prerelease, however small the change. Builds are the slow part of CI, and a README fix should not cost one or spend a `dev-build-N` number. Builds on [quality-gates](quality-gates.md) and [dev-prereleases](dev-prereleases.md).

## What changed

- New reusable workflow `.github/workflows/changes.yml`: diffs the change against its base (PR base, or the previous tip of `dev`) and outputs `code=true|false`.
- `ci.yml`: `checks` and `build` wait for it and are skipped when `code` is false. `pr-title` always runs.
- `dev-release.yml`: `version`, `build` and `publish` are skipped when `code` is false, so no prerelease is cut.
- Counted as "not code": `*.md`, `docs/`, `LICENSE`, `.github/CODEOWNERS`, `dependabot.yml`, the PR template, `.claude/`, `.vscode/`. Everything else, including the workflow files themselves, lockfiles and `scripts/`, counts as code.

## How to review

Read `changes.yml` first; the other two files only add a `needs`/`if`. Check the pattern list is what you want to treat as docs.

## What was tested

- Workflow files parse as YAML.
- The `case` patterns were run against sample file lists (docs only, docs plus source, docs plus a workflow file, lockfile, `Cargo.toml`, `scripts/`) and classified as expected.
- **Not run on GitHub.** The end-to-end behaviour (a skipped reusable-workflow job reporting as skipped and not blocking the PR) is confirmed only once this PR's own checks run. This PR changes workflow files, so it will build.

## Not done / follow-ups

- `release.yml` is unchanged: its build already only runs when release-please creates a release.
- `audit.yml` already had its own lockfile path filter.

## Decisions

### D1. Detect changes with a plain `git diff`, not a path-filter action or `paths-ignore`

- **Status:** accepted
- **Context:** A trigger-level `paths-ignore` leaves a skipped workflow "pending" forever, which blocks merging if CI is ever made a required check. A third-party filter action adds a dependency to a workflow that runs with repo access.
- **Decision:** The workflow always starts; a small first job decides, and later jobs skip with `if:`. The decision is a short shell `case` over `git diff --name-only`.
- **Consequences:** Required checks still report (skipped counts as passing). The pattern list lives in one place, `changes.yml`. A new top-level file type counts as code until added to the list, which fails safe.
- **Alternatives considered:** `paths-ignore` on the triggers (breaks required checks); `dorny/paths-filter` (extra dependency for a few lines of shell).

### D2. Keep `cancel-in-progress: false` for dev releases

- **Status:** accepted
- **Context:** Two pushes to `dev` in quick succession: should the first build be cancelled?
- **Decision:** No. The `dev-release` concurrency group queues runs and GitHub keeps only the newest waiting one, so a burst of pushes builds the one in flight and the last one, and skips the ones between.
- **Consequences:** A cancelled run could die between creating the release and pruning old ones, leaving a half-published prerelease or a stray tag. Waiting costs one extra build at most. PR builds are different: `ci.yml` already cancels superseded runs, since they publish nothing.
- **Alternatives considered:** Cancel the build but never the publish (two concurrency groups, more moving parts for little saving).
