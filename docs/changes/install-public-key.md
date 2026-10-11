# Server tools, part 3: install a vault key on a host

- **Branch:** `feat/install-public-key` (stacked on `feat/server-services`)
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

*Install a key on this host…* in the palette's server tools adds the public half of a key from the vault to the connected server's `~/.ssh/authorized_keys`. It lists the keys, shows what it will do, and waits for the *Install* button. Afterwards the person edits the profile to sign in with that key instead of a password.

## Why

The last item in the Tier 2 list that needs no new ground: a one-step version of the usual "copy my key to the server" chore, using keys Portique already holds. It follows [server-services](server-services.md) and uses its confirmation rule, [ADR-0012](../adr/0012-server-changes-show-their-command-first.md), and the exec channel of [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md).

[ADR-0003](../adr/0003-secrets-never-read-back.md) constrains it: a private key and its passphrase must stay in Rust. This change adds one backend command that returns only the public half (D1). No record conflicts.

## What changed

- **`keys.rs`:** `keys::public(id)` returns `algorithm base64` and the fingerprint of a stored key (refusing with an explanation when the key needs a passphrase the vault doesn't have), and `key_public` in `lib.rs` exposes it. Tests build a key from a fixed seed, so no private key is committed.
- **`server-keys-core.ts` (new, tested):** `pickKey` (by name, or a unique start or part of one), `keyComment`, `installKeyUnix` (the script) and `formatInstallKey`. The script refuses anything that isn't a public key line before it exists.
- **`server-operate.ts`:** the tool, with `prepare` loading the key list. **`toolbox.ts`:** `action.idle`, the text shown while the box is empty (here, the list of keys).
- **Docs:** `using-portique.md` and the code-layout tables.

## How to review

`keys::public` first: it is the only place a stored key is read for this feature, and it must return nothing but the public half. Then `installKeyUnix`: what it creates, the modes, and how it decides "already there" (by the key's data, so the same key under another comment is not added twice).

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (107 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.

The script runs under a real `sh` with a temporary home folder: creates `.ssh` at 700 and the file at 600; adds the key once and reports a repeat as already there; keeps other lines (comments included) and a final line with no newline; recognises the same key under another comment; reports a missing home folder and an unwritable folder; a comment made from a hostile key name cannot become code. Anything that isn't a public key line is refused.

End to end in a headless browser, with the script forwarded to a real `sshd` on this machine (with `HOME` pointed at a scratch folder, and the real `~/.ssh/authorized_keys` confirmed untouched): the dialog lists the keys; an unknown name explains and lists them; the plan shows the name and fingerprint; Enter only moves to the button; one key and then a second are appended; a repeat says already there.

**Not run:** with the real `key_public` command (the browser used a mock; `keys::public` is covered by unit tests on a seeded key, and the vault path by reading the code), a key that needs a passphrase, a server that has `authorized_keys` as a symlink or on a read-only file system, signing in afterwards with the installed key, Windows servers (refused with a message).

## Not done / follow-ups

- Editing the profile to use the key and then testing the sign-in, in one step.
- Windows servers: administrators' keys live in a different file there.
- Removing a key from a server.
- A passphrase-protected key without a saved passphrase can't be installed.
- Nothing checks the home folder's permissions: a server that is strict about them will ignore the key until they are fixed.

## Decisions

### D1. Rust hands out the public half of a key, and nothing else

- **Status:** accepted
- **Context:** Installing a key means sending its public line. The interface must never hold a private key or a passphrase ([ADR-0003](../adr/0003-secrets-never-read-back.md)), and a public key can be recomputed from a private one, so the work has to happen in Rust.
- **Decision:** `key_public(id)` loads the key from the vault with the saved passphrase, derives the public key and its fingerprint, and returns only those. `keys::public` is the single place this is done.
- **Consequences:** The interface can show and send public keys without ever seeing a secret. A key whose passphrase isn't saved can't be installed; the error says to save it.
- **Alternatives considered:** Storing public keys next to the metadata in `keys.json` (a second copy to keep consistent, and nothing for keys imported earlier). Sending the private key to the interface to derive it there (breaks ADR-0003).

### D2. "Already installed" is decided by the key, not by its comment

- **Status:** accepted
- **Context:** A key may be in the file already under the person's own comment (an email address, say). Appending it again would leave duplicates.
- **Decision:** The script searches the file for the key's `algorithm base64` text as a fixed string. A new line carries `portique:<name>` as its comment, made only of letters, digits and `. _ -`.
- **Consequences:** Running the tool twice is harmless, and an existing line is never rewritten. A key that is present only inside a longer line (with options such as `from="…"` in front) also counts as already there, which is the safe reading.
- **Alternatives considered:** Matching the whole line (duplicates under other comments). Parsing every line (slower, and more to get wrong in `sh`).
