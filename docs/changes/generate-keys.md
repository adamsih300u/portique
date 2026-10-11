# Generate a key in the vault, and hand out its public half

- **Branch:** `feat/generate-keys`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

*SSH keys…* can now **generate** a key (Ed25519, made and kept inside the vault) as well as import one. Right-click any key to show, copy or save its public half, or to copy one command that installs it on a server Portique is not connected to. Before this, a key had to be made elsewhere with `ssh-keygen` and imported, and its public half could only reach a server through the palette's install tool on an open connection.

## Why

Key sign-in should be possible from start to finish inside Portique. The install tool ([install-public-key](install-public-key.md)) already puts a vault key on a connected server, but nothing made a key and nothing gave its public half to a server Portique can't reach yet. This is the first of two changes; the second change joins generation, installation, a check and the profile switch into one step.

[ADR-0003](../adr/0003-secrets-never-read-back.md) supports and constrains it: the private key is made in Rust and never returned, and the only thing the interface can fetch is the public half. [ADR-0005](../adr/0005-interface-follows-the-look.md) governs the dialog's colours (variables only), and the standing rule that the interface stays quiet is why the actions are a context menu, not a button on every row. No record conflicts.

## What changed

- **`keys.rs`:** `keys::generate(name)` draws 32 bytes from the operating system's random source, builds an Ed25519 key, and stores it through `import`, so a generated key is indistinguishable from an imported one (same vault accounts, same `keys.json` entry). Names are trimmed and must be new, because the palette picks keys by name. `generate_key` in `lib.rs` and `generateKey` in `api.ts` expose it; only the name, fingerprint and id come back.
- **`server-keys-core.ts` (tested):** `publicLine` (the public key as one line with Portique's comment), `publicFileName` (a safe `.pub` name) and `installCommand` (the paste-in command). All three refuse anything that isn't a public key line.
- **`key-public.ts` (new):** the *Public key* dialog and the copy and save actions. **`editors.ts`:** a *Generate a new key* section, a right-click menu on each key, and, after generating, the public key dialog opens at once.
- **Docs:** `using-portique.md`, `CONTRIBUTING.md`, `command-palette.md`.

## How to review

`keys::generate` and `new_name` first, then `installCommand` in `server-keys-core.ts`: it is text a person pastes into a root-adjacent shell, so read what it creates, the modes it sets and how the key's name is kept out of the shell. The dialog code is plain DOM.

## What was tested

`npx tsc --noEmit`, `npm run lint` (no new warnings), `npx vitest run` (137 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.

`installCommand` runs under a real `sh` with a temporary home folder: creates `.ssh` at 700 and the file at 600, adds the key once and reports a repeat, keeps other lines (a final line with no newline included), recognises the key under another comment, stops when the folder can't be made, and a hostile key name does not become code.

Against a real `sshd` (a throwaway one on loopback, with `XDG_CONFIG_HOME` pointed at a scratch folder so the real vault was untouched): a key made by `keys::generate`, with only its public half authorized, signs in and runs a command. The ignored test `a_generated_key_signs_in_to_local_sshd` does this; a second key with the same name is refused.

The dialogs were checked in headless Chromium against a mocked backend, in the default dark look: the key list, the generate section, the right-click menu and the public key dialog.

**Not run:** the real `generate_key` command from the window (the browser used a mock; `keys::generate` is covered by the sshd test), a light interface look, the file-save dialog and the clipboard buttons (they need a real window), Windows and macOS.

## Not done / follow-ups

- Exporting a **private** key. Not offered: it would put a secret in the interface (ADR-0003). A person who needs the same key on another computer generates a second key there.
- Other key types (RSA, ECDSA). See D1.
- A passphrase on a generated key. See D1.
- Import still accepts a name that is already in use; only generating refuses it.
- The public key dialog shows the key only for keys whose passphrase the vault has; for others it explains and stops.

## Decisions

### D1. Generate Ed25519 keys only, with no passphrase of their own

- **Status:** accepted
- **Context:** A key generator has to choose algorithms and decide about passphrases. Every OpenSSH from 6.5 (2014) accepts Ed25519. RSA keys are slow to make, and the `rsa` crate carries an advisory the project already ignores in CI ([audit-ignore-rsa](audit-ignore-rsa.md)). A passphrase stored in the same vault as the key adds nothing, and one that is not stored makes every connection ask for it.
- **Decision:** `generate` makes Ed25519 keys and stores them unencrypted inside the vault, which encrypts them at rest.
- **Consequences:** One short, fast, widely accepted key type, and a key that signs in without prompting. A server old enough to lack Ed25519 needs an imported key. A generated key's protection is the vault's: the master password and its lock.
- **Alternatives considered:** Offering RSA and ECDSA (more code and a slow RSA path, for servers that are now rare). A passphrase option (a stored passphrase is no protection, and a typed one breaks automatic sign-in).

### D2. The actions live in a right-click menu, and a new key opens its public key dialog

- **Status:** accepted
- **Context:** Each key row already has a Delete button, and the interface is meant to stay quiet. Four more actions per row would crowd it, yet a hidden menu is hard to find, and the first thing a person wants after generating a key is its public half.
- **Decision:** The actions are on a right-click menu, with a line under the list saying so. Generating a key opens the *Public key* dialog straight away, which holds the same three actions in buttons.
- **Consequences:** The key list stays as it was. A person who never right-clicks still meets the actions once, at the moment they need them.
- **Alternatives considered:** A button per row (clutter). A "Public key" button only (no way to copy in one step).

### D3. The install command is one `sh -c` word that holds only the public line

- **Status:** accepted
- **Context:** The command is pasted into whatever shell the account has (bash, zsh, fish, a restricted shell) on a server Portique has never seen.
- **Decision:** `installCommand` returns `sh -c '<script>'`, quoted as a single word, and builds the script only from a public key line that passed a strict check and a comment made from letters, digits and `. _ -`. It does the same things as the install tool's script: folder 700, file 600, nothing added twice (by the key, not its comment), other lines kept.
- **Consequences:** It behaves the same under any shell that has `sh` on the path, and a key's name cannot become code. It is a Unix command; a Windows server needs the key added by hand.
- **Alternatives considered:** A bare `echo … >> ~/.ssh/authorized_keys` (no modes, and it duplicates on a second paste). Reusing the install tool's script as it is (its output has markers for Portique to read, not for a person).
