# ADR-0012: A server tool that changes something shows its command first and never enters a password

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`server-services`](../changes/server-services.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** [ADR-0011](0011-server-commands-run-beside-the-shell.md) (the channel these commands run on), [ADR-0003](0003-secrets-never-read-back.md) (secrets stay out of the interface and its commands)

- **Context:** Starting, stopping and restarting services and containers can take a site down, and often needs root. A palette that does this on one keystroke, or that handles a sudo password, is dangerous.
- **Decision:** A tool that changes a server declares an `action` in its `Tool`. The dialog shows the exact command and what it affects as the person types, and nothing runs until they press the named button (Enter in the box only moves to it). Names are checked and quoted. Root comes only from `sudo -n`, which cannot ask for a password; if it is refused the command runs as the plain account and fails, and the dialog offers to type it in the terminal instead.
- **Consequences:** Every change is visible and deliberate, and no password is read, sent or stored. Servers that need a sudo password need the terminal. Reading tools run with no confirmation and no sudo.
- **Alternatives considered:** Confirming in a second dialog adds a step with little more information. Entering the sudo password in the dialog would put a secret in the interface. Always using sudo makes reading tools escalate for no reason.
