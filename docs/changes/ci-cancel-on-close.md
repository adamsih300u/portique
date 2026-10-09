# Cancel a PR's CI when it is merged or closed

- **Branch:** `ci/cancel-on-close`
- **PR:** (draft, see GitHub)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

When a PR is merged or closed, any CI run still going for it is now cancelled. Before, the run kept going to the end even though its result could no longer block anything.

## Why

CI on a PR exists to decide whether it may merge. Once the PR is merged or closed there is nothing left to decide. When several PRs merged in a row, their leftover runs piled up and used runner time for nothing. The run that matters after a merge is the one on `dev` (`dev-release.yml`), and that is unchanged.

## What changed

- `ci.yml` also triggers on the `closed` pull request event.
- `changes`, `change-file` and `pr-title` are skipped when the event is `closed`. `checks` and `build` depend on `changes`, so they are skipped too.
- The existing concurrency group is `ci-${{ github.ref }}` with `cancel-in-progress`. The `closed` run joins that group, cancels the run in flight, and then finishes as skipped.

## How to review

Read the trigger block and the three `if:` lines in `.github/workflows/ci.yml`.

## What was tested

Not run. Workflow behaviour can only be confirmed on GitHub. To check it, open a PR, wait for CI to start, merge it, and confirm the CI run shows as cancelled and a skipped run follows.

## Not done / follow-ups

- Required status checks: a skipped run counts as passing, but confirm that branch protection does not wait on the `closed` run.
- The group key uses `github.ref`, which is the PR's merge ref. If a closed run lands in a different group on some event, the old run would not be cancelled. The check above covers this.

## Decisions

### D1. Cancel through the `closed` event, not a separate cancel job

- **Status:** accepted
- **Context:** A run already in progress is not stopped by a merge. Something has to cancel it.
- **Decision:** Trigger on `closed` and let the existing concurrency group cancel the old run.
- **Consequences:** No new permissions, no new action, and no API calls. The cost is one short skipped run per closed PR.
- **Alternatives considered:** A job that calls `gh run cancel`: needs `actions: write` and more code. A third-party cancel action: another dependency to trust.

### D2. Skip jobs on the closing run instead of filtering the trigger

- **Status:** accepted
- **Context:** The `types` filter cannot say "closed, but only to cancel"; the workflow still starts.
- **Decision:** Add `if: github.event.action != 'closed'` to the jobs with no dependency, so the rest follow.
- **Consequences:** The closing run costs almost nothing. Anyone adding a new top-level job must add the same line.
- **Alternatives considered:** Guarding every job: more lines, same result.
