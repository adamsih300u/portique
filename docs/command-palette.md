# The command palette

Press **Ctrl+Shift+P** and start typing. The palette is one box for nearly everything in Portique: opening a host, switching tabs, splitting a pane, running a saved command, looking something up, or checking on a server. Press **Esc** to close it.

This page covers what the palette can do and what each part needs. For the rest of the app, see [Using Portique](using-portique.md).

## Finding things

Type a few letters and the list narrows as you go. You don't need the whole name: `sshk` finds *SSH keys…*, and two words such as `restart service` find anything that contains both. When your letters match a name, they are highlighted in it, and while you search a small tag on the right says which group each match came from.

| Key | What it does |
|---|---|
| **↑ / ↓** | Move through the list |
| **Enter** | Run the highlighted entry |
| **Esc** | Close the palette |
| **Ctrl+Shift+P** | Open or close it |

With nothing typed, the palette shows your six most recent choices first, then everything else under group headings. Shortcuts appear beside entries that have one, so the palette doubles as a reminder.

Two groups are kept out of the opening list so it stays short. A single row, **Toolbox…**, stands for the [toolbox](#the-toolbox), and while an SSH terminal is connected another row, **Server tools…**, stands for the [server tools](#server-tools). Choose either one and the box fills in with the group's name, which lists every tool in it. You can also skip that step and just type what you want: `port`, `subnet`, `restart`, `docker`.

### What's in the list

What you see depends on what is open.

| Group | What's in it | When |
|---|---|---|
| **This tab** | Split right, Split down, Close pane, Close tab, Copy last command output, Open file browser for this host, Appearance of *shell*…, Save *host* as a profile… | For the focused tab, and only the ones that apply: the splits and *Close pane* for a terminal tab (*Close pane* when it has more than one pane), the file browser for an SSH profile, *Appearance* for a local shell, *Save* for a quick-connect host. *Copy last command output* needs [shell integration](using-portique.md#terminals) |
| **Terminal** | Find in terminal… | While the focused tab has a terminal (see [Find in the terminal](#find-in-the-terminal)) |
| **Tabs** | *Switch to* each other open tab | Always |
| **Connect** | Every saved profile, API connection and local shell | Always |
| **Files** | *Browse files on* each SSH host | Always |
| **Workspaces** | *Open workspace* for each saved one | Always |
| **API** | New API request, New API connection…, and every saved request as *connection: request* | Always. Send, Save, Environments…, Import, Export and Connection settings… join them when an API tab is focused |
| **<profile> commands** | That profile's [saved commands](#saved-commands) | While the focused pane is a connected terminal for that profile |
| **Toolbox** and **Server** | The [toolbox](#the-toolbox) and [server tools](#server-tools) | By typing, or through their row |
| **App** | New profile…, Save workspace…, SSH keys…, Lock the vault, Change master password…, Hide/Show the sidebar, Keyboard shortcuts, Settings…, GPU rendering and drop-down mode switches | Always |
| **Appearance** | Interface colours…, Terminal colour themes…, and each interface look (*Interface look: Ivoire* and so on) | Always |

## Quick connect

To open a machine you haven't saved, type its address and choose **Connect to…**:

- `10.0.0.5`
- `admin@host.example.com:2222`
- `telnet://switch.lan`
- `[fe80::1]:2200` (put an IPv6 address in brackets when you add a port)

You get a new tab named after the host, with the port added to the name only if it isn't the default (22 for SSH, 23 for Telnet). If you didn't type a user name, Portique asks for one and remembers your last answer. It never offers to save a password for a host like this.

When the tab is in focus, **Save … as a profile…** in the palette keeps the host. The tab that is already open carries on as it is.

The *Connect to…* row appears at the top when what you typed is clearly an address (it has a dot, a user, a port or a scheme), and at the bottom when it is a bare word like `nas`, so that typing `split` never puts it above *Split right*.

## Saved commands

A profile can keep commands for its host. In the profile editor, open **Saved commands** and add a name and the command text. While the focused pane is a connected terminal for that profile, the commands appear in the palette under a group named after the profile.

Each command is either **Run** (type it and press Enter) or **Type only** (leave it on the line so you can check it first). Write `{{name}}` in a command and the palette asks for that value each time you use it.

Saved commands are stored as plain text in `profiles.json`, so keep passwords and tokens out of them.

## Find in the terminal

Press **Ctrl+Shift+F**, or type `/` in the palette, to search the scrollback of the focused terminal. Matches are highlighted as you type, and the current match stays selected so you can copy it.

| Key | What it does |
|---|---|
| **Enter** or **F3** | Next match |
| **Shift+Enter** or **Shift+F3** | Previous match |
| **Alt+C** | Match case on or off |
| **Alt+W** | Whole word on or off |
| **Alt+R** | Regular expression on or off |
| **Backspace** on an empty box | Back to the command list |
| **Esc** | Close |

Find searches one terminal at a time: the focused pane of the active tab. It doesn't search file browser or API tabs.

## The toolbox

The toolbox is a set of small utilities that work the same on Windows and Linux. Each opens a dialog. Type your input, read the answer, and press **Copy** to put it on the clipboard. **Esc** closes the dialog.

A few habits apply everywhere:

- Tools that answer instantly update **as you type**, and **Enter** copies the result.
- The network tools run when you press **Enter** (or **Run**).
- In a box that takes several lines, **Ctrl+Enter** does what Enter does elsewhere.
- No tool fills a box from your clipboard. To work on something you copied, paste it into the box yourself. (The one time Portique reads the clipboard is to clear a password or token it put there: 30 seconds after you copy it, it clears the clipboard only if it still holds that secret.)
- The utilities that don't use the network send nothing anywhere. Only the four network checks contact another machine, and only the one you name.

### Network checks

These run from your computer, so they tell you what *you* can reach.

| Tool | You type | You get |
|---|---|---|
| **Port check…** | A host and some ports, like `example.com 22 80 8000-8010`, or just `host:443`, or a URL. With no ports it tries sixteen common ones | Which ports accept a connection, how long each took, and the service name for well-known ports. Up to 64 ports at once, three seconds each |
| **TCP ping…** | `host port` and, if you like, a count: `example.com 443 10`. Four tries unless you say | The connect time of each try and the minimum, average and maximum. It tries about once a second, up to 20 times. Useful where ordinary ping is blocked |
| **DNS lookup…** | A host name | The addresses your computer's resolver gives, IPv4 first. It uses the system resolver, so a VPN or a hosts-file entry is included. It doesn't show other record types or do reverse lookups |
| **Wake-on-LAN…** | A MAC address, and optionally a broadcast address: `aa:bb:cc:dd:ee:ff 192.168.1.255` | Sends a magic packet (UDP port 9). It can't tell you whether the machine woke, and the machine must be on your network with Wake-on-LAN switched on |

### Generators

| Tool | You type | You get |
|---|---|---|
| **Generate a password** | A length from 8 to 128 (20 if empty). Add `simple` to leave out symbols | A random password with at least one of each kind of character, and its strength in bits. After you copy it, the clipboard is cleared 30 seconds later, if it still holds the password |
| **Generate a random token** | Nothing | 256 random bits as hex and as URL-safe base64. *Copy* takes the hex. It clears the clipboard like the password tool |
| **Generate a UUID** | Nothing | A random version 4 identifier |

Press **Another** for a fresh one.

### Converters and readers

| Tool | You type | You get |
|---|---|---|
| **Base64 encode… / decode…** | Text, or base64 (the URL-safe kind, with or without padding or line breaks, is fine) | The other form |
| **URL encode… / decode…** | Text, or a percent-encoded string | The other form |
| **Hex encode… / decode…** | Text, or hex (spaces, `0x` and colons are ignored) | The other form |
| **Hash text…** | Text | SHA-1, SHA-256, SHA-384 and SHA-512 |
| **Decode a JWT…** | A token, with or without `Bearer` | The header and payload, the issued, not-before and expiry times, and whether it has expired. It never checks the signature |
| **Time converter…** | A Unix time in seconds or milliseconds, or a date like `2026-10-09 14:30`. Empty means now | UTC, local time, both Unix forms, and how long ago or from now |
| **Format JSON… / Minify JSON…** | JSON | The indented or compact form, or what is wrong with it |
| **Explain a cron schedule…** | Five fields (`*/15 9-17 * * mon-fri`) or a name such as `@daily` | A sentence, and the next five run times in your computer's time zone |
| **Subnet calculator…** | `192.168.1.10/24`, or an address and a mask | Network, mask, wildcard, broadcast, usable range and host count. IPv4 only |

## Server tools

Server tools run commands on the host of an SSH terminal and show you the answer in a dialog. They appear in the palette while the focused terminal is a **connected SSH** session. They don't appear for Telnet, serial or local terminals, or for an SSH tab that has disconnected.

They use the connection the terminal already has. There is no second login, no extra password or host-key question, and a [jump host](using-portique.md#connections) works as it does for the terminal. The server sees ordinary commands from your account, run beside your shell. Nothing is installed on the server and nothing appears in your terminal.

Opening the palette never touches the server. A tool contacts it only when you open that tool.

### Looking (nothing changes)

| Tool | What you get |
|---|---|
| **Server facts** | The system and kernel, CPUs, uptime, load, memory, disks, listening TCP ports (split into those open to the network and those for the machine only), failed services, and a short "needs a look" list: a disk or memory at 90% or more, a heavy load, or a failed service |
| **Top processes** | The ten busiest by CPU and the ten using most memory. On Windows, by CPU time and memory |
| **Disk usage…** | The biggest items one level inside a folder, on one file system. Leave it empty for the top of the disk. It can take a minute on a large one |
| **Services…** | What is running and what has failed, with a filter to find stopped services too |
| **Containers…** | Docker or podman containers, running and stopped, with their images and ports |
| **Service log…** | The last 200 journal lines of a service. It shows only what your account is allowed to read, and says so when the journal is hidden from it |
| **Container log…** | The last 200 lines a container printed |

### Changing (it asks first)

| Tool | What it does |
|---|---|
| **Restart / Stop / Start / Reload a service…** | Runs `systemctl` on the service (Windows: start, stop and restart) |
| **Restart / Stop / Start a container…** | Runs `docker` (or `podman`) on the container |
| **Install a key on this host…** | Adds the public half of a key from your vault to the server's `~/.ssh/authorized_keys`, so a profile can sign in with the key. It creates the folder and file if needed and sets them to mode 700 and 600, keeps every other line, and adds nothing if the key is already there (under any comment). Only the public key is sent. Unix only |

These never run on a keystroke. The dialog shows the exact command and what it affects as you type the name, and nothing happens until you press the button. Pressing Enter in the name box only moves you to the button.

Changes that need root use `sudo -n`, which succeeds only when the account can use sudo without a password. Portique never asks for, sends or stores a sudo password. If the account can't, the dialog says so, and for service and container changes **Type it in the terminal** puts the command on your prompt so you can run it and enter the password yourself.

### Following a log

**Follow a log…** isn't a dialog result: it types `tail -f` (for a path, which must start with `/`, such as `/var/log/syslog`) or `journalctl -f` (for anything else, taken as a service name) into your terminal and presses Enter, so the log scrolls where you can watch it. The dialog shows the exact command first. It keeps going until you press Ctrl+C. Because it is typed into your own terminal, it works only where the server's shell has those commands, so not on a typical Windows server.

### What the server needs

| Server | Needs |
|---|---|
| **Linux, macOS, BSD** | `sh`. The tools use the programs you'd expect: `ps`, `df` and `du`; `systemctl` and `journalctl` for services and logs (the service tools need systemd); `docker` or `podman` for containers; `ss` or `netstat` for ports. Load, memory and CPU details come from `/proc`, so other systems than Linux show less in *Server facts* |
| **Windows** | PowerShell, for facts, processes, disk usage, the service list, and starting, stopping and restarting a service. Changing services needs an administrator account |
| **Windows, not yet** | Reload, service and container logs, containers, and installing a key. These say so |

The Windows tools were written from Microsoft's documentation and have not been tried on a real Windows server yet, so treat them as a first draft.

Each tool has a time limit (30 to 100 seconds, depending on the tool), and a command's output is cut off beyond 1 MiB.

## Good to know

- Typing a bare word that is also the name of a group, such as `toolbox` or `server`, also lists *Connect to toolbox* at the bottom. That's quick connect treating it as a possible host. Ignore it.
- Recent choices are remembered on this computer only, and only for the palette.
- The palette can't open while another dialog is on screen, such as the vault unlock prompt.
