# Documentation: a page for the command palette, and a code-checked pass over the rest

- **Branch:** `docs/command-palette` (stacked on `feat/install-public-key`)
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The command palette now has its own page, [docs/command-palette.md](../command-palette.md), in place of one 4,000-character bullet in the guide. Every user-facing document was then checked against the code, and what didn't match was corrected: the guide, the API client guide, the README, the contributor docs and the in-app shortcut panel.

## Why

The request: confirm the palette documentation is accurate, clean and conversational, and make sure all user documentation covers what exists and only that. The palette bullet had grown with each feature into something nobody could scan, and a read-through against the code found a number of statements that were wrong or missing.

Supports [ADR-0008](../adr/0008-short-readme.md): the README stays short and links to `docs/`, and gains one link and a corrected "Try it". No record conflicts. This branch describes the features on the stacked branches below it (the toolbox, the server tools), so it can only merge after them.

## What changed

- **New `docs/command-palette.md`.** Sections by task: finding things, quick connect, saved commands, find in the terminal, the toolbox (tools in tables by kind: what you type, what you get), server tools (looking, changing, following a log, what each server needs) and "good to know". Every entry title, limit and key in it is taken from the code.
- **`docs/using-portique.md` restructured under headings** (Connections, Terminals, File browser, The command palette, Looks and settings, Security and your data, Shortcuts), with the palette reduced to a paragraph and a link.
- **Corrections to the guide:** the connection-loss timeout is about 45 seconds, not a minute; the sign-in choices are Password, Private key and Private key + password (keyboard-interactive is an automatic fallback); the `⇄N` badge is on the tab and counts all its panes; vault auto-lock is a setting; the files to copy to another machine now include `known_hosts.json` and `api.json`; the themes entry is *Colour themes…*; drop-down mode is no longer called "borderless" or limited to "X11"; only terminal tabs split and restore; the profile menu differs by kind; the first connection asks you to accept the host key; a blank server start folder means the login folder; and several other details listed in the commit.
- **Now covered:** tab numbering, drag-reorder, middle-click and the unread highlight; the profile search box; sidebar groups; transfer-list controls; the file browser's extra keys; the Tabs-colours option; text size limits.
- **`docs/api-client.md`:** OAuth no longer claims to retry on a 401 (it forgets the token and the next Send signs in again); a hand-written `Authorization` header wins; added the response view, the rail filter and drafts, *Duplicate…*, *No authentication*, variable-name rules, import details (file types, merging, curl flags), and a section on the palette. The "not built yet" list was checked item by item and is still accurate.
- **`README.md`:** "Try it" described a Windows cross-build as running from source and had a stray command block under *Licence*. It now says how to download (zip with `portique.exe`, `.tar.gz`, AppImage, `.deb`, from the Releases page) and how to run from source, and links the new page.
- **`CONTRIBUTING.md`, `AGENTS.md`:** the "no interface test runner" statements were wrong (vitest runs in CI); added Node 22, `npm test`, lint and clippy to the commands, and the files missing from the layout tables.
- **In-app text:** `help.ts` (F1) now lists the palette's find keys, the file browser's *Ctrl+A*, *Alt+↑* and multi-select, and the reconnect keys, and says prompt-jumping needs shell integration. The OAuth hint in the Auth tab and the key-install plan text were reworded to match what they do.

## How to review

Read `docs/command-palette.md` beside `paletteItems` in `main.ts` and the tool lists in `toolbox.ts` and `server-operate.ts`. For the rest, the diff is mostly edits to sentences that carry a number, a label or a key, and each can be checked against the file named in the reports below.

## What was tested

Four read-only agents each took a slice of the existing documents (connections and vault, the interface and shortcuts, the API client, the README and contributor setup) and checked every claim against the code, with file and line evidence. I re-checked their findings that changed a number or a behaviour before writing them in (the 45-second timeout, the badge location, the OAuth 401 behaviour, the lock choices, the file list), and two of their claims turned out to be wrong and were not used: the badge was said to be on the pane, and a button was said to be called "Clear done" (it is "Clear finished"). After writing, two more agents reviewed the new palette page and the rewritten guide independently. They found 17 further problems (including one contradiction in my own page about the clipboard), all fixed. A script checks that every relative link and `#anchor` in the six documents resolves. `tsc`, `eslint`, `vitest` (107 tests) and the build still pass after the small code-text edits.

**Not verified:** colours, strike-through and other styling claims in the API guide (CSS was not read); that Windows 10 and 11 include the WebView2 runtime (a general fact, not something in this repo); anything about Windows servers beyond what the code does; and the app was not run to compare the text with the screens.

## Not done / follow-ups

- The local branch `feat/palette-terminal-search` (search all open terminals with `?`) is not in this stack, so the documents don't mention it. Update the palette page when they merge.
- Screenshots. The pages are text only.
- The guide's *Using Portique* is now organised by heading but is still long; a split into pages per area (connections, terminals, files) would be a natural next step.
- A docs check in CI (links, and a test that every palette title in the page exists in the code) would catch drift.

## Decisions

### D1. The palette gets its own page, and the guide links to it

- **Status:** accepted
- **Context:** The guide listed each feature as one bullet. The palette grew from a search box into quick connect, saved commands, a toolbox and server tools, and its bullet became 4,000 characters of run-on text with no headings and no way to link to a part of it.
- **Decision:** `docs/command-palette.md` holds the palette's documentation, organised by what a person wants to do, with tables for the tools. The guide keeps a paragraph and a link, as it does for the API client.
- **Consequences:** The page can grow with the palette and be linked to by section. A new palette feature now has one obvious place to be documented; a change to a tool's title or limit must also change this page.
- **Alternatives considered:** Keeping everything in the guide (already unreadable). One page per tool family (too many small pages for tools that share conventions).

### D2. Documentation is checked against the code, not against memory or older documentation

- **Status:** accepted
- **Context:** Several statements in the existing documents were wrong or stale (a timeout, a badge, a retry behaviour, a "no test runner" claim). Documents written from memory of how something was meant to work drift from how it works.
- **Decision:** Each claim about a label, key, number, default or behaviour was checked in the code before it was kept or written, by reading the code or by an agent that cited file and line, and checked a second time by a reviewer who had not seen the first pass. Findings that would change the text were confirmed directly before use.
- **Consequences:** The pages are as accurate as the code was when they were written, and the change records what could not be checked. They will drift again as the code changes; D1's rule that a changed title or limit changes its page is the guard.
- **Alternatives considered:** One careful read-through by the author (misses what the author already believes). Trusting the existing text where it looked right (kept the 45-second error).
