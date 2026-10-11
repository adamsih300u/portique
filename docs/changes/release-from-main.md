# Release from `main`, not from the default branch

- **Branch:** `ci/release-from-main`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The release workflow now tells release-please to work on `main`. Before, it used the repository's default branch, which is `dev`, so a push to `main` made it read `dev`'s history and try to open the release pull request against `dev`.

## Why

The first push to `main` ran the `Release` workflow, and it failed. The log shows `targetBranch: dev`, 139 commits read from `dev`, a branch `release-please--branches--dev--components--portique` created, and then "GitHub Actions is not permitted to create or approve pull requests". The permission is a repository setting and is separate (see below). The branch it targeted is this file's fault: the workflow header says releases come from `main`, and the action was not told.

[ADR-0006](../adr/0006-dev-merged-with-merge-commit.md) constrains how `main` gets its commits (a merge commit from `dev`, so the commits release-please reads are `dev`'s own). [ADR-0007](../adr/0007-maintainer-approves-merges.md) keeps merging with the maintainer. No record conflicts.

## What changed

- `.github/workflows/release.yml`: `target-branch: main` on the release-please step.

## How to review

One line. Check it against the workflow's own header comment.

## What was tested

Not run. The workflow only runs on a push to `main`, so this can be checked only by merging it into `main` (through `dev`) and watching the next run. I read the action's log from the failed run to find the cause.

## Not done / follow-ups

- **The repository setting.** The run also needs *Settings, Actions, General, Workflow permissions, Allow GitHub Actions to create and approve pull requests* turned on. It is off now (`can_approve_pull_request_reviews: false`). That is an administrator's setting and not part of this change.
- **`main`'s history.** `main` currently holds `dev`'s content as one squash commit, so release-please would find no release-worthy commits and no `Release-As: 0.5.0` footer. A merge-commit PR that restores `dev`'s history on `main` is open separately.
- A stray branch `release-please--branches--dev--components--portique`, created by the failed run, can be deleted.

## Decisions

### D1. Name the release branch in the workflow

- **Status:** accepted
- **Context:** release-please-action takes its target branch from the repository's default branch unless told otherwise. This repository's default is `dev`, where day-to-day work lands, and releases are cut from `main`.
- **Decision:** Set `target-branch: main`.
- **Consequences:** The release pull request, its version bump and the tag are all on `main`. A run no longer depends on which branch is the default, so changing the default later won't move releases.
- **Alternatives considered:** Making `main` the default branch (changes where every new pull request points and what visitors see, for a release setting). Releasing from `dev` (the workflow's trigger, its header and ADR-0006 all assume `main`).
