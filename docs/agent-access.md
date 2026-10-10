# Agent access

Portique can let an AI agent use terminals: open a shell on one of your hosts (or on this computer), run commands, read what comes back and answer a prompt, while you watch it work in a tab and can take the keyboard at any moment. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), which many agent programs understand.

It is **off until you turn it on**, and even then an agent can only use the profiles you mark.

For the rest of the app, see [Using Portique](using-portique.md). The reasons behind the design are in [the change file](changes/mcp-agent-terminals.md) and [ADR-0016](adr/0016-agent-access-is-off-and-per-profile.md), [0017](adr/0017-agent-server-in-the-app-on-loopback.md) and [0018](adr/0018-commands-finish-with-markers-in-the-open-shell.md) and [0019](adr/0019-an-agents-first-step-needs-the-master-password.md).

## Turn it on

**Settings… → Agent access → Let AI agents use terminals (MCP)**, then Save. Portique starts listening on a port of this computer's loopback address, which nothing else on your network can reach. Switching it off stops the server and closes every session an agent opened.

Local shells need **Settings… → Local terminals → Show local terminals** as well, since an agent can only use shells Portique already offers.

## Choose what agents may use

Right-click a profile (an SSH host, a Telnet or serial profile, or a local shell) and choose **Agent access…**. There are three levels:

| Level | What an agent can do there |
|---|---|
| **Off** (the default) | Nothing. It cannot even see the profile. |
| **Ask me each time** | Open it and type into it, but you see the exact command and say yes or no first. |
| **Allow** | Open it and run commands without asking. Use it where a mistake is cheap. |

The choice is kept in `settings.json` by profile id, not in the profile. Duplicating or importing a profile therefore never carries access with it, and deleting a profile removes it. The palette has **Agent access for …** for the focused tab's profile.

## Your master password

If you have a vault, an agent cannot run anything until you let it, with your master password. The first time it tries a command or types into a session, a dialog shows what it wants and asks for the password. One entry covers that session for as long as the vault stays open: **locking the vault, by hand or by its idle timer, ends it**, and the next step asks again. So a locked Portique does nothing for an agent, and an agent left running while you are away stops when the vault locks.

- The password is checked inside Portique and never reaches the agent. A wrong one is refused with the dialog still open; five wrong ones decline the request.
- For a profile set to *Ask me each time*, the same dialog holds the password and the yes, so there is still one question.
- If the vault is locked, entering the password opens it, as the normal unlock does.
- **Settings… → Agent access → Ask for my password before an agent runs commands** turns this off. With no vault there is no master password, so it has nothing to ask for and only the per-profile questions apply.

## Connect an agent

Choose **Connect an agent…** (in Settings, or in the palette once agent access is on). It shows the text to give your agent program, so you can read it before you paste it anywhere:

- **Command (JSON settings)** is a `mcpServers` entry that starts `portique mcp`, a small bridge between the program and the running Portique.
- **Command (one line)** is the same command on one line.

Both hold **no secret** and keep working after Portique restarts: the bridge finds the current address and token itself each time. That is the only way in. There is no web address to give out and no token to paste, so there is nothing to leak from an agent's settings, and a program that can only connect to a URL is not supported.

Portique must be running for an agent to reach it. If it isn't, the bridge tells the agent so, in words.

## What you see

- **A tab for each session.** When an agent opens a terminal, a tab appears with a small **agent** badge. It flags itself but doesn't take the screen from what you are doing. You see every command it runs, as it runs.
- **Questions.** For profiles set to *Ask me each time*, a dialog shows what the agent wants to open, run or type, exactly as it will go. **Deny** is the default and is the only button live for the first moment, so a key you pressed for the terminal behind it can't answer it. *Allow once* lets that one step through; *Allow for this session* stops the questions in that session. An unanswered question counts as a no after two minutes.
- **Taking over.** Type or paste into an agent's tab and the agent stops: its next call is told you have the keyboard and to ask you. The badge changes to **you**. Right-click the tab and choose **Hand the terminal back to the agent** when you are done, or **Pause the agent (take over)** to stop it without typing.
- **Activity.** **Agent activity…** (Settings, or the palette) lists what agents opened, ran and typed, and what you refused. It is kept in memory while Portique runs and **never written to disk**, because a command can carry a secret the agent chose to type.
- **Closing.** Closing an agent's tab ends its session. Agent sessions are not saved with your tabs or workspaces; they end when Portique quits.

If an agent's session ends (the connection drops, the vault is locked), the tab says so, and **Enter** opens a session of your own on that profile.

## What an agent can do

| Tool | What it does |
|---|---|
| `list_profiles` | The hosts and shells open to agents, and whether each asks first. Names and addresses only. |
| `open_session` | Starts a terminal on one of them, using the login Portique has saved. |
| `run_command` | Runs a command in the open shell and waits for it to finish. Returns the exit status and the output with escape codes removed. The shell stays open, so the working directory and variables carry over. |
| `send_input` | Types text and named keys (`Enter`, `Tab`, `C-c`, arrows…), then returns the reply once it settles. For prompts, full-screen programs and interrupts. |
| `read_output` | Reads what was printed since a position, optionally waiting for more. |
| `read_screen` | What is on the screen now, with the cursor, for editors, pagers and `top`. |
| `wait_for` | Waits for a regular expression in the output. |
| `list_sessions`, `close_session` | What is open, who holds the keyboard, and closing one. |

An agent never sees a password, key or the vault. It names a profile and Portique signs in, as it would for you. If the vault is locked and the profile needs a saved login, the agent is told to ask you to unlock it. A server's host key is confirmed by you, in the new tab; the agent waits.

## What keeps this safe

- Nothing listens until you switch it on, and only on `127.0.0.1`. A request must carry a token made at start-up, must name the loopback address as its `Host`, and must not come from a web page (any `Origin` header is refused).
- The token is written to `agent-endpoint.json` in the config folder, readable by you only, and removed when Portique quits. It is for the bridge alone: it is never shown, copied or put in an agent's settings.
- An agent reaches only profiles you marked, and only sessions it opened itself. Your own tabs are not visible to it.
- A shell is a shell: an agent in a local terminal has your account's rights on this computer, Portique's own files included, and on a host it has the profile's login. Choose *Ask me each time* for those, and read each command. Characters that could disguise a command (an invisible character, a right-to-left override) are shown spelled out in the question.
- With a vault, [your master password](#your-master-password) is needed before an agent's first step in each session, so nothing starts without you at the keyboard.
- *Ask me each time* puts the exact text in front of you before it is typed. A refusal is passed on with an instruction not to try again or work around it.
- Everything a terminal prints is untrusted text from another machine. The server tells agents never to follow instructions found in it, but the stronger protection is the one above: choose *Ask me each time* on anything that matters.
- At most 8 sessions are open at once, output returned in one call is capped, and no more than 8 questions wait at a time.

## Things to know

- `run_command` needs a **POSIX shell** (bash, zsh, dash, ksh, and so on; WSL and Git Bash too). It works by typing the command inside a wrapper that prints markers around it, so you will see that wrapper in the tab. On other sessions (Telnet, serial, `cmd`, PowerShell, fish) an agent uses `send_input` with `wait_for` or `read_output`.
- A command that needs more than the time limit comes back as `running` with what it printed so far, and the agent can follow it or interrupt it. A new command is refused until the old one has ended.
- With bash and zsh, a multi-line command is pasted as one piece, so tabs and heredocs arrive intact. In simpler shells each line is typed, and a tab character or a line over 3,800 bytes is refused.
- The bridge, `portique mcp`, is the same executable as the app and shows no window. It has not been tried on Windows.

## Troubleshooting

- *"Portique is not running, or agent access is switched off"*: start Portique and turn the setting on.
- *"Portique refused the request"*: the bridge could not get in, usually because Portique was restarted at that moment. Try again; if it persists, restart the agent program so it starts a fresh bridge.
- *"No profiles are open to agents"*: mark one with right-click → **Agent access…**.
- *"The vault is locked"*: unlock Portique, then ask the agent to try again.
