# ADR-0019: An agent's first step in a session needs the master password

- **Status:** accepted
- **Date:** 2026-10-10
- **Source:** [`mcp-agent-terminals`](../changes/mcp-agent-terminals.md), decision D8
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0016 (builds on: its modes say how far an agent may go; this says a person must be at the keyboard to let it start), ADR-0017 (the server's token only proves a program on this computer; this adds a person), ADR-0013, ADR-0014 and ADR-0015 (the vault and how a password reaches it)

- **Context:** Anything that can reach the agent server (an injected agent, another program run by the same user) is one *Allow* away from a shell. The token proves a program, not a person.
- **Decision:** While a vault exists and `agent.requirePassword` is on (the default, and the only new setting), the first command or typed input in each agent session opens a dialog that asks for the master password. `Agents::answer_password` checks it against the vault file, opening the vault if it was locked; five wrong tries decline the request. A plain answer cannot grant such a question. The proof belongs to one opening of the vault (`Vault::epoch`), so locking it ends the proof. The password travels as raw bytes, as for the vault's own dialogs. Where the profile asks about each step, one dialog holds both the password and the yes.
- **Consequences:** An agent cannot start work unless the person is present, and an idle lock stops it until they return. A page that calls the plain answer command cannot grant it either. With no vault there is no password, and only the per-profile questions apply. The page sees the password as it is typed, as it does for the vault's unlock.
- **Alternatives considered:** A password per command is too much to ask. An operating-system prompt differs by platform. A separate agent PIN is a second secret to keep. A stable token kept in the vault needs a second credential or a secret on disk.
