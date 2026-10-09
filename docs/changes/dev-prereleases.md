# Publish a versioned prerelease for every push to dev

- **Branch:** `ci/dev-prereleases`
- **PR:** see the draft PR for this branch
- **Status:** draft
- **Author:** Claude, for Adam Pilbeam

## Summary

A push to `dev` now builds the Linux and Windows files and publishes them as a GitHub prerelease called `v0.1.1-dev.17`, where `0.1.1` is the version the next release will get. Merging `dev` into `main` then releases plain `v0.1.1`.

## Why

Dev builds were only workflow artifacts: unversioned inside, hidden on the Actions page, and gone after 30 days. Nothing connected a dev build to the release made from it.

## What changed

- `.github/workflows/dev-release.yml` (new): on push to `dev`, work out the version, build with it, create a prerelease, and prune to the newest ten.
- `build.yml`: the `version-suffix` input is replaced by `version`, which is stamped into `package.json`, `Cargo.toml` and `tauri.conf.json` before building, so the app itself reports it. File names no longer need a suffix.
- `ci.yml`: builds pull requests only; `dev` and `main` pushes have their own workflows.
- `scripts/release-version.mjs` (+ tests): predicts the next version. `scripts/set-version.mjs`: stamps it.
- CONTRIBUTING and AGENTS describe the flow.

## How to review

Start with `scripts/release-version.mjs` and its test, then `dev-release.yml`.

## What was tested

`node --test scripts/` passes; the version script prints `0.1.1` for this repo; the stamp changes exactly the three version lines; the prune filter was run on sample JSON; the workflow files parse as YAML. **Not run:** the workflows themselves (they need a push to `dev`), the Windows build with a `-dev.N` version, the `.deb` build with a hyphenated version, and release-please against `dev`.

## Not done / follow-ups

- The predicted version and release-please's can drift if release-please changes its rules or a `release-as` override is used. Nothing checks this yet; a check on the release PR title in `release.yml` would.
- No release exists yet and `main` is not on origin, so the first release will show how the two line up.

## Decisions

### D1. Predict the version with our own script instead of asking release-please

- **Status:** accepted
- **Context:** A dev build needs its version before anything is merged to `main`. release-please only works on `main`, and running its CLI on `dev` needs a token, a network call and output parsing.
- **Decision:** `scripts/release-version.mjs` applies the same rules as `release-please-config.json` (pre-1.0: breaking bumps minor, feat bumps patch) to the commits since the highest stable `v*` tag.
- **Consequences:** Fast, offline, tested. It must be kept in step if the release-please settings change.
- **Alternatives considered:** `release-please release-pr --dry-run` on `dev` (fragile output, depends on tag ancestry); running release-please on `dev` too (two release PRs, more moving parts).

### D2. `dev` is merged into `main` with a merge commit

- **Status:** accepted
- **Context:** The prediction counts commits reachable from `dev` but not from the last tag. A squash merge makes new commits on `main` and leaves the `dev` ones unreleased in git's eyes.
- **Decision:** Merge `dev` into `main` with a merge commit. PRs into `dev` are still squashed.
- **Consequences:** The next version stays right with no back-merge of `main`. The merge setting is a convention, not enforced.
- **Alternatives considered:** Squash with a back-merge (every release needs a manual step).

### D3. Dev prereleases are tagged `dev-build-N`, not `v...`

- **Status:** accepted
- **Context:** release-please finds "the last release" from tags it can read as versions. A tag like `v0.1.1-dev.17` could be taken as the last release and skew the changelog and version.
- **Decision:** The tag is `dev-build-<run number>`; the release title and file names carry the version.
- **Consequences:** Dev builds can't confuse release-please. The tag name doesn't show the version.
- **Alternatives considered:** `v0.1.1-dev.N` tags (risk above); one rolling "latest dev" release (loses the versioned history).

### D4. Keep the newest ten dev prereleases

- **Status:** accepted
- **Context:** Every push to `dev` makes one; unbounded, they bury the real releases.
- **Decision:** Delete older ones and their tags after each publish (`KEEP` in the workflow).
- **Consequences:** Old dev builds are gone. Stable releases are never touched (only `dev-build-*` tags are pruned).
- **Alternatives considered:** Keep all; delete dev builds when their release ships.
