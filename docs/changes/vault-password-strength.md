# Refuse guessable master passwords

- **Branch:** `feat/vault-password-strength`
- **PR:** (not open yet; push is queued for after working hours)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

Creating a vault or changing its master password now fails when the password is easy to guess, not only when it is short. The two dialogs show a thin strength bar and one line of advice as you type.

## Why

The vault file can be copied and attacked offline. Argon2id makes each guess expensive, but the master password is still the weakest part: the old rule (12 characters) accepts `passwordpassword`. A pattern-aware estimator rejects that while accepting a plain passphrase of unrelated words.

## What changed

- `vault.rs` gains `assess()`, which rates a password with zxcvbn (0 to 4), and `require_strong()`, which `create` and `change_password` call. A score below 4, or fewer than 12 characters, is refused with the estimator's advice.
- New command `vault_password_strength` feeds the live meter. The check in `create` and `change_password` stays authoritative, so the interface cannot skip it.
- `vault-ui.ts` shows the meter under the new-password field in both dialogs; `styles.css` styles it with the existing colour variables.
- New dependency: `zxcvbn` 3.1.1.
- Unlocking is unchanged, so vaults made with an older, weaker password still open.
- The ignored integration tests in `ssh.rs` and `sftp.rs` use a stronger throwaway password, since they call `create`.

## How to review

Start at `assess` and `require_strong` in `src-tauri/src/vault.rs`, then the tests beside them.

## What was tested

`cargo test --lib`: 29 passed, 4 ignored (the ignored ones need a local sshd and were not run). New tests cover refusal of weak passwords on create and change, acceptance of two passphrases, and speed on very long input. `tsc --noEmit` reports only a missing `vitest` module in the shared `node_modules`, which this change does not touch. I did not run the app, so the meter's look in the dialogs, light looks included, is unchecked.

## Not done / follow-ups

- Existing weak passwords are not flagged at unlock; a nudge to change them could come later.
- The estimator's word lists are English-centric.

## Decisions

### D1. Score with zxcvbn and require its top rating

- **Status:** accepted
- **Context:** The vault is attackable offline, so the password's guess count sets the real strength. Rules such as "needs a digit" accept `Password1` and reject good passphrases.
- **Decision:** Require zxcvbn score 4 (about 10^10 guesses or more) and 12 characters, on create and on change. Feed it `portique`, `termix` and `vault` as known words.
- **Consequences:** Common passwords, keyboard runs, dates and l33t variants are refused with advice; four unrelated words pass. A few people will need a longer phrase than they hoped. Adds one dependency.
- **Alternatives considered:** Score 3: lets famous phrases such as `correcthorsebatterystaple` through. Composition rules: both reject good passphrases and accept weak ones. A larger length floor alone: still accepts `passwordpassword`.

### D2. The backend enforces; the meter only advises

- **Status:** accepted
- **Context:** The interface can show strength, but a check that lives only there is advice.
- **Decision:** `create` and `change_password` call the check themselves. The command behind the meter uses the same function.
- **Consequences:** One source of truth. The password crosses IPC once more per pause in typing, to the same local process that already receives it on submit.
- **Alternatives considered:** Scoring in the page with a JavaScript port: duplicates the rule and can drift from the backend.
