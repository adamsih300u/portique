# Agents open draft PRs and mark them ready once CI passes

- **Branch:** `docs/agents-ready-pr`
- **PR:** see the PR from `docs/agents-ready-pr` into `dev`
- **Status:** draft
- **Author:** Claude (agent), with Adam

## Summary

`AGENTS.md` now tells agents to open every PR as a draft, wait for CI, and run `gh pr ready` themselves when the checks pass and their work is done. If CI fails and they cannot fix it, or they are not finished, the PR stays a draft and the report says why. Merging stays with the maintainer.

## Why

Adam wants a PR to reach him as "ready for review" only when it is green and complete, without having to ask the agent to flip it. Until now agents opened drafts and left them.

## What changed

- `AGENTS.md`: step 6 says to open a draft; new step 7 says when and how to mark it ready; the report step is renumbered and also states draft or ready.
- `CONTRIBUTING.md`: one bullet saying the same for people.

## How to review

Read step 7 in `AGENTS.md`. It is the whole change.

## What was tested

Checked that `gh pr ready` is not blocked by the deny rules in `.claude/settings.json` and that `gh pr checks --watch` and `gh pr ready` exist in the installed `gh`. **Not run:** an agent following the new step end to end; this PR is the first try.

## Not done / follow-ups

- Nothing enforces it. A background agent that ends its session before CI finishes cannot flip the PR; it should say so in its report.
- `gh pr ready` is not in the deny list on purpose. If ready-for-review ever needs the maintainer's say, add it there.

## Decisions

### D1. Agents may mark their own PRs ready, but never merge

- **Status:** accepted
- **Context:** Adam asked for ready-on-green. Marking ready only asks for a review; merging and approving are covered by the maintainer-approval rule.
- **Decision:** Agents run `gh pr ready` after green CI when finished. The existing deny rules for merging and approving stay.
- **Consequences:** The maintainer's queue holds only green, finished PRs. A wrongly flipped PR costs a review, not a bad merge.
- **Alternatives considered:** Leave PRs as drafts for the maintainer to flip (extra step for every PR); a workflow that flips drafts automatically on green (cannot know whether the author is finished).

### D2. A failing check is fixed from its log, not re-run

- **Status:** accepted
- **Context:** A re-run can hide a real or flaky failure, and an agent waiting for green may be tempted to retry until it gets one.
- **Decision:** On a failure the agent reads the log and fixes the cause. If it cannot, the PR stays a draft and the failure is reported.
- **Consequences:** Flaky checks surface instead of being masked. The agent sometimes stops with a red draft.
- **Alternatives considered:** Allow one automatic re-run (hides flakiness).
