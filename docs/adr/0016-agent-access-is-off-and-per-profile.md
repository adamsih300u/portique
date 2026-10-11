# ADR-0016: Agent access is off by default, set per profile, and kept outside the profile

- **Status:** accepted
- **Date:** 2026-10-10
- **Source:** [`mcp-agent-terminals`](../changes/mcp-agent-terminals.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0010 (supports: an agent can open only a local shell that Rust found and the settings turn on), ADR-0003 and ADR-0014 (support: an agent names a profile and Rust signs in, so no secret reaches it), ADR-0012 (does not conflict: it covers palette tools run by the person's own keystroke; here "ask" shows the exact text first, and "allow" is a per-profile choice the person makes)

- **Context:** An agent is a second pair of hands on the person's servers. It has to start with no reach, and a profile that can be imported, duplicated or synced must not be able to grant any.
- **Decision:** `settings.json` holds `agent.enabled` and `agent.profiles`, a map from profile id to `off`, `ask` or `allow`. The server runs only while `enabled` is true. An agent sees and opens only profiles that are not `off`, and uses only sessions it opened itself, never the person's own tabs. Deleting a profile removes its entry.
- **Consequences:** Duplicates, imports and a copied `profiles.json` never carry access; every grant is made on this computer. An agent cannot drive a tab the person opened; sharing one would need a new decision. Access follows the profile id, so editing a profile's host keeps it. Anyone who can write `settings.json` can switch agent access on, as they can already change every other setting.
- **Alternatives considered:** A flag on the profile travels with imports, duplicates and sync. One global switch is all or nothing. A read-only level cannot be enforced in a general shell and would only look safe.
