# Numbered architecture decision records in docs/adr/

- **Branch:** `docs/adr-records`
- **PR:** see the PR from `docs/adr-records` into `dev`
- **Status:** draft
- **Author:** Claude (agent), with Adam

## Summary

Decisions that keep constraining the code now have their own numbered, linkable records in `docs/adr/`, with an index, a template and a rule for superseding. The eight standing decisions that were only a list in `AGENTS.md` are the first records. Change files still hold the decisions made along the way.

## Why

Decisions lived as `D<n>` blocks inside change files, whose numbers only mean something inside one file. A later change that reverses one had nothing stable to point at, and the "standing decisions" list was hand-kept and without the reasoning.

## What changed

- `docs/adr/README.md`: how it works, and the index of records.
- `docs/adr/TEMPLATE.md`: status, date and source, superseded-by, context, decision, consequences, alternatives.
- `docs/adr/0001`–`0008`: copied word for word from the decision blocks in `api-roadmap`, `dev-prereleases`, `merge-approval` and `repo-guides`. Each links back to its source.
- `AGENTS.md` standing decisions now link to the records. `CONTRIBUTING.md` and `docs/changes/TEMPLATE.md` say when to write one.

## How to review

Read `docs/adr/README.md` for the rule, then open one record next to its source block to see that nothing was reworded. The other files are link changes.

## What was tested

Compared each record with its source block by eye after generating it, and checked that every relative link in the new files points at a file that exists. **Not run:** any automated check of the records; nothing in CI looks at `docs/adr/`.

## Not done / follow-ups

- "The interface stays quiet" and "renamed from Termix to Portique" are still bare lines in `AGENTS.md` because no change file records their reasoning. Write records for them when someone can state the context.
- Other decision blocks in older change files (`api-roadmap` D5, D7, D8; `dev-prereleases` D1, D3, D4; `repo-guides` D2–D4) were left as local decisions. Promote any that start to bind new work.
- CI could check that an added record is listed in the index.

## Decisions

### D1. Records live beside the change files, not instead of them

- **Status:** accepted
- **Context:** Writing decisions while working on a branch is easy; stopping to maintain a separate log is not. Most decisions only matter for one change.
- **Decision:** Keep `D<n>` blocks in change files. Only a decision that will outlive its branch is copied into `docs/adr/` and numbered.
- **Consequences:** Low cost per PR, and the records stay a short list worth reading. The copy step can be forgotten; the "Standing decisions" list in `AGENTS.md` is the reminder.
- **Alternatives considered:** Every decision becomes a numbered record (noisy, many trivial ones); only records, no decisions in change files (slows every PR).

### D2. Records are append-only and superseded, never edited away

- **Status:** accepted
- **Context:** The point of a record is to explain why the code is the way it is, including after the choice is reversed.
- **Decision:** A reversed decision gets a new record; the old one is set to `superseded` with a pointer, and its text stays.
- **Consequences:** History is kept and findable. Readers must follow the pointer to find the current rule.
- **Alternatives considered:** Edit records in place (loses the reasoning); delete outdated ones (same).

### D3. Numbers are taken in merge order

- **Status:** accepted
- **Context:** Several branches can add a record at once and would pick the same next number.
- **Decision:** Use the next free number when you write it; if another PR merges first with that number, the later PR renumbers.
- **Consequences:** No central counter to maintain. A rebase may mean a rename and a link fix.
- **Alternatives considered:** Date-based names (long, no order for same-day records); random ids (unreadable in links).
