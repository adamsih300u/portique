# ADR-0010: A local terminal starts from a detected shell, by id

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`local-terminals`](../changes/local-terminals.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** [ADR-0003](0003-secrets-never-read-back.md) (the interface asks Rust for what it needs and never carries the sensitive part)

- **Context:** A local terminal is the first feature that runs a program on this computer. The interface must not be able to choose which one.
- **Decision:** `local.rs` finds the shells itself. A session's profile id is `local:<shell id>`, and `store::get_profile` resolves it only for a shell that was found and that the settings turn on. Local profiles exist only in memory; `save_profile` refuses them.
- **Consequences:** A bug or injected script in the interface can open one of the listed shells at most, and only after the user turned the feature on. A shell installed later shows up after the settings pane is opened again. A custom program or arguments are not possible without a new decision.
- **Alternatives considered:** A free-form command in a profile gives anyone who can edit `profiles.json` a launcher. A Tauri shell-plugin scope cannot express "the shells that are installed".
