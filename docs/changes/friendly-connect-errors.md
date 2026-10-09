# Say why a connection failed, and explain the first-connect key prompt

- **Branch:** `feat/explain-connect-errors`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

When a connection fails, the tab now says what happened and what to try, in plain words, and keeps the technical error underneath. The first time you connect to a server, the host-key dialog explains that this is normal, what the key is for and how to check it, instead of opening with "authenticity can't be established".

## Why

A new user's first failure is usually a typo, a closed port, a VPN that is off or a wrong password. "cannot connect to host:22: Connection refused (os error 111)" tells an expert exactly that, and everyone else nothing. The old key prompt read like an attack warning on a perfectly normal first connection, which teaches people to click through real warnings later.

## What changed

- `src-tauri/src/explain.rs` (new): `friendly(error, profile)` recognises a name that will not resolve, a refused connection, no answer, no route, a server closing the connection mid sign-in, a rejected password or key, and serial port permission or missing-port problems. Each gets a headline, a line of advice and `Details: <the original error>`. Anything else, and the existing host-key-changed message, passes through untouched.
- `session.rs` uses it for the error status, so terminals, the file browser and the API proxy all benefit.
- `terminal-tab.ts`: the automatic-reconnect check reads only the headline, so advice text can never decide whether to keep retrying.
- `host-prompts.ts`: the dialog is titled *New server*, explains the first-connect case, keeps a stronger warning for a changed key type, and its buttons read *Cancel* and *Trust and connect*.

## How to review

Read the tests at the foot of `explain.rs`: they pin each headline. Then the dialog text in `host-prompts.ts`.

## What was tested

`npx tsc --noEmit`, `npm run lint` (0 errors), `npx vitest run` (154 tests), `cargo clippy --all-targets -- -D warnings`, `cargo test --lib` (6 tests for the wording).

Against real errors, with a throwaway `sshd` on loopback (the ignored test `real_failures_read_plainly`): a closed port reads "127.0.0.1:N refused the connection." with the original error under *Details*, a server that does not have the key reads "Authentication failed: the server rejected the key…", and an unresolvable name reads "The name … could not be resolved."

**Not run:** the wording against real Windows errors (DNS failure text differs by system), a timeout or "no route" against a real network, the serial port messages on real hardware, and the host-key dialog in the running app (no display here).

## Not done / follow-ups

- Host-key *changed* keeps its existing, already clear text.
- Telnet and API-proxy failures get the same network explanations but nothing protocol specific.
- Messages are English only, like the rest of the interface.

## Decisions

### D1. Headline, advice, then the raw error

- **Status:** accepted
- **Context:** Plain wording helps newcomers; experts and bug reports need the exact error.
- **Decision:** Three parts, in that order, with the original text always kept under `Details:`.
- **Consequences:** Nothing is hidden. The backend owns the wording, so every tab type shares it.
- **Alternatives considered:** Replacing the error text: loses information. Translating in the interface: each tab would need its own copy.

### D2. Only the first line decides whether to retry

- **Status:** accepted
- **Context:** The reconnect logic stops retrying on words such as "rejected" or "not found" anywhere in a message, and advice text can contain any word.
- **Decision:** The terminal tab tests the headline only; headlines for sign-in failures begin with "Authentication".
- **Consequences:** New advice can be written freely. Headlines for transient network errors must avoid those stop words; a test checks it.
- **Alternatives considered:** A separate machine-readable error code: cleaner, but a larger change across every status path.
