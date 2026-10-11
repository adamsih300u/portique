# Quick connect from the command palette

- **Branch:** `feat/palette-quick-connect`
- **PR:** (draft, see GitHub)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

Type a host or address into the command palette (Ctrl+Shift+P) and choose *Connect to…* to open it in a new tab without saving a profile. The tab is named after the host. The palette also gains a general hook for entries built from the typed text, which later toolbox commands (a name lookup, say) can use.

## Why

Reaching a one-off machine meant creating a profile, then deleting it. The palette already lists hosts, so it is the natural place to type an address. It supports [ADR-0003](../adr/0003-secrets-never-read-back.md): a quick-connect host never stores a secret. It follows the standing decision to keep the interface quiet: no new buttons, only the palette.

## What changed

- `src/quick-connect.ts` reads `[ssh://|telnet://][user@]host[:port]`, with IPv4, IPv6 (brackets when a port follows) and host names. Tests are in `quick-connect.test.ts`.
- `store.rs` keeps quick-connect profiles in memory (`add_quick`, id prefix `quick:`) and `get_profile` looks there first, so splits, reconnects and the file browser work with no other change. `quick_profile` in `lib.rs` is the only new command. Nothing is written to `profiles.json`.
- `palette.ts` gets `PaletteHooks.dynamic(query)` and `PaletteItem.pin`. `main.ts` uses them for the *Connect to…* row.
- While a quick-connect tab is focused, the palette offers *Save … as a profile…*, which opens the usual editor.
- `host-prompts.ts` no longer offers "Save in encrypted vault" for these hosts.

## How to review

Start with `parseQuickTarget` and its tests, then `add_quick` in `store.rs`. Look hardest at what `add_quick` strips from the incoming profile (jump host, forwards, key, group, API settings).

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (24 tests), `npm run build`, and `cargo test --lib` (28 passed, 4 ignored as before), including a new test for `add_quick`. **Not run:** the app itself, a real SSH or Telnet connection, Windows, and the palette on a light look.

## Not done / follow-ups

- Quick-connect tabs are not restored after a restart: their profile no longer exists, so the saved layout skips them.
- Quick connect uses password sign-in only. A key needs a saved profile.
- Saving a quick host leaves the open tab on its temporary profile until it is reopened.
- Per-profile saved commands and toolbox commands are separate branches.

## Decisions

### D1. Quick-connect hosts are in-memory profiles in Rust

- **Status:** accepted
- **Context:** Every session path (terminal, split, reconnect, file browser, proxy) starts from a profile id that Rust loads from disk. A host that is not saved has no id.
- **Decision:** `add_quick` registers a sanitised profile under a `quick:` id for the life of the app. `get_profile` finds it before reading the disk.
- **Consequences:** Every existing path works unchanged and nothing reaches the disk. The registry grows by one small entry per quick connect until the app quits. Code that lists profiles never sees these hosts.
- **Alternatives considered:** Saving a hidden profile would leave clutter and a stored secret trail. Passing a full profile into each connect command means changing five commands and the reconnect logic.

### D2. A bare word is offered last, not first

- **Status:** accepted
- **Context:** Any single word is a valid host name (`nas`), so a first-place *Connect to…* row would bury real matches while someone types a command.
- **Decision:** Text that is plainly an address (an IP, a dotted name, or one with a scheme, user or port) pins the row to the top. A bare word pins it to the bottom.
- **Consequences:** `nas` still connects with one more keypress, and typing `split` never shows it above *Split right*.
- **Alternatives considered:** Always on top (noisy). Only for dotted names (LAN names without a dot would need a profile).
