# CI checks that every PR adds a change file

- **Branch:** `chore/adr-and-change-check`
- **PR:** see the PR from `chore/adr-and-change-check` into `dev`
- **Status:** draft
- **Author:** Claude (agent), with Adam

## Summary

A pull request now fails CI unless it adds a new `docs/changes/<slug>.md` that has every template section and every field of each decision block. Until now the "one PR, one change file, decisions ADR-style" rule was only written down.

## Why

Adam asked whether agents really produce a change file and ADR-style decisions for each PR. They were told to, but nothing checked, and two older branches had no file.

## What changed

- `scripts/check-change-file.mjs`: lists files added since the base branch, requires at least one new `docs/changes/*.md` (not the template), and checks each for the template sections, no leftover placeholders, and Status / Context / Decision / Consequences / Alternatives considered in every `### D<n>.` block. "None." under Decisions is accepted.
- `scripts/check-change-file.test.mjs`: five tests with `node --test`; `checks.yml` now runs all `scripts/*.test.mjs`.
- `ci.yml`: new `change-file` job. Skipped by the `no-change-file` label, by bot actors, and for `release-please--*` branches.
- `CONTRIBUTING.md` and `AGENTS.md` mention the check and the escape hatch.

## How to review

Read `problems()` in the script first: it is the whole rule. Then the `change-file` job in `ci.yml`.

## What was tested

Ran locally: the script's tests (5 pass), the validator over every existing change file (all pass but `api-roadmap.md`, which quotes the template's branch placeholder in prose and is not checked because only added files are), and the script against this branch. **Not run:** the workflow on GitHub (first run is this PR); the `no-change-file` label does not exist yet and must be created in the repository.

## Not done / follow-ups

- Make `change-file` a required status check in the "Protect main and dev" ruleset once it has passed here. That is a setting only the maintainer changes.
- `ci-release` and `collapse-groups` worktrees have no change file; backfill if they are still wanted.
- Numbered ADR records are the next branch (`docs/adr/`).

## Decisions

### D1. Require a newly added file, not just a changed one

- **Status:** accepted
- **Context:** Accepting any edit under `docs/changes/` would let an unrelated tweak to an old file satisfy the check.
- **Decision:** At least one `docs/changes/*.md` must be added by the PR, and only added files are validated.
- **Consequences:** Enforces one file per branch. Old files that predate the template are never re-judged. Fixing an old change file alone needs the `no-change-file` label.
- **Alternatives considered:** Accept modified files (too easy to game); validate every touched file (fails on legacy files).

### D2. Check structure, not quality

- **Status:** accepted
- **Context:** A script cannot tell whether a decision is a good one, only whether it was written down.
- **Decision:** Check that sections and decision fields exist and are non-empty. Review of the content stays with the human reviewer.
- **Consequences:** Cheap and predictable. An agent can still write thin text and pass; the "How to review" and "What was tested" sections are where a reviewer pushes back.
- **Alternatives considered:** Minimum word counts (invites padding); an LLM review step (cost, flaky, needs secrets in CI).
