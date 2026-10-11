# Nothing merges into `main` or `dev` without the maintainer's approval

- **Branch:** `chore/merge-approval`
- **PR:** see the PR from `chore/merge-approval` into `dev`
- **Status:** in review
- **Author:** Claude (agent), with Adam

## Summary

Pull requests into `main` and `dev` now need one approving review before they can merge. The maintainer is the code owner of every file. Agents working in this repo are blocked from merging or changing the protection rules.

## Why

Adam wants to be sure contributors, and agents acting for him, cannot land changes he has not approved.

## What changed

- Repository ruleset "Protect main and dev" (a setting on GitHub, not in the tree) gained a pull-request rule: one approval, stale approvals dismissed on new pushes, the latest push approved by someone other than its author, review threads resolved. Repository admins can bypass it only through a PR.
- `.github/CODEOWNERS` names the maintainer as owner of everything.
- `.claude/settings.json` denies `gh pr merge`, `gh pr review --approve`, and `gh api` calls that merge or edit rulesets and branch protection.

## How to review

Check the ruleset at Settings → Rules. The files in this PR are small.

## What was tested

The ruleset was read back from the API after the change. The deny rules, and the effect on a real contributor PR, were not exercised.

## Not done / follow-ups

- "Require review from code owners" is off: with one collaborator it adds nothing. Turn it on when there are more.
- `gh` here is logged in as the maintainer, so the deny rules in `.claude/settings.json` are the only thing keeping an agent from using the maintainer's bypass. They bind Claude Code only, not other tools.

## Decisions

### D1. Admins may bypass the review rule, through a PR only

- **Status:** accepted
- **Context:** The maintainer is the only collaborator, and GitHub does not let an author approve their own PR.
- **Decision:** One required approval, with the admin role as a bypass actor in pull-request mode.
- **Consequences:** Contributors need the maintainer's approval. The maintainer can still merge their own PRs. Anyone holding the maintainer's token could bypass, hence the agent deny rules.
- **Alternatives considered:** No bypass (blocks the maintainer until a second reviewer exists).
