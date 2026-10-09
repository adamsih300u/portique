# Choose when the vault locks itself

- **Branch:** `feat/vault-auto-lock`
- **PR:** (draft, see GitHub)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

The vault already locked itself after a fixed 15 minutes without activity. Settings now has a **Vault** section where you pick the time: Never, 1, 5, 15, 30 minutes or 1 hour. The default stays 15 minutes.

## Why

Fifteen minutes suits most people, but some want it stricter and some want it off. A vault holding passwords and keys should lock by default, so the default stays on.

## What changed

- `window::Settings` gains `vault_idle_minutes` (0 = never). Older settings files get 15.
- `set_prefs` takes the new value and rejects anything outside the offered list.
- The background timer in `lib.rs` reads the setting on every tick, so a change applies at once with no restart. The fixed `IDLE_LOCK` constant is gone.
- The settings pane has a "Lock the vault after" dropdown.

## How to review

Start at `src/settings-ui.ts`, then the timer loop in `src-tauri/src/lib.rs`.

## What was tested

`tsc --noEmit` is clean and `cargo test --lib` passes, including a new test that old settings files get 15 minutes. I did not run the app by hand, so the dropdown and the live timer change are untested.

## Not done / follow-ups

- Lock on system sleep or screen lock, as a separate toggle. Detecting it differs by operating system, so it deserves its own branch.
- Open terminals are not affected by a lock; only the stored secrets are dropped. Whether a lock should wait for, or warn about, active sessions is left alone.

## Decisions

### D1. A short preset list, with 15 minutes as the default

- **Status:** accepted
- **Context:** The pane could take free-form minutes or a long list of presets.
- **Decision:** Never, 1, 5, 15, 30 and 60 minutes. Default 15.
- **Consequences:** Few choices to read, and the backend can reject anything else. A value outside the list needs a code change.
- **Alternatives considered:** 1, 2, 5, 10, 30, 60: the small steps are barely different. A number box: more room for odd values and bad input.

### D2. "Never" is allowed, but is not the default

- **Status:** accepted
- **Context:** Some people will not want a lock at all.
- **Decision:** Offer "Never" with a hint that the vault stays unlocked until you lock it or quit.
- **Consequences:** The tradeoff is the user's to make and is stated in the pane.
- **Alternatives considered:** Always lock: simpler, but takes away a choice.
