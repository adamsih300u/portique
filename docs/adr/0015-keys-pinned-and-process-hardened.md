# ADR-0015: Vault keys live in locked pages and release builds refuse same-user debugging

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`vault-memory-hardening`](../changes/vault-memory-hardening.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0014 (builds on: it named swap and core dumps as the gap this closes)

- **Context:** ADR-0014 sealed secrets in memory, but the two keys that open them (the file key and the per-unlock key) were ordinary heap values. The OS could write them to swap, and a crash could put them in a core dump. Another program running as the same user could also attach a debugger and read the process.
- **Decision:** `memguard.rs` keeps each key alone in its own page, pinned with `mlock`, excluded from core dumps and wiped on fork (Linux), and zeroed before the page is freed. On Windows the page is pinned with `VirtualLock`, raising the minimum working set first when the default is too small. Release builds also set the core-dump limit to zero and, on Linux, mark the process non-dumpable; on Windows they keep the heap out of crash reports. Setting `PORTIQUE_ALLOW_DEBUG` skips the process step, and debug builds never apply it.
- **Consequences:** Swap and core dumps no longer hold the keys, and a same-user debugger or `/proc/<pid>/mem` read is refused on Linux. A user who needs a debugger on a release build must set the variable. Locking is best effort, so a low memory-lock limit leaves the app working and prints a note. macOS only gets the wiping for now. Windows has no per-page dump exclusion, so a full dump taken by a debugger or other tool outside crash reporting still holds the key page.
- **Alternatives considered:** Locking the whole heap with `mlockall`: pins far more than the keys and fails under small limits. A crate such as `memsec`: another dependency for about eighty lines of `unsafe`. Leaving it to the OS keyring: breaks copying the vault between machines, as ADR-0014 found. Hardening debug builds too: stops the developer's own debugger.
