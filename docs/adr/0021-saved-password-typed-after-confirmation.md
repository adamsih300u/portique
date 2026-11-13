# ADR-0021: A saved password is typed into a terminal only after a confirmation

- **Status:** accepted
- **Date:** 2026-10-12
- **Source:** [`type-saved-password`](../changes/type-saved-password.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0003 (supports: the password stays in Rust), ADR-0012 (no server tool enters a password; this is the person's own action, and the record points people to the terminal), ADR-0019 (an agent's first step needs the master password; an agent cannot start this)

- **Context:** Typing a saved password into a terminal helps at `sudo` and `su` prompts, but the same keypress at a shell prompt, an editor or a chat client puts the password on screen or in history.
- **Decision:** `session_type_password` in `lib.rs` is the only way to type a saved password into a session. The window may call it only after `typeSavedPassword` in `terminal-tab.ts` has shown a dialog that names the profile and the person has pressed its button. Rust reads the vault and writes the password and Enter to the session.
- **Consequences:** Every use costs one Enter, and the password never reaches the page. Nothing types it unasked: no agent tool, no prompt detection, no automatic retry.
- **Alternatives considered:** Typing at once is a single key but a slip leaks the password. Skipping the dialog when the last output looks like a prompt trusts text the server controls. Returning the password to the page breaks ADR-0003.
