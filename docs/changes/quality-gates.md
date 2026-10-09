# Add lint, frontend tests and clippy to CI

- **Branch:** `ci/quality-gates`
- **PR:** (pending)
- **Status:** draft
- **Author:** Claude

## Summary

CI now also lints the TypeScript, runs frontend unit tests, and runs `cargo clippy` with warnings as errors. Two stricter compiler flags are on. A weekly dependency audit runs separately. No behaviour of the app changes.

## Why

CI already built both platforms and ran `tsc` and `cargo test`, but nothing checked lint rules, the frontend had no tests, and nothing guarded against `any` or forgotten promises on the IPC calls.

## What changed

- **TypeScript:** `noImplicitOverride` and `noImplicitReturns` added to `tsconfig.json`. The two `any`s (`ui.ts`, `editors.ts`) are gone.
- **ESLint** (`eslint.config.js`): typescript-eslint type-checked preset. `no-explicit-any`, `no-floating-promises` and `consistent-type-imports` are errors. A handful of small fixes came with it (comma-expression statements, redundant casts, `import type`).
- **Vitest:** `src/http-model.test.ts` covers query-string sync, sanitizing, cURL round trip, JSON re-indenting and formatting helpers (15 tests).
- **Rust:** one clippy warning fixed in `telnet.rs`.
- **CI:** new `checks.yml` (typecheck, lint, tests, clippy), called from `ci.yml`. New `audit.yml` (`npm audit`, `cargo audit`; weekly and on lockfile changes).
- Scripts: `npm run typecheck | lint | test`.

## How to review

Start with `eslint.config.js` and `.github/workflows/checks.yml`. The `src/` changes outside the test file are small and mechanical.

## What was tested

Ran locally: `tsc --noEmit`, `eslint .` (0 errors, 31 warnings), `vitest run` (15 pass), `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (22 pass, 4 ignored), `npm audit --omit=dev` (0). Workflow YAML parses. **Not run:** the workflows themselves on GitHub (first run is this PR); `cargo audit`.

## Not done / follow-ups

- The 31 `no-unsafe-*` warnings come from untyped `JSON.parse` and event payloads. Type them, then promote those rules to errors.
- `noUncheckedIndexedAccess` produces about 60 errors in 12 files. Own branch.
- Generate the `api.ts` types from the Rust structs (`specta` or `ts-rs`) so they cannot drift.
- Tests for the vault and known-hosts paths beyond what exists today.

## Decisions

### D1. No Prettier or `cargo fmt` gate yet

- **Status:** accepted
- **Context:** The code uses a dense, hand-formatted style. Prettier would change all 21 TS files and `cargo fmt` about 168 hunks.
- **Decision:** Do not add a formatter check now.
- **Consequences:** No style gate. `git blame` stays useful. Adding one later is a single mechanical commit, ideally listed in `.git-blame-ignore-revs`.
- **Alternatives considered:** Format everything now (huge diff, hard to review); format only changed files (inconsistent tree).

### D2. `no-unsafe-*` rules are warnings, not errors

- **Status:** accepted
- **Context:** 31 sites leak `any` from `JSON.parse` and Tauri events. Fixing them properly is a typing pass of its own.
- **Decision:** Keep them visible as warnings; keep `no-explicit-any` and `no-floating-promises` as errors.
- **Consequences:** CI is green today, new explicit `any` and unawaited promises fail. The warning count should only go down.
- **Alternatives considered:** Errors now (forces a large mixed PR); turn the rules off (hides the problem).

### D3. The dependency audit is not part of the PR gate

- **Status:** accepted
- **Context:** Advisories appear independently of our changes.
- **Decision:** `audit.yml` runs weekly and on lockfile changes, separate from `ci.yml`.
- **Consequences:** A new advisory does not block unrelated PRs, but someone has to read the failure.
- **Alternatives considered:** Gate every PR on it.
