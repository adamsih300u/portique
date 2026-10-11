# Toolbox: network checks, generators and converters in the command palette

- **Branch:** `feat/palette-toolbox`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The command palette gains a *Toolbox*: twenty small tools that each open in a dialog with a *Copy* button. Four check the network from this computer (port check, TCP ping, DNS lookup, Wake-on-LAN). The rest need no network: a password, token and UUID generator, Base64 / URL / hex converters, text hashes, a JWT reader, a time converter, JSON format and minify, a cron explainer and a subnet calculator. They are the same on Windows and Linux because they run in the interface or in Rust's standard library and tokio.

## Why

The request, after a brainstorm: "build out the easy ones, including Port check / DNS lookup / TCP ping into a Toolbox category in the command palette". The palette already has a hook for entries built from typed text ([palette-quick-connect](palette-quick-connect.md), [profile-commands](profile-commands.md)); this adds the family of tools those changes left for later.

Constrained by the standing decision to keep the interface quiet: no new buttons, only the palette ([ADR-0009](../adr/0009-italic-is-the-apps-voice.md) and the "quiet" rule in `AGENTS.md`). Supported by [ADR-0005](../adr/0005-interface-follows-the-look.md): the dialog and its output use interface variables only (checked on Nuit and Ivoire). [ADR-0003](../adr/0003-secrets-never-read-back.md) is not touched: the tools never read the vault, and a generated password is not stored. No record conflicts.

## What changed

- **`toolbox.rs` (new, no new dependencies):** `tool_dns` (the system resolver, IPv4 first), `tool_ports` (up to 64 ports at once, 3 s each), `tool_tcp_ping` (up to 20 connects, a second apart) and `tool_wake` (a UDP magic packet to port 9). Registered in `lib.rs` and wrapped in `api.ts`. They need no capability entry because they are app commands.
- **`toolbox-core.ts` (new):** all the logic, with no interface in it: password and token generation (rejection sampling on `crypto.getRandomValues`), encodings, hashes, JWT, time, cron, subnets, the parsing of the network tools' input, and the text of their results. `toolbox-core.test.ts` covers it (22 tests).
- **`toolbox.ts` (new):** the tool list and one dialog for all of them: an input if the tool wants one, the answer below, *Copy*. "Live" tools answer as you type; the network tools run on Enter or *Run*; generators have an *Another* button.
- **`palette.ts`:** `PaletteItem.only` (`"browse"` or `"search"`) and an `initial` text for `openPalette`. `main.ts` adds one *Toolbox…* row to the default list and every tool as a search-only entry.
- **Docs:** `using-portique.md`, the code-layout tables.

## How to review

Start with `toolbox.rs` (small), then the input parsers in `toolbox-core.ts` (`parsePortCheck`, `splitHost`, `parsePing`), which decide what text reaches the network commands. Look hardest at `exec` in `toolbox.ts`: a `turn` counter drops an answer that arrives after the person has typed something else or closed the dialog.

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (56 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings` and `cargo test --lib` (43 passed, 4 ignored as before; six are new and use local sockets: an open port, a refused port, a ping, a wake packet to loopback, MAC parsing, the packet's layout).

In a headless browser (`vite preview`, mocked `window.__TAURI_INTERNALS__`) on the Nuit and Ivoire looks: the default list shows *Toolbox…* and no tool rows; choosing it fills the box with "Toolbox "; typing finds tools by name or keyword; the subnet, port-check, ping-error, UUID (*Another*, Esc), password and Base64 dialogs behave and look right.

**Not run:** the real backend commands from the app (the mock answered them), Windows, a real Wake-on-LAN broadcast, a lookup that fails or times out, and the clipboard buttons (the headless browser has no clipboard permission). The 30-second clipboard clear is untested.

## Not done / follow-ups

- Tools that need a library or the vault: a certificate check (needs TLS parsing), SSH keypair generation into the vault, and a passphrase generator (needs a word list).
- Tools that run on a server over an open SSH session (system facts, services, containers, logs), and running a snippet on several hosts.
- Wake-on-LAN could remember a MAC address in a profile, and the network tools could run through a profile's jump host.
- IPv6 in the subnet calculator, and reverse DNS (the standard library has no reverse lookup).
- A name typed in the palette (`port nas 22`) does not run a tool directly; it opens the tool's dialog.
- A *Toolbox* query shows "Connect to Toolbox" at the bottom, from quick connect's rule that a bare word may be a host. It is harmless but untidy.

## Decisions

### D1. Tools are search-only in the palette, with one *Toolbox…* row to browse them

- **Status:** accepted
- **Context:** Twenty tools would more than double the default palette list, which is mostly hosts and tabs. The interface is meant to stay quiet.
- **Decision:** `PaletteItem.only` hides a search-only item from the unfiltered list. One *Toolbox…* row, shown only while nothing is typed, reopens the palette with "Toolbox " in the box, which lists them all (the group name is searched). Typing a tool's name or a keyword finds it directly. Recents still include tools.
- **Consequences:** The default list is unchanged and tools are one keystroke from view. A new family of commands can use the same flag. The "Toolbox " text is visible in the box, which is a small price for needing no new mode.
- **Alternatives considered:** Listing every tool in the default list (noisy). A `>` prefix mode (a new concept to learn and to document). A sub-menu (a second list component for one use).

### D2. Network checks run in Rust from this computer, using only the standard library and tokio

- **Status:** accepted
- **Context:** The interface cannot open raw sockets, and a check from the webview would be limited by the browser's rules. A certificate check or ICMP ping would need extra crates or privileges, which would not be the same on Windows and Linux.
- **Decision:** `toolbox.rs` uses `tokio::net` for name lookups, TCP connects and a UDP broadcast. "Ping" is a TCP connect, which needs no privileges and works where ICMP is blocked.
- **Consequences:** No new dependency and the same behaviour on both systems. The answers describe this computer's view of the network, not a server's. A TCP ping measures connection setup, not ICMP round trip, and the dialog says so.
- **Alternatives considered:** Calling the system `ping` or `nslookup` (output differs per system and has to be parsed). A resolver crate for record types other than addresses (a dependency for a rare need). ICMP through a raw socket (needs administrator rights).

### D3. The clipboard is written, never read, and a copied password is cleared after 30 seconds

- **Status:** accepted
- **Context:** A tool that reads the clipboard to save a paste would show whatever was last copied, which may be a secret. A generated password left on the clipboard stays there until something replaces it.
- **Decision:** The dialogs never read the clipboard to fill an input; the person pastes. Tools marked `secret` (password, token) read it once, 30 seconds after copying, and clear it only if it still holds what they copied. If it can't be read they leave it alone.
- **Consequences:** One more keystroke (Ctrl+V). A password is not left on the clipboard for long, and something the person copied since is never wiped. The timer stops if the app closes first.
- **Alternatives considered:** Prefilling from the clipboard (a surprise, and a leak onto the screen). Clearing blindly (would wipe an unrelated copy). Never clearing (the old behaviour of every generator).
