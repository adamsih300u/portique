# Server tools, part 2: services, containers and logs

- **Branch:** `feat/server-services` (stacked on `feat/ssh-exec-facts`)
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The palette's server tools can now list and change services and containers on a connected host, and read their logs. *Services…* and *Containers…* show what is running and what has failed. *Restart / Stop / Start / Reload a service…* and *Restart / Stop / Start a container…* show the exact command first and do nothing until the person presses the button. *Service log…* and *Container log…* show the last 200 lines, and *Follow a log…* types `tail -f` or `journalctl -f` into the terminal. Windows servers get the service list and start, stop and restart; the rest is Unix only.

## Why

The next part of the Tier 2 list from [palette-toolbox](palette-toolbox.md), after [server-facts](server-facts.md) added the exec foundation. These are the first tools that change something, so they bring a confirmation rule with them.

Records: [ADR-0012](../adr/0012-server-changes-show-their-command-first.md) comes from this branch (D1). [ADR-0011](../adr/0011-server-commands-run-beside-the-shell.md) supports it (same channel, and the rule that a person sees what a command changes). [ADR-0003](../adr/0003-secrets-never-read-back.md) is respected: no password is ever read, sent or stored, and `sudo -n` cannot ask for one. [ADR-0010](../adr/0010-local-shells-start-by-id.md) is about this computer and does not apply. No record conflicts.

## What changed

- **`toolbox.ts`:** a tool can declare an `action` (button label, `plan`, optional `terminal`, `closes`), plus `prepare` and `auto`. For an action the dialog shows `plan(input)` as the person types, Enter in the box moves focus to the button without pressing it, and `run` happens only on the button.
- **`server-services-core.ts` (new, tested):** name checks (`unitName`, `containerName`, `windowsServiceName`), the scripts, and the readers for services, containers, journals and Windows services. A change is built only from a checked, quoted name. `PRIV` picks `sudo -n` only when the account isn't root and sudo works without a password.
- **`server-run.ts` (new):** `Host`, the per-session system detection and `onServer`, moved out of `server-tools.ts` so the two tool files do not import each other.
- **`server-operate.ts` (new):** the 12 tools. **`server-tools.ts`** keeps the three read-only ones and joins both lists.
- **`package.json`:** `@types/node` as a dev dependency, for one test that runs the generated scripts under a real `sh` with fake programs (`/// <reference types="node" />` in that file only, since TypeScript 6 no longer loads `@types` by itself).
- **Docs:** `using-portique.md`, the code-layout tables, ADR-0012 and its line in `AGENTS.md`.

## How to review

Start with `PRIV`, `serviceActionUnix` and `ENGINE` in `server-services-core.ts`: they decide what runs as root. Then the "scripts, run under sh with fake programs" tests, which show the exact calls made in each situation, and `openTool`'s `act` branch in `toolbox.ts`. The lists are separate from the actions: check that no listing script contains a verb that changes anything (a test does).

## What was tested

`npx tsc --noEmit`, `npx eslint src --quiet`, `npx vitest run` (96 tests), `npm run build`, `cargo clippy` and `cargo test --lib`.

Tests run the generated scripts under `/bin/sh` with fake `systemctl`, `sudo`, `docker` and `id`, and check which calls change something and whether sudo wrapped them: as a plain user with working `sudo -n`; as root; with sudo refused (the command still runs unprivileged and the failure explains itself); docker chosen with `sudo -n` only when the plain account is refused; no engine installed; hostile names (`x; touch pwned`, `$(…)`, backticks, quotes, newlines, `-rf`, `../`, empty) rejected before any script exists.

End to end in a headless browser, with `ssh_exec` forwarded to a real `sshd` on this machine through the real `ssh` client, and only names that do not exist acted on: the service list shows this machine's real failed service; the plan appears as the name is typed; Enter only moves focus and nothing is sent until the button is pressed; a restart of a missing unit fails with the server's own message and the no-password explanation; a bad name is refused before anything is sent; docker, which this account can't use, gives a plain explanation; the journal, which it can't read, says which group to join; *Type it in the terminal* and *Follow a log* put the right text into the terminal (checked on the bytes sent to the session) and close the dialog. Checked on Nuit and Ivoire.

**Not run:** a real successful restart, stop or start (deliberately: no real service or container was touched), the real `sudo -n` success path (this account has no passwordless sudo; it is covered by the fake), podman, a root login, a Windows server (the PowerShell is written from documentation and checked only against made-up JSON), BusyBox or non-systemd servers beyond the "no systemd" message, and the app itself rather than the browser build.

## Not done / follow-ups

- Install my public key on this host (next branch). Kill a process. Port forwards from the palette. Running a snippet on several hosts.
- Windows: no event log, no containers, no reload.
- `docker compose` stacks, and container exec or shell, are not offered.
- A password for sudo is never entered by Portique; the terminal button is the way.
- Service names with a backslash escape (`systemd-escape` output) are not accepted.
- The service list shows services only, not timers or sockets.

## Decisions

### D1. A change shows its exact command first, and root comes only from `sudo -n` (ADR-0012)

- **Status:** accepted, as [ADR-0012](../adr/0012-server-changes-show-their-command-first.md)
- **Context:** These tools can take a service or a container down, often as root, from a palette that is one keystroke away.
- **Decision:** An `action` tool shows what will run as the person types, runs only on the button, takes names that were checked and quoted, and uses `sudo -n` (never a password prompt). If that fails it says so and offers to type the command in the terminal.
- **Consequences:** Nothing changes by accident or without the exact command in view. A server that needs a sudo password needs the terminal. The dialog needs one extra press compared with a bare "Run".
- **Alternatives considered:** A second confirmation dialog (more steps, no more information). Handling the sudo password in the dialog (a secret in the interface). Always sudo (escalation for reads).

### D2. Reading tools never use sudo; docker may, because the group is the permission

- **Status:** accepted
- **Context:** A listing should not escalate. But a person who can restart a container through `sudo -n` and cannot list the containers would find that absurd, and being in the docker group is already root-equivalent.
- **Decision:** Services and journal reading run as the plain account and explain what they could not see. Container tools choose `sudo -n docker` only when `docker info` fails for the plain account, and say "through sudo -n" in their output.
- **Consequences:** Journals can look empty for an account outside the `adm` or `systemd-journal` group, and the message says which to join. Container tools work for accounts with passwordless sudo and no docker group.
- **Alternatives considered:** Never using sudo for containers (many setups can then not list them). Using sudo for the journal (escalates every read).

### D3. Lists and actions are separate scripts; a script answers with its exit status inside its output

- **Status:** accepted
- **Context:** An action's failure is the interesting part. The SSH exit status describes the last command of the script, which is a read-only `status` call.
- **Decision:** An action script prints `@@rc`, `@@out`, `@@sudo` and `@@status` sections; the reader turns a non-zero `rc` into an error with the command's own message. Listing scripts contain no verb that changes anything, and a test checks it.
- **Consequences:** The dialog always shows both the failure and the state afterwards. Scripts are a little longer than a bare command.
- **Alternatives considered:** Using the channel's exit status (hides the real result behind the status call). Running the status call as a second request (a second round trip and a window for it to differ).
