# ADR-0017: The agent server lives in the app, listens on loopback only, and a bridge serves stdio

- **Status:** accepted
- **Date:** 2026-10-10
- **Source:** [`mcp-agent-terminals`](../changes/mcp-agent-terminals.md), decision D2
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0016 (the access rules this server enforces), ADR-0014 (the vault stays in this process and is never opened to the agent)

- **Context:** An agent has to share the person's sessions, saved logins, host-key questions and tabs. Agent programs reach an MCP server through a command (stdio) or a web address.
- **Decision:** `agent/server.rs` listens on `127.0.0.1`, on a free port, only while agent access is on, and answers each JSON-RPC message in the HTTP response. A request needs the bearer token made at start-up (256 bits, compared in constant time), a loopback `Host` and no `Origin`. The address and token go to `agent-endpoint.json` (user-only, removed on exit). `portique mcp`, the same executable, bridges stdio to the server and reads that file on every call.
- **Consequences:** One set of sessions, vault and prompts. The stdio configuration holds no secret and survives a restart; the web configuration holds a token that changes at each start. The app must be running. Another process of the same user can read the file and use the token, as it could read the person's other files; it still meets each profile's mode, and questions still go to the person.
- **Alternatives considered:** A separate server process would need its own vault and sessions. A Unix socket or named pipe differs by platform and few agent programs speak it. An MCP library is heavier and macro-driven for a small protocol subset. A fixed port with a stored token leaves a long-lived credential on disk.
