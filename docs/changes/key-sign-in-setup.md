# Set up key sign-in to a server in one step

- **Branch:** `feat/key-sign-in-setup` (stacked on `feat/generate-keys`)
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

*Set up key sign-in…* in the palette's server tools moves a connected profile from a password to a key without leaving Portique. It makes a new key (or uses one from the vault), puts its public half on the server, signs in once more with the key alone to prove the server accepts it, and only then changes the profile to sign in with that key. If the proof fails, the profile is left exactly as it was.

## Why

[generate-keys](generate-keys.md) lets Portique make a key and hand out its public half, and [install-public-key](install-public-key.md) puts a key on a connected server. Together they still leave the person to run three tools, edit the profile by hand and hope. The risk in that last step is the one that matters: switching a profile to a key the server doesn't accept locks the person out of their saved connection. This change joins the steps and puts the proof between "key installed" and "profile switched".

Records that constrain it: [ADR-0003](../adr/0003-secrets-never-read-back.md) (the private key never reaches the interface: only the public half is fetched, and the check runs in Rust), [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md) (the one server command runs on a new channel of the open connection) and [ADR-0012](../adr/0012-server-changes-show-their-command-first.md) (the dialog states what will happen and nothing runs until the button is pressed). On ADR-0012: the plan lists every step in words and does not print the install script, the same as the existing install tool does and for the same reason (the script is a few lines of `sh` with markers for Portique to read). It has no "Type it in the terminal" button, since a four-step flow can't be typed. No record is contradicted.

## What changed

- **`ssh.rs`:** `check_key(profile, key_id)` opens a connection the way a session does (jump hosts included), signs in with that key and nothing else, and disconnects. It runs with `pinned_hosts_only` (new on `Params`): nobody is watching, so a host key that isn't pinned is refused instead of asked about, and a changed key is refused as always. 30 seconds in all. `check_key_login` in `lib.rs` and `checkKeyLogin` in `api.ts` expose it; it returns nothing but success or the reason.
- **`key-setup-core.ts` (new, tested):** `chooseKey`, `planSetup` and `setUpKeySignIn`, which runs the steps in order with what they need passed in. A failure reports what was already done and what to do next.
- **`server-operate.ts`:** the tool. **`server-run.ts`:** `Host` gains `profile` (the saved profile's id) and `profileChanged()`; **`main.ts`** passes them, and the profile list reloads when a tool changes a profile. **`toolbox.ts`:** an action tool may set `blank`, so an empty box means "the usual case" and shows its plan.
- **`server-keys-core.ts`:** `readInstallKey` returns what the script reported; `formatInstallKey` is built on it and says what it said before.
- **Docs:** `command-palette.md`, `using-portique.md`, `CONTRIBUTING.md`.

## How to review

`ssh::check_key` first (what it signs in with, and that it can't prompt), then `setUpKeySignIn`, where the order of the steps is the safety property: the profile is touched only after `check` has passed. The tests in `key-setup-core.test.ts` state that order and every failure.

## What was tested

`npx tsc --noEmit`, `npm run lint` (0 errors, no new warnings), `npx vitest run` (150 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.

Against a real `sshd` (a throwaway one on loopback, `XDG_CONFIG_HOME` pointed at a scratch folder so the real vault was untouched), with ignored tests in `ssh.rs`:

- `check_key_tells_a_key_the_server_accepts_from_one_it_does_not`: refused before the host is trusted, refused before the server has the key, accepted after, a different key refused, an unknown key id refused.
- `key_sign_in_from_start_to_finish_against_local_sshd`: signed in with a bootstrap key; generated a key; ran **the interface's own install script** (bundled from `server-keys-core.ts`, with the new key's data swapped in) over the open session's `exec`; the key landed in `authorized_keys` beside the one that was there, with modes 700 and 600; `check_key` signed in with the new key alone; a second run said "already" and changed nothing.
- The earlier `key_auth_against_local_sshd` and `exec_beside_a_shell_against_local_sshd` still pass.

In headless Chromium against a mocked backend, through the real palette and a mocked connected session: the plan for an empty box, a successful run (the profile saved with `authMethod: "key"` and the new key's id; the check called once with the profile and key; the script sent holds the key's public line and the `portique:` comment), and a rejected key (the profile not saved, the error listing what was done).

**Not run:** the real `check_key_login` and `generate_key` commands from the window (the sshd tests call the Rust functions directly; the page used mocks); a server with a password only (the test server accepts keys only, so the starting credential was a key); a jump host in the check; a passphrase-protected key; a server where sshd accepts the key but refuses the account for another reason; Windows servers (refused with a message); a light interface look.

## Not done / follow-ups

- Windows servers: administrators' keys live in a different file there, as in [install-public-key](install-public-key.md).
- It sets the profile to *Private key*. A profile that was *Private key + password* ends up key-only; the password stays saved.
- Removing the saved password once the key works, in the same step. Left to the person, since a password is the only way back in if the key is later deleted.
- Removing a key from a server.
- The dialog keeps its *Set up* button after a run; pressing it again with an empty box reports that the key's name is taken and tells the person to type it.

## Decisions

### D1. The profile changes only after a key-only sign-in succeeds

- **Status:** accepted
- **Context:** Installing a key does not mean the server will accept it: `PubkeyAuthentication no`, a home folder others can write to, or a security module can each make sshd ignore a key that is on file. Switching a profile first would leave a saved connection that no longer signs in.
- **Decision:** `setUpKeySignIn` runs `check` between installing and switching. `check` is a separate connection signing in with the key alone, so it proves what the next connection will do, not what this one already did.
- **Consequences:** A failed setup costs nothing but a key in the vault and a line on the server, both reported. A profile is never left pointing at a key that doesn't work. It costs one more connection, and needs the server's host key to be pinned, which an open session guarantees.
- **Alternatives considered:** Switching first and reporting afterwards (a lock-out on any server quirk). Trusting the installer's "added" (it proves the file was written, not that sshd reads it). Testing over the open session (it is already signed in, so it proves nothing about the key).

### D2. The check never asks about a host key

- **Status:** accepted
- **Context:** `check_key` runs in the background with no terminal to show a host-key prompt in. A prompt nobody sees would wait two minutes and then fail.
- **Decision:** `Params.pinned_hosts_only` makes an unpinned host key a refusal with a plain message. A changed key is refused as in every other session.
- **Consequences:** The check can't pin a key by accident, and it fails fast. It works for any host that has an open session, which is how the tool reaches it.
- **Alternatives considered:** Showing the prompt through the open session (a second dialog to explain in the middle of a flow). Skipping host-key checking for the check (it would make this the one connection Portique makes unverified).

### D3. Empty input means "make a new key named after the profile"

- **Status:** accepted
- **Context:** The usual case is a profile with no key. Asking the person to invent a name first adds a step, but a typed name is how they reuse a key.
- **Decision:** An empty box makes a key named after the profile; a name selects a key the vault has (the same matching as *Install a key*). If a key of the profile's name already exists, the tool says so and asks for its name. Action tools may declare `blank` to allow this.
- **Consequences:** One press of the button in the common case. A second run after a partial failure needs the key's name typed, and the messages say so.
- **Alternatives considered:** A separate "new key" field (two inputs in a small dialog). Reusing a key of the same name silently (it could pick a key meant for something else).

### D4. The saved password is kept

- **Status:** accepted
- **Context:** After the switch, the password is no longer used, and a saved password is a secret that could be removed.
- **Decision:** The tool leaves it in the vault and says so.
- **Consequences:** If the key is later deleted or the server's file is cleaned, the person can switch back by editing the profile. The cost is a secret that stays until they remove it.
- **Alternatives considered:** Deleting it on success (removes the only way back, on the person's behalf, in a tool whose plan doesn't offer that).
