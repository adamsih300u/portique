# Accept RUSTSEC-2023-0071 in the dependency audit

- **Branch:** `ci/audit-ignore-rsa`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The weekly and lockfile-triggered `cargo audit` has been failing on `dev` because of one advisory, RUSTSEC-2023-0071, which has no fix. This adds that single advisory to the audit's ignore list, with the reason beside it, so the audit goes green and any other advisory still fails it.

## Why

`russh` 0.64.1 (the newest release) enables its `rsa` feature by default and so pulls in `rsa 0.10.0-rc.18`, which the advisory covers (a timing side-channel, the "Marvin attack", in RSA private-key operations). The advisory lists no fixed version, and a newer `rsa` release candidate (rc.19) does not claim one. Until a fix exists the audit can only stay red, which hides real new advisories behind a known one. It also blocks the lockfile-changing PRs that trigger the audit (it failed #34 for a reason unrelated to that PR).

Builds on [quality-gates](quality-gates.md), which added the audit and chose to keep it out of the main CI so a new advisory does not block unrelated work. No record in `docs/adr/` touches this.

## What changed

- `.github/workflows/audit.yml`: `cargo audit` gets `--ignore RUSTSEC-2023-0071`, with a comment giving the reason and when to remove it. Nothing else changes; `npm audit` is untouched.

## How to review

It is a one-line change plus a comment. Check the reasoning in D1 more than the line.

## What was tested

- Not run locally: `cargo-audit` is not installed here. The workflow only triggers on lockfile changes, so this PR does not run it by itself. After pushing I started it by hand on this branch (`workflow_dispatch`) and the result is in the PR description.
- Checked by reading: `rsa` is reached only through `russh` and `ssh-key` (`cargo tree -i rsa`), and `russh` has no newer release (crates.io, 2026-10-09).

## Not done / follow-ups

- Remove the flag when `rsa` publishes a fixed release (watch the advisory page, or a Dependabot alert once alerts are on).
- Dependabot alerts and security updates are switched off for this repository. Turning them on is a repository setting for the maintainer, not part of this change.
- Dropping `russh`'s `rsa` feature would remove the crate, but it breaks RSA key login and RSA host keys, so it was not done.

## Decisions

### D1. Ignore the one advisory instead of dropping RSA or pinning around it

- **Status:** accepted
- **Context:** The audit is red on a vulnerability that cannot be fixed by upgrading. We use RSA for imported private keys (`keys.rs`) and for RSA key login (`best_supported_rsa_hash` in `ssh.rs`), and many network devices Portique talks to still have RSA host keys. The attack needs an observer able to time RSA private-key operations; here those are signatures made as a client with a key the user imported.
- **Decision:** Ignore RUSTSEC-2023-0071 by id in the `cargo audit` step, with the reason written next to it. Other advisories still fail the job.
- **Consequences:** The audit is meaningful again. We carry a known, low-exposure weakness until `rsa` is fixed, and someone must remember to remove the flag (the comment says when).
- **Alternatives considered:** Turning off `russh`'s `rsa` feature removes the crate but breaks RSA keys and hosts. A global `audit.toml` hides the ignore from the workflow file. Leaving the audit red trains everyone to ignore it.
