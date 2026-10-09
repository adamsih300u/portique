# Repository guides: a short README, CONTRIBUTING, AGENTS, and a change file per branch

- **Branch:** `docs/repo-guides`
- **PR:** see the draft PR from `docs/repo-guides` into `dev`
- **Status:** in review
- **Author:** Claude (agent), with Adam

## Summary

The README is now a short, friendly introduction. How the code is laid out and how we work is in `CONTRIBUTING.md` for people and `AGENTS.md` for agents. Long PR descriptions, and the decisions behind them, live in one file per branch under `docs/changes/`, so a PR body can stay short and agents can read the reasoning later.

## Why

Adam asked for three things: a brief, conversational README; the structure described for contributors and for agents so they work cohesively; and short PRs with easy-to-read descriptions, ADR-style commentary on decisions, and longer descriptions in a dedicated file that agents can find.

## What changed

- `README.md` shrinks to an introduction. The full feature tour moved, unchanged apart from the API entry, to `docs/using-portique.md`.
- `CONTRIBUTING.md` and `AGENTS.md` (plus a one-line `CLAUDE.md` that imports `AGENTS.md`, because Claude Code reads that name).
- `docs/changes/TEMPLATE.md`, and change files for this branch and for `feature/api-roadmap`, which also seeds the *Standing decisions* in `AGENTS.md`.
- `.github/pull_request_template.md`.
- The build, Windows and release notes that were in the README are now in `CONTRIBUTING.md`.

## How to review

Read the new `README.md` first (it should feel like talking to a person), then `AGENTS.md`. Check the structure tables in `CONTRIBUTING.md` against the tree. Nothing outside documentation changed.

## What was tested

Links and file names were checked against the tree. Nothing was built, because no code changed.

## Not done / follow-ups

- Nothing enforces a change file per PR. A CI check (does `docs/changes/<slug>.md` exist for this branch?) would be a small, separate branch.
- Older work has no change files; only `api-roadmap` was written up.
- Branch protection (require a PR into `dev`) is a repository setting, not something this branch can add.

## Decisions

### D1. A short README, with detail in `docs/`

- **Status:** accepted (standing)
- **Context:** The README had grown into the manual, the build guide and the release process at once, and nobody could skim it.
- **Decision:** The README says what Portique is and where to read more. The feature tour is `docs/using-portique.md`; contributor material is in `CONTRIBUTING.md`.
- **Consequences:** Easy to read first. Information has to be kept in the right file, and links between files need care.
- **Alternatives considered:** leave it long and add a table of contents (still not brief).

### D2. Long PR descriptions are files in the repository

- **Status:** accepted (standing)
- **Context:** PR bodies are hard for agents to find later, can't be reviewed in the PR itself, and tend to be either too thin or too long.
- **Decision:** One `docs/changes/<slug>.md` per branch holds the description and the decisions. The PR body is a few lines and links to it.
- **Consequences:** The reasoning travels with the code, is reviewable in the diff, and is searchable by agents. It costs one extra file per branch and a rule that people follow it.
- **Alternatives considered:** long PR bodies only (invisible to later agents); a single CHANGELOG (release-please owns it, and it records *what*, not *why*).

### D3. Decisions are written ADR-style inside the change file

- **Status:** accepted (standing)
- **Context:** The useful part of a change is often the choice and the roads not taken, and it is the first thing lost.
- **Decision:** Each real decision gets a block: status, context, decision, consequences, alternatives. Ones that keep constraining new work are also listed in `AGENTS.md`.
- **Consequences:** Decisions stay next to the work they came from, with a short list that agents see first. A decision can be superseded by a later file.
- **Alternatives considered:** a separate `docs/adr/` numbered series (more ceremony, and decisions drift away from their changes). We can promote to it later if the list outgrows `AGENTS.md`.

### D4. `AGENTS.md` is canonical for agents; `CLAUDE.md` imports it

- **Status:** accepted
- **Context:** Different agents read different file names; two copies would drift.
- **Decision:** `AGENTS.md` holds the rules. `CLAUDE.md` is a single `@AGENTS.md` line.
- **Consequences:** One place to edit. Agents that read neither get no guidance.
- **Alternatives considered:** a full `CLAUDE.md` (duplication).
