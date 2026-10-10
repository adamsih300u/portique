# ADR-0018: A command finishes with markers typed around it in the person's open shell

- **Status:** accepted
- **Date:** 2026-10-10
- **Source:** [`mcp-agent-terminals`](../changes/mcp-agent-terminals.md), decision D3
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0011 (differs on purpose: that channel runs palette tools beside the shell, where an agent needs the shell itself)

- **Context:** An agent needs a command's output and exit status, and a terminal gives no signal that a command ended. The person must see what runs, and the shell's working directory and variables must carry between commands.
- **Decision:** `agent/exec.rs` types the command inside a brace group that prints a begin line, runs it, then prints an end line holding `$?`, both carrying a random nonce. `printf` builds them from pieces, so the echo of what was typed never contains a marker whole. The group is pasted as one piece when the shell asks for bracketed paste. Only POSIX shells are supported; other sessions use `send_input`. Replies drop escape codes and the wrapper's lines.
- **Consequences:** The command runs in the visible shell the person can take over, with its state. The wrapper shows in the tab. A shell that is not POSIX is reported as `no-marker`, and Ctrl+C abandons the end marker, so interrupting clears the wait.
- **Alternatives considered:** ADR-0011's separate channel gives clean output but no shared state, and the person would not see it. A prompt hook injected into the shell is shell-specific and changes the person's prompt. Waiting for the output to go quiet guesses and gives no exit status.
