# Agents consult the ADRs before changing things, and records follow a style guide

- **Branch:** `docs/adr-consult-and-style`
- **PR:** see the PR from `docs/adr-consult-and-style` into `dev`
- **Status:** draft
- **Author:** Claude (agent), with Adam

## Summary

Before designing a change or a new capability, agents read the decision records, sort them into supporting, constraining and conflicting, and bring conflicts to the user for a ruling. A record that overrides an earlier one names it. The eight existing records are rewritten to the new style, and the README gains a style guide for future ones.

## Why

Adam wants earlier decisions to shape new work, and wants contradictions between them surfaced to a person before code is written. He also asked for records that read well: concise, positive in tone, free of contrastive phrasing. This builds on [adr-records](adr-records.md) and [agents-ready-pr](agents-ready-pr.md).

## What changed

- `AGENTS.md`: new step 3 under *Before you start* (consult the records, escalate conflicts, supersede explicitly); the decision step points to the style notes.
- `docs/adr/README.md`: a "Using the records" section, a "Writing a record" section with the style rules, and the refreshed index.
- `docs/adr/TEMPLATE.md`: new fields *Supersedes* and *Related*; *Recorded* split into *Date* and *Source*.
- `docs/adr/0001`–`0008`: rewritten shorter, in the positive, with the new fields. Their substance is unchanged.
- `CONTRIBUTING.md` and `docs/changes/TEMPLATE.md`: the same expectation in the human guide and the *Why* section prompt.

## How to review

Start with the "Using the records" and "Writing a record" sections of `docs/adr/README.md`, then compare one rewritten record (0003 is a good one) with its source block in `api-roadmap.md`.

## What was tested

Read every rewritten record against its source block to check that the decision, costs and alternatives carried over. Ran `node scripts/check-change-file.mjs origin/dev` on the branch. **Not run:** an agent following the new consult step; no automated check covers record style or the consult step.

## Not done / follow-ups

- CI could check that an added record carries every field and that a record named in *Supersedes* has status `superseded`.
- Records 0001–0008 were reworded in this PR even though accepted records are otherwise edited only in their status fields. They were a day old and had no other readers; later records follow the append-only rule.
- No record yet exists for the "quiet interface" preference or the Termix to Portique rename.

## Decisions

### D1. Conflicts go to the user before code is written

- **Status:** accepted
- **Context:** An agent that finds a record contradicting its plan can proceed quietly, silently adapt, or ask. Quiet contradiction erodes the records and surprises the maintainer later.
- **Decision:** The agent lists supporting, constraining and conflicting records, shows the conflicts to the user, and waits for a ruling. In a run with nobody to ask, it stops at the conflict and reports.
- **Consequences:** Reversals of past decisions are deliberate and visible. Some work pauses for an answer.
- **Alternatives considered:** Let the agent decide and note it in the change file (the maintainer finds out after the fact); ask only for conflicts the agent judges major (that judgement is the thing in question).

### D2. A new record names the earlier one it overrides

- **Status:** accepted
- **Context:** A reader of an old record needs to find what replaced it, and a reader of a new record needs the history behind it.
- **Decision:** The new record lists the old under *Supersedes* (or *Related*, with a reason, when both stay in force). The old record's *Status* and *Superseded by* are updated to point back.
- **Consequences:** Links run in both directions and the index shows current status at a glance. Two records change in one PR.
- **Alternatives considered:** Link only from the old record (new readers miss the history); a separate changelog of decisions (a second place to maintain).

### D3. Records follow a short, positive style

- **Status:** accepted
- **Context:** Records are read by people deciding quickly and by agents loading them as context. Long or oblique text costs both.
- **Decision:** Keep each record near 150 words, titled with the decision itself, written in plain active sentences that describe the chosen path directly. Alternatives live in their own field.
- **Consequences:** Records are quick to read and cheap to load. Authors spend a little time trimming.
- **Alternatives considered:** No style guidance (records drift long); a word limit enforced in CI (rigid for a judgement call).
