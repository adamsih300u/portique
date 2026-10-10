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

- New `memguard.rs`. `LockedKey` holds a 256-bit key alone in its own page: `mlock`ed, excluded from core dumps and zeroed in a forked child (Linux), or `VirtualLock`ed with a working-set raise and one retry (Windows), and wiped before it is freed. `harden_process` zeroes the core-dump limit and, on Linux, sets the process non-dumpable; on Windows it keeps the heap out of crash reports.
- `vault.rs`: the file key and the per-unlock key are `LockedKey`. Argon2 writes the file key straight into its page. The strength check wipes its copy of the password. A note goes to stderr if a page could not be pinned.
- `lib.rs`: `run` calls `harden_process` first, in release builds only. The vault, saved-password, key-import and connect commands take `Zeroizing<String>`, so the copy Rust receives is wiped on drop.
- New `ipc.rs` and `src/secret-ipc.ts`: the master-password commands (`vault_create`, `vault_unlock`, `vault_change_password`, `vault_password_strength`) now receive the password as raw bytes, not JSON. Each secret is a 4-byte little-endian length plus UTF-8 bytes; the page zeroes its bytes after the call, and Rust copies each into a `Zeroizing<String>`. `accept-older` moved to a header.
- `session.rs`, `ssh.rs`: `Params`, `AutoLogin` and `saved_password` carry `Zeroizing<String>`; the saved password is no longer cloned into a plain `String` on the way to the login.
- `Cargo.toml`: `libc` on Unix; `windows-sys` on Windows (already in the lockfile at 0.59); `zeroize` with `serde`; `argon2` with `zeroize`, which wipes its 128 MiB work memory after each derivation.

## How to review

`memguard.rs` first, mostly the `unsafe` blocks and `Drop`. Then `derive` and `Secrets::new` in `vault.rs`, then `ipc.rs` with `secret-ipc.ts` side by side (a shared byte fixture is pinned in both test files).

## What was tested

`cargo test --lib`: 51 passed, 4 ignored (they need a local sshd; not run). `npx tsc --noEmit` is clean and `npx vitest run` passes (23). The 11 new Rust tests check that a key is written and read in place, that random keys differ, that each key has its own page, that `VmLck` in `/proc` rises while a key is held (locking really happened on this machine), and that hardening sets the core limit to zero and the process to non-dumpable, and that the raw-bytes reader accepts what the page encodes and rejects short, long, truncated and non-UTF-8 payloads. I confirmed in Tauri's source that a `Uint8Array` is sent as a raw body with the headers kept, but I did not run the app, so the unlock, create and change-password dialogs have not been exercised end to end. `cargo clippy --all-targets` is clean. I built the Windows target (`x86_64-pc-windows-gnu`): `cargo clippy --all-targets` is clean and the test binary compiles and links. I did not run it (no Wine here), so whether `VirtualLock` succeeds on real Windows is unchecked; a Windows-only test, `windows_pins_several_pages_even_past_the_default_working_set`, will say. I also did not run the app (no display here), a release build, or anything on macOS.

## Not done / follow-ups

- **The non-dumpable setting is untested against the real window.** It should not matter to WebKitGTK's child processes, but I could not start the app to check. Try a release build on Linux before merging; `PORTIQUE_ALLOW_DEBUG=1` turns it off.
- **Windows pinning is compiled, not run.** Run `cargo test --lib memguard` on a Windows machine. Windows also has no per-page dump exclusion, and no equivalent of the Linux debugger refusal is set.
- **macOS does not pin pages** and lacks the debugger refusal (`PT_DENY_ATTACH`). Separate branch, since it needs a Mac to check.
- **Copies we cannot wipe:** Tauri parses each request's JSON before our code sees it, the webview holds what the user typed, the AEAD cipher and zxcvbn make internal copies, and the SSH library and API sender keep the plain value for the length of a request. russh wipes its own password copy once sent. Only the master-password commands send raw bytes; saved passwords, key import and connect-time passwords still go as JSON, since they are one-way and rare. What the user typed also stays in the page as a string, which JavaScript cannot wipe, and Tauri keeps the raw buffer inside its `Request` unwiped.
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

### D3. Raw bytes for the master password only

- **Status:** accepted
- **Context:** Tauri builds a JSON string and then a parsed value for every argument, and neither can be wiped. The master password protects everything else.
- **Decision:** Send only the master-password commands as raw bytes in one framing, written in one helper on each side and pinned by a shared byte fixture.
- **Consequences:** Removes the JSON text and the parsed value for the one secret that matters most, and lets the page zero the encoded bytes. The typed string and Tauri's own buffer remain, so this narrows the gap and does not close it.
- **Alternatives considered:** Converting every secret-carrying command: more wire format for one-way, rare secrets. Leaving it as JSON: simplest, but leaves two more unwiped copies of the master password.
