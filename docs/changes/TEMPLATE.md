# <Title: what this branch does, in a line>

- **Branch:** `<type>/<slug>`
- **PR:** <link, once open>
- **Status:** draft | in review | merged
- **Author:** <person or agent>

## Summary

Two or three sentences a newcomer could follow. What changes for the person using Portique, or for the person reading the code?

## Why

The problem or the request behind it. Link earlier change files this builds on or replaces, and the records in `docs/adr/` that support, constrain or conflict with this change (with the maintainer's ruling on any conflict).

## What changed

The shape of the change, by area. A short list is better than a tour of the diff.

## How to review

Where to start reading, what to look hardest at, and anything deliberately left alone.

## What was tested

What you ran and what happened. Say plainly what you did **not** run (for example: not run on Windows, not run against a real server).

## Not done / follow-ups

Gaps, known rough edges, and what should be a separate branch.

## Decisions

One block per real choice. Skip trivial ones. If a decision will keep constraining later work, also write it as a numbered record in `docs/adr/` (copy `docs/adr/TEMPLATE.md`, add it to the index there) and add it to *Standing decisions* in `AGENTS.md`.

### D1. <The decision, as a short statement>

- **Status:** accepted | superseded by <link>
- **Context:** What forced a choice? What mattered (users, safety, effort)?
- **Decision:** What we do.
- **Consequences:** What gets easier, what gets harder, what we now must keep true.
- **Alternatives considered:** What else we looked at and why not.
