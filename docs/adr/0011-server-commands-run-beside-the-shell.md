# ADR-0011: Server commands run on a new channel of the open shell's connection

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`server-facts`](../changes/server-facts.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** [ADR-0010](0010-local-shells-start-by-id.md) (that record keeps the interface from choosing a program on this computer; this one runs commands on a server that the interface can already type into), [ADR-0003](0003-secrets-never-read-back.md) (no tool reads or prints a secret)

- **Context:** The palette's server tools need a command's output as data, not drawn in a terminal. A second login per tool would repeat prompts, host-key questions and jump hosts.
- **Decision:** `ssh.rs` keeps each open shell's logged-in connection by session id while the shell lives. `ssh_exec` opens one more channel on it, runs the command (a script goes on stdin to `sh`), and returns output, error text and exit status, with a time limit and a 1 MiB cap. It works only for a connected SSH shell.
- **Consequences:** No new login, prompt or host-key question, and jump hosts work. A tool can do what the person could by typing into the terminal, and no more. Tools must give a person a dialog that shows what a command changes before they run it. A dropped connection ends tools with it.
- **Alternatives considered:** A new connection per tool repeats authentication. Command templates in Rust keep the interface out of it but hide what runs from the person and the tests. Running over the terminal's own pty mixes output with what the person types.
