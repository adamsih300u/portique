# Agent access: an MCP server that lets AI agents run terminals

- **Branch:** `feat/mcp-agent-terminals`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

Portique can now host a [Model Context Protocol](https://modelcontextprotocol.io) server so an AI agent can open terminals, run commands, read the output and answer prompts. It is off until **Settings… → Agent access** is ticked. Even then an agent can only use profiles marked through right-click → **Agent access…** (*Off*, *Ask me each time*, *Allow*), and only sessions it opened itself. Each session appears as a tab with an **agent** badge. The person sees every command, is asked first where the profile says so, and takes the keyboard by typing in the tab. The full guide is [docs/agent-access.md](../agent-access.md).

## Why

The request: what could it look like to have an MCP server involved to allow agents to run the terminals, followed by "build this out, cleanly, best-of-breed as you describe it". The design offered then (an in-app server, a stdio bridge, approvals that show the exact command, a takeover that pauses the agent, a per-profile switch, an activity log) is what this builds, with the safe answer to each open question: agent-owned tabs only, off by default.

Records read first. **Support:** [ADR-0010](../adr/0010-local-shells-start-by-id.md) (an agent can open only a local shell that Rust found and the settings turn on), [ADR-0003](../adr/0003-secrets-never-read-back.md) and [ADR-0014](../adr/0014-secrets-sealed-in-memory.md) (an agent names a profile and Rust signs in, so no secret reaches it), [ADR-0005](../adr/0005-interface-follows-the-look.md) and [ADR-0009](../adr/0009-italic-is-the-apps-voice.md) (the new dialogs use interface variables, upright labels and small-caps badge), [ADR-0008](../adr/0008-short-readme.md) (README gets one line). **Constrain:** [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md) and [ADR-0012](../adr/0012-server-changes-show-their-command-first.md). They govern the palette's server tools, which run on the person's own keystroke. They don't cover an agent, so they do not conflict, but their spirit is kept: in *Ask* mode the exact text is shown first and nothing runs until the person says yes. No password is entered or read. *Allow* is a per-profile choice the person makes, which is the design the maintainer asked for, not a departure from either record. No record is superseded. D1–D3 became [ADR-0016](../adr/0016-agent-access-is-off-and-per-profile.md), [0017](../adr/0017-agent-server-in-the-app-on-loopback.md) and [0018](../adr/0018-commands-finish-with-markers-in-the-open-shell.md).

## What changed

- **`session.rs`:** `Emitter` now holds a callback instead of only a Tauri `Channel`, so a session can stream into Rust (`Emitter::sink`) as well as to the page. Existing callers are unchanged.
- **`agent/` (new):**
  - `server.rs` is the loopback HTTP listener (`hyper`) with the token, `Host` and `Origin` checks, and the user-only `agent-endpoint.json`.
  - `mcp.rs` is JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`) and the nine tools.
  - `ops.rs` holds the operations behind them: open, run a command, type, read, wait, close.
  - `session.rs`, `transcript.rs` and `exec.rs` hold a session's state and history, a terminal emulator (`vt100`) for `read_screen`, the text cleaner, and the command markers and key names.
  - `approval.rs` holds the questions to the person. `shim.rs` is `portique mcp`, the stdio bridge.
  - `mod.rs` holds the policy, the registry, the in-memory activity log and the `Host` trait that lets all of it run under test without a window.
- **`window.rs`, `lib.rs`, `main.rs`:** settings `agent.enabled` and `agent.profiles`; commands `agent_status`, `agent_set_enabled`, `agent_set_mode`, `agent_answer`, `agent_attach`, `agent_takeover`, `agent_resume`, `agent_activity`, `agent_config`; `portique mcp` starts the bridge instead of the window; deleting a profile drops its access; the server starts at launch if enabled and its address file goes away on exit.
- **Interface:** `agent-ui.ts` and `agent-core.ts` (the question dialog, the access dialog, the activity and connect dialogs, the settings block); a tab can now show an agent's session (`terminal-tab.ts`, `panes.ts`) with an **agent** / **you** badge; profile menu item, tab-menu and palette entries; no new buttons outside the settings pane (the standing "interface stays quiet" rule in [AGENTS.md](../../AGENTS.md)).
- **Docs:** `docs/agent-access.md`, the tour, README line, code-layout tables, ADRs 0016–0018, *Standing decisions* in `AGENTS.md`.
- **Dependencies:** `hyper`, `hyper-util`, `http-body-util` (already in the tree through `reqwest`), `vt100`, `regex`, `subtle` (already in the tree). No MCP library.

## How to review

Start with `agent/server.rs` (`turn_away`: who is let in) and `agent/ops.rs` (`open_session`, `approve`, `run_command`: what an agent can do and when it must ask). Look hardest at the order of checks in `approve` and `writable`, and that both run again after a question was open. Then `agent/exec.rs` (the wrapper must never contain a marker whole, and `check_command` refuses control characters that could end a paste early), and `terminal-tab.ts` (`takeOver` only on real key events and paste, not on the terminal's own replies). `Emitter` in `session.rs` is the only change to an existing core type. Left alone on purpose: the SSH, local, telnet and serial session code; the vault.

## What was tested

- `cargo test --lib`: 144 pass (72 of them in `agent::`, all new), 5 ignored as before. They include real shells (`sh` and `bash` on a pseudo-terminal) for: a command's output and exit status; state carrying between commands; multi-line commands and loops; bracketed paste keeping tabs; a long output keeping both ends; a slow command returning `running` and being followed with `wait_for`; Ctrl+C freeing the next command; typing into a `read` prompt; a full-screen program shown by `read_screen`; the person's yes, no, "for this session" and a timed-out question; a no typing nothing; taking over, mid-command too; switching a profile off closing its sessions; a session that exits; the session cap. The HTTP server is tested over real sockets (token, wrong `Host`, `Origin`, method, size, content type, session ids, batches, the endpoint file's mode and removal), and the stdio bridge's loop, restart recovery and not-running reply. The agent tests ran six times in a row without a failure.
- `cargo clippy --all-targets -D warnings` is clean; `cargo check --target x86_64-pc-windows-gnu` compiles.
- `tsc --noEmit`, `npm run lint` (0 errors; warnings fell from 102 to 98), `npm test` (123, 13 of them new) and `npm run build` pass.
- The interface in a headless browser against the real bundle with a mocked backend: the question dialog (a command, a multi-line one, open, typed input, and one carrying `<img onerror>` that shows as plain text), the access dialog, the settings block, the connect and activity dialogs, an agent tab appearing with its history and badge, and a key press calling `agent_takeover` and the tab menu offering to hand it back.
- **Not run:** the real desktop app (no display here); a real agent program speaking to it; a real SSH server (host-key and saved-login paths are the existing code, reached through `session::start`); Windows or macOS (including `portique mcp` under the GUI subsystem on Windows); `zsh`; shells that are not POSIX (`run_command` refuses them by design, and that refusal is tested only through the dialect table); the 120-second question timeout (tested with a short one).

## Not done / follow-ups

- `run_command` for PowerShell, `cmd` and fish. The dialect is a small enum in `exec.rs`; each needs a wrapper that can be tested on that shell.
- A stateless `exec` tool for SSH profiles on the channel from [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md) (clean output, no shared shell).
- Letting an agent be given a tab the person opened, on request. It would need its own decision.
- MCP resources and prompts, streamed progress and cancellation (the server answers in the response, so long calls simply wait).
- An opt-in persistent activity log, if the maintainer wants one despite the secrets risk (see D6).
- A button to rotate the token without restarting; showing agent sessions in the sidebar.
- The bridge's behaviour when Portique crashes and another program takes its port: the bridge would send the dead run's token to it. The token is useless to anyone by then; a process-id check in the file would still be tidier.

## Decisions

### D1. Agent access is off by default, per profile, and stored outside the profile

- **Status:** accepted ([ADR-0016](../adr/0016-agent-access-is-off-and-per-profile.md))
- **Context:** An agent is a second pair of hands on the person's servers, and profiles are imported, duplicated and synced.
- **Decision:** `settings.json` holds `agent.enabled` and a map from profile id to `off`, `ask` or `allow`. The server runs only while enabled. An agent sees only profiles not `off` and uses only sessions it opened itself.
- **Consequences:** No profile can arrive with access already granted. An agent cannot drive the person's own tabs. Access follows the id, so it survives editing a host.
- **Alternatives considered:** A flag in the profile travels with imports and duplicates. A global switch is all or nothing. A read-only level cannot be enforced in a shell.

### D2. The server lives in the app, on loopback, with a stdio bridge

- **Status:** accepted ([ADR-0017](../adr/0017-agent-server-in-the-app-on-loopback.md))
- **Context:** An agent must share the person's sessions, logins and host-key questions, and programs speak stdio or HTTP.
- **Decision:** An in-app `hyper` server on `127.0.0.1` with a per-start token, `Host` and `Origin` checks and a user-only address file; `portique mcp` bridges stdio.
- **Consequences:** One vault and one set of prompts; the stdio configuration holds no secret; the app must be running; the HTTP token changes every start.
- **Alternatives considered:** A separate process (needs the vault), a socket or pipe (platform differences), an MCP library (heavy for this subset), a fixed port with a stored token (a long-lived secret on disk).

### D3. A command ends with markers typed around it in the open shell

- **Status:** accepted ([ADR-0018](../adr/0018-commands-finish-with-markers-in-the-open-shell.md))
- **Context:** A terminal has no end-of-command signal, the person must see what runs, and the shell's state must carry over.
- **Decision:** The command is typed in a brace group that prints begin and end markers with a nonce, built by `printf` from pieces so the echo never matches. POSIX shells only.
- **Consequences:** The command runs in the visible shell with its state; the wrapper shows in the tab; other shells use `send_input`.
- **Alternatives considered:** A separate exec channel, a prompt hook, waiting for quiet.

### D4. Taking over is by real keys and paste, and it pauses until handed back

- **Status:** accepted
- **Context:** The person must be able to stop an agent by using the terminal, but a terminal also sends bytes by itself (answers to a program's queries, focus reports).
- **Decision:** `TerminalTab` calls `agent_takeover` from xterm's key event and from paste and saved-command typing, not from `onData`. The pause is sticky: the agent's tools say the person has the keyboard until **Hand the terminal back** (or **Pause the agent** to do it without typing). A command in flight returns what it printed and `user-took-over`.
- **Consequences:** No accidental pause from terminal replies, and no race where an agent's keystroke lands in the middle of the person's. A stray key pauses an agent until it is handed back.
- **Alternatives considered:** Pausing for a few seconds after any input would let the agent continue under the person's hands. Treating every `onData` as a takeover would pause on the terminal's own replies.

### D5. Questions fail closed, and a dialog cannot be answered by accident

- **Status:** accepted
- **Context:** A dialog appears while the person is typing in another terminal; a key meant for that terminal must not approve a command.
- **Decision:** Silence for two minutes is a no, as is Escape or closing the dialog. At most eight questions wait at once. **Deny** is focused and the only live button for 700 ms. Text that could disguise a command (control characters, invisible and right-to-left characters) is spelled out in the question and the log. The agent is told a refusal is final and not to work around it.
- **Consequences:** An agent that asks and is ignored gets nothing. A long command with an unusual character looks odd on purpose.
- **Alternatives considered:** A default of allow after a timeout, or an enabled Enter-to-approve, trade the person's attention for the agent's convenience.

### D6. The activity log stays in memory

- **Status:** accepted
- **Context:** The log would show what agents ran and what was refused, but a command can contain a secret the agent chose to type, and the rules say no secret in a log.
- **Decision:** `agent::Audit` entries live in a 500-entry ring in memory, shown by **Agent activity…** and gone when Portique quits. The tab already shows everything live.
- **Consequences:** No file for a secret to leak from; no record after a restart.
- **Alternatives considered:** A log file with commands redacted cannot recognise a secret; a log of metadata only is of little use.

### D7. Nothing in the interface names a particular agent program

- **Status:** accepted
- **Context:** The wording rules keep the documentation to plain descriptions, and the configuration formats are shared by many programs.
- **Decision:** The connect dialog offers a `mcpServers` JSON entry, a one-line command and a web address with a token, not a recipe per product.
- **Consequences:** The same text works for any program that takes those forms; a person with a program that wants something else adapts it.
- **Alternatives considered:** A recipe per product dates quickly and names products we don't control.
