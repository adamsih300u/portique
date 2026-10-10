# Keep vault keys out of swap and dumps, and wipe the passwords the app receives

- **Branch:** `feat/vault-memory-hardening`
- **PR:** (not open yet; push is queued for after working hours)
- **Status:** draft
- **Author:** Claude, for Adam
- **Builds on:** [vault-sealed-memory](vault-sealed-memory.md), which this branch starts from

## Summary

The vault's two keys are now pinned in RAM and left out of core dumps, release builds on Linux refuse debuggers and memory reads from other programs, and the master password and other passwords the app receives are wiped after use. Nothing changes in how the app looks or behaves.

## Why

[vault-sealed-memory](vault-sealed-memory.md) listed three follow-ups: lock the key pages and turn off dumps, stop handing plain `String` copies around, and wipe what the user types. This branch does those. New record: [ADR-0015](../adr/0015-keys-pinned-and-process-hardened.md). Supports [ADR-0014](../adr/0014-secrets-sealed-in-memory.md).

## What changed

- New `memguard.rs`. `LockedKey` holds a 256-bit key alone in its own page: `mlock`ed, excluded from core dumps and zeroed in a forked child (Linux), wiped before it is freed. `harden_process` zeroes the core-dump limit and, on Linux, sets the process non-dumpable.
- `vault.rs`: the file key and the per-unlock key are `LockedKey`. Argon2 writes the file key straight into its page. The strength check wipes its copy of the password. A note goes to stderr if a page could not be pinned.
- `lib.rs`: `run` calls `harden_process` first, in release builds only. The vault, saved-password, key-import and connect commands take `Zeroizing<String>`, so the copy Rust receives is wiped on drop.
- `session.rs`, `ssh.rs`: `Params`, `AutoLogin` and `saved_password` carry `Zeroizing<String>`; the saved password is no longer cloned into a plain `String` on the way to the login.
- `Cargo.toml`: `libc` on Unix; `zeroize` with `serde`; `argon2` with `zeroize`, which wipes its 128 MiB work memory after each derivation.

## How to review

`memguard.rs` first, mostly the `unsafe` blocks and `Drop`. Then `derive` and `Secrets::new` in `vault.rs`.

## What was tested

`cargo test --lib`: 47 passed, 4 ignored (they need a local sshd; not run). The 7 new tests check that a key is written and read in place, that random keys differ, that each key has its own page, that `VmLck` in `/proc` rises while a key is held (locking really happened on this machine), and that hardening sets the core limit to zero and the process to non-dumpable. `cargo clippy --all-targets` is clean. I did not run the app (no display here), a release build, or anything on Windows or macOS.

## Not done / follow-ups

- **The non-dumpable setting is untested against the real window.** It should not matter to WebKitGTK's child processes, but I could not start the app to check. Try a release build on Linux before merging; `PORTIQUE_ALLOW_DEBUG=1` turns it off.
- **Windows and macOS do not pin pages** (`VirtualLock` needs a Windows build to check) and macOS lacks the debugger refusal (`PT_DENY_ATTACH`). Separate branch.
- **Copies we cannot wipe:** Tauri parses each request's JSON before our code sees it, the webview holds what the user typed, the AEAD cipher and zxcvbn make internal copies, and the SSH library and API sender keep the plain value for the length of a request. russh wipes its own password copy once sent. Sending secrets as raw bytes the page can zero (instead of JSON) would close part of the IPC gap.
- The terminal auto-login for Telnet and serial still builds the typed line as a plain `Vec<u8>` for the output channel.
- Hibernation images are not covered by `mlock`.

## Decisions

### D1. Pin keys in their own pages; harden only release builds

- **Status:** accepted, recorded as [ADR-0015](../adr/0015-keys-pinned-and-process-hardened.md)
- **Context:** `mlock` works on whole pages, and unlocking one page releases every lock on it, so two keys sharing a page could unpin each other.
- **Decision:** One page per key, about eighty lines of `unsafe` in one file. Process hardening is skipped in debug builds and by an environment variable.
- **Consequences:** Two pages of locked memory per unlocked vault, well under the usual limit. Developers keep their debugger.
- **Alternatives considered:** See the ADR.

### D2. Wipe our copies; do not chase the library's

- **Status:** accepted
- **Context:** The SSH library and request sender need an owned `String`.
- **Decision:** Hold every secret in a `Zeroizing<String>` on our side up to the library call and stop there. The HTTP path is left unchanged: reqwest takes the expanded request by value and there is nothing of ours left to wipe.
- **Consequences:** Fewer long-lived plain copies, honest about the rest.
- **Alternatives considered:** Forking the libraries to wipe: far more cost than it buys.
