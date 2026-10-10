# Server tools, part 1: run commands on a connected host, and read its facts, processes and disk use

- **Branch:** `feat/ssh-exec-facts` (stacked on `feat/palette-toolbox`)
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

While an SSH terminal is connected, the command palette offers *Server tools…*: **Server facts** (system, uptime, load, memory, disks, listening ports, failed services, and a short "needs a look" list), **Top processes** and **Disk usage** for a folder. They run on that host over the connection the terminal already has, so there is no second login. This branch also adds the one new backend capability the later tools (services, containers, logs, key install) will use: run a command beside an open shell and return its output.

## Why

The request: "get hopping on the Tier 2 ones", the palette commands that run on the server rather than on this computer, from the brainstorm in [palette-toolbox](palette-toolbox.md). Facts, processes and disk use are the three that need no confirmation (they change nothing), so they prove the foundation first. Services, containers and logs follow in their own branches, and they will need a confirmation step.

Records: [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md) comes from this branch (D1). [ADR-0010](../adr/0010-local-shells-start-by-id.md) was read against it: that record stops the interface from choosing a program on this computer, and this change runs commands on a server the interface can already type into, so they sit side by side (not a conflict). [ADR-0003](../adr/0003-secrets-never-read-back.md) is respected: no script reads or prints a secret. [ADR-0005](../adr/0005-interface-follows-the-look.md): the dialog reuses the Toolbox's, checked on the Nuit and Ivoire looks. The standing "interface stays quiet" rule: no new buttons, only palette rows.

## What changed

- **`ssh.rs`:** a registry of open shells' logged-in connections by session id (`ExecRegistration`, removed when the session ends however it ends) and `exec(sid, command, stdin, secs)`. It opens a new channel, optionally sends stdin and closes it, and collects output, error text and exit status, stopping at a deadline (30 s by default, 120 s at most) and keeping at most 1 MiB. `ssh_exec` in `lib.rs` and `api.sshExec` expose it.
- **`server-tools-core.ts` (new, tested):** the scripts and the readers. Linux, macOS and BSD scripts go to `sh` on stdin, so they do not depend on the login shell and need no quoting; a path goes in through `shq`. Windows scripts are PowerShell sent as an encoded command (`powershell()`), which works from cmd.exe and from PowerShell and needs no quoting either. `sections`, `parseDf`, `parsePs`, `parseDu` and friends turn the output into text; `clean` removes terminal escape sequences a server could print.
- **`server-tools.ts` (new):** tells the system apart once per session (`uname -s`, then `cmd /c ver`), runs the right script and reads it. Defines the three tools for the existing Toolbox dialog.
- **Interface:** `TerminalTab.session` (the live session id), `Tool.heading` (the dialog says which server), and palette rows in `main.ts`: *Server tools…* in the default list and the three tools when searching, only while the focused tab is a connected SSH terminal.
- **Docs:** `using-portique.md`, the code-layout tables, ADR-0011 and its line in `AGENTS.md`.

## How to review

Read `exec` and `ExecRegistration` in `ssh.rs` first, then `server-tools-core.ts` from the top: the scripts are the part that touches other people's machines, so check each for commands that change anything (there should be none). Then `onServer` in `server-tools.ts`.

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (73 tests), `npm run build`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.

Against a real `sshd` (a scratch instance on 127.0.0.1, key login), the new ignored test `exec_beside_a_shell_against_local_sshd` passes: output, error text and exit status; two commands at once on one connection; a command stopped at its deadline with the connection still usable; the output cap; a script on stdin; release of the connection when the shell closes.

End to end in a headless browser (mocked Tauri, but `ssh_exec` forwarded to that `sshd` through the real `ssh` client, so a real login shell ran the real scripts): the rows appear only once the tab is connected; Server facts, Top processes and Disk usage show real output from a Debian 12 machine (including a genuinely failed service on it); a folder name with a quote in it is handled; a missing folder shows an error. Checked on Nuit and Ivoire.

**Not run:** any Windows server (the PowerShell scripts and readers are written from documentation and tested only against made-up JSON, with no PowerShell available here), macOS or BSD servers, BusyBox systems (`ps -o` there may not offer the columns used), a server whose `sh` lacks `cut` or `grep`, a jump-host chain, a Telnet or serial tab (the rows don't appear for them), and the app itself rather than the browser build.

## Not done / follow-ups

- Services, containers and logs (next branch), and installing a public key.
- Kill a process, and a sudo-aware way to see which program owns each port.
- A "Disk usage" of a Windows folder is slow (it adds up every file); it is capped by the 100-second limit.
- The tools list is fixed; a person cannot add their own server commands here (they have saved commands for that).
- Server facts only lists TCP listeners, and on Linux needs `ss` or `netstat`.
- Typing `server` also offers "Connect to Server" at the bottom, from quick connect's rule that a bare word may be a host.

## Decisions

### D1. A command beside a shell uses that shell's connection (ADR-0011)

- **Status:** accepted, as [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md)
- **Context:** The server tools need output as data. A fresh login per tool would repeat password and passphrase prompts, host-key questions and jump-host setup, and a person would see several connections for one tab.
- **Decision:** Register each shell's authenticated connection while it lives, and run a tool's command on a new channel of it.
- **Consequences:** No new prompts, and jump hosts just work. The connection is the person's own, so a tool can do what they could by typing, and no more. Closing or losing the shell ends the tools. The interface can ask Rust to run any command on that connected server; this equals what it can already type into the terminal, and the standing rule is that a tool shows a person what it changes before it runs.
- **Alternatives considered:** A new connection per tool (prompts and cost). Command templates in Rust (hidden from review and from the person). The shell's own terminal (mixes output with typing).

### D2. Scripts go to `sh` on stdin; Windows scripts are encoded PowerShell

- **Status:** accepted
- **Context:** The account's login shell can be bash, fish, csh or cmd.exe. Quoting a multi-line script into one command line breaks in some of them, and a path someone types must never reach a shell as code.
- **Decision:** On Linux, macOS and BSD the script is sent on stdin to `sh`; the only text that varies, a folder path, goes through `shq`. On Windows the script is sent with `powershell -EncodedCommand` (base64 of UTF-16), which both cmd.exe and PowerShell run, and a path goes through `psq`.
- **Consequences:** Any login shell works, and there are no length limits on Unix. Windows scripts must stay under about 7,000 encoded characters (`powershell()` refuses longer ones, and a test checks each). Scripts cannot use bash-only syntax (a test checks the facts script).
- **Alternatives considered:** `sh -c '<script>'` (needs quoting that fish and csh read differently). `bash -c` (not on every server). A remote helper program installed once (writes to the server, which these tools never do).

### D3. The system is detected once per session, with a command that fails safely on the others

- **Status:** accepted
- **Context:** A tool must know whether to send `sh` or PowerShell. Asking costs a round trip; guessing wrong runs a command on the wrong kind of machine.
- **Decision:** Run `uname -s` first. If it succeeds, the host is Unix (Linux gets its own label). If not, run `cmd /c ver`, which works in cmd.exe and PowerShell and fails on every Unix. The answer is cached by session id; a host that answers neither gets an error saying so.
- **Consequences:** The detection commands change nothing and print one line. A Windows host with a Unix `uname` on its path (Git for Windows, say) is treated as Unix and may fail; its tools then show the command's error. A reconnect re-detects.
- **Alternatives considered:** Reading the profile (no field says what the server runs). Trying PowerShell first (writes a "not found" error on every Linux host). Asking the person (one more prompt).
