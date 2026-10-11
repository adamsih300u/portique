# Undo the version bump made before `main` could release

- **Branch:** `chore/undo-early-version-bump`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Puts the version back to 0.1.0 and removes the generated `CHANGELOG.md`, undoing release PR #57 on `dev`. The version stays 0.1.0 until release-please cuts 0.5.0 from `main`.

## Why

The first release run was aimed at `dev`, so it opened release PR #57 there and it was merged, bumping the manifest, `package.json`, `src-tauri/Cargo.toml` and `tauri.conf.json` to 0.5.0 with no tag or release behind them. When `main` is rebuilt from `dev` and release-please runs on it, it would take 0.5.0 as already released and propose 0.5.1. With the bump undone, it sees the `Release-As: 0.5.0` commit from #48 and proposes 0.5.0, then tags it and builds the installers, which is the whole release path used for the first time.

[ADR-0006](../adr/0006-dev-merged-with-merge-commit.md) is why the tag has to be made on `main` from `dev`'s own commits. [ADR-0007](../adr/0007-maintainer-approves-merges.md): the maintainer merges this. No record conflicts.

## What changed

- A `git revert` of #57, with a message that is not a `revert:` (release-please would list that type in the changelog): `.release-please-manifest.json`, `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` back to 0.1.0, and `CHANGELOG.md` removed.

## How to review

Check that every changed file is a version line or the deleted changelog, and that nothing else from #57 was touched.

## What was tested

Not run: no code changes. I compared the files with their state before #57.

## Not done / follow-ups

- Rebuilding `main` from `dev` and the first real release, which need the repository administrator (protection rules).
- The `v0.5.0` tag does not exist yet; release-please creates it when its release PR is merged on `main`.

## Decisions

### D1. Undo the bump instead of tagging 0.5.0 by hand

- **Status:** accepted
- **Context:** `dev` says 0.5.0 but no release exists. A tag made by hand would not build or attach the installers, which only the release workflow does.
- **Decision:** Revert the bump and let release-please make 0.5.0 from `main`.
- **Consequences:** The release goes through the real pipeline, and its first run proves the tag, build and publish steps. `dev` shows 0.1.0 for a short while.
- **Alternatives considered:** Tagging `v0.5.0` by hand on the new `main` (no installers, and release-please's own state would then need repairing). Leaving 0.5.0 in place (release-please would propose 0.5.1).
