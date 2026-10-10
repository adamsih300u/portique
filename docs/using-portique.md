# Using Portique

Everything Portique can do, in one place. For a short introduction see the [README](../README.md).

Portique opens everything as a tab in one window: terminals, file browsers and API connections. The sidebar lists your saved connections, and the [command palette](command-palette.md) (Ctrl+Shift+P) reaches almost everything else.

## Connections

Click **+ New** to make a profile. Choose a protocol (**SSH**, **Telnet**, **Serial** or **API**), fill in the form and save. Double-click a profile to open it in a tab. Profiles are plain text in `profiles.json` and never hold a secret: passwords and passphrases go in the [vault](#security-and-your-data).

Right-click a profile to act on it. An SSH, Telnet or Serial profile offers **Connect**, **Edit…**, **Duplicate…** and **Delete…**, plus **Open in split right** and **Open in split below** while a tab is open, and SSH adds **Open file browser (SFTP)**. An API connection offers **Open**, **New request**, **Edit…**, **Duplicate…** and **Delete…**. A local shell offers **Open**, the two splits and **Appearance…**. Right-click empty space for **New profile…** and **New API connection…**. The **Search profiles…** box above the list filters as you type.

- **Duplicate…** opens the editor filled in from the profile and copies its saved password too, unless you tick *Don't copy the saved password*. (Key-only profiles have no password to copy.)
- When you create or duplicate a profile, **Create + Add Another** saves it and reopens the editor with the same settings and a blank name, for entering several similar profiles in a row.
- **Sidebar group** in the editor puts a profile under a heading in the sidebar. Click a heading to collapse it, and drag a profile onto another group to move it.

### SSH

- **Authentication** (under *Login*) is *Password*, *Private key* or *Private key + password*. With a password, Portique also answers keyboard-interactive prompts for it automatically, which many servers need.
- **Host keys:** the first time you connect, Portique shows the server's key and asks you to accept it, then pins it. If the key later changes, Portique refuses and tells you. If the change is legitimate, **Forget saved host key** in the profile editor lets you trust the new one.
- **Jump host** lets you reach a machine through another SSH profile (like OpenSSH's `ProxyJump`). Jump hosts chain up to five deep, and each one logs in with its saved password or an unencrypted key.
- **Port forwards** are *Local*, *Remote* or *SOCKS* (the same as `-L`, `-R` and `-D`). They run while the session is connected. A `⇄` badge with the number of forwards appears on the tab, counting every pane in it; it turns amber if one failed, and hovering it shows each forward with a tick or a cross. A forward that couldn't start is also printed in the terminal in amber.
- **Saved commands** keep commands for the host in the palette. See [the palette page](command-palette.md#saved-commands).
- **File browser (SFTP)** in the editor sets where the file browser starts, on this computer and on the server. A blank folder on this computer uses the default from *Settings…*; a blank one on the server means the account's login folder.

### Connection health

SSH sends a keepalive every 15 seconds and treats about 45 seconds of silence as a dropped link. While Portique reconnects on its own, the tab's dot pulses amber. It waits 1, 2, 4, 8, 15 and then 30 seconds between up to ten tries; press **Enter** to retry now or **Esc** to stop. It stops by itself on login problems and never prompts for a password unattended. A reconnect is a new login, so the old shell and anything running in it are gone. Use tmux or screen to keep work alive.

Switch it off for one profile with **Reconnect automatically if the connection drops**, under *Reliability & security*.

### Telnet and serial

**Telnet** is a built-in client (it negotiates ECHO, SGA, TTYPE and NAWS). **Serial** takes a *Port* (such as `COM3` or `/dev/ttyUSB0`), *Baud*, *Data bits*, *Parity*, *Stop bits* and *Flow control*. Neither is encrypted, and the editor says so.

Both can fill in your sign-in for you. If the profile has a user name or a saved password, Portique types each one once, when the output ends in a prompt such as `login:`, `username:` or `user name:`, or `password:` (upper or lower case). It only does this in the first minute after connecting.

### Local terminals

Turn on **Settings… → Local terminals → Show local terminals** and choose which shells to offer. They then appear under **Local** at the top of the sidebar and in the palette, and open in a tab like any other connection. They start in your home folder.

- On Windows, Portique looks for PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and each WSL distribution. On Linux and macOS it lists the shells in `/etc/shells`, yours first.
- Right-click a Local row and choose **Appearance…** (or find it in the palette while a local tab is focused) to give that shell its own colour theme, font, cursor and scrollback.
- They need no login and never touch the vault, and they stay off until you turn them on. Portique starts only shells it found itself; there is no way to enter a command of your own here.

When any terminal ends, the tab says "Session closed" and **Enter** starts a new one.

### API connections

Choose **API** as the protocol, give it a base address, and work with that endpoint in a tab: saved requests down the left, the request and its response on the right. It has environments with vault-backed secrets, OAuth 2.0 sign-in, checks on responses, sending through an SSH host, and import and export. See [the API client guide](api-client.md).

## Terminals

- **Tabs.** Several tabs on one profile are numbered (`prod 1`, `prod 2`). Drag a tab to reorder it, middle-click to close it, and right-click for **Rename tab…** (and **Reset tab name**). Custom names and the order come back after a restart and in saved workspaces. When something finishes in a tab you aren't looking at (a command ends, or a file transfer completes), its title turns bold and accent-coloured and pulses a few times until you open it. There is no setting for it.
- **Splits.** Split a terminal tab into panes with **Ctrl+Shift+D** (side by side) or **Ctrl+Shift+E** (stacked), or right-click the tab. Drag a divider to resize, and double-click it to even them out. File browsers and API tabs can't be split.
- **Copy and paste.** Ctrl+Shift+C and V, or right-click, which copies a selection and otherwise pastes. **Shift+right-click** opens the pane menu with copy, paste and the prompt and shell-integration items.
- **Text size.** Ctrl+wheel, or Ctrl+= and Ctrl+- (Ctrl+0 resets). The size runs from 8 to 40 and is remembered in that profile.
- **Per-profile look.** Each profile has its own colour theme, font, size, cursor style and blink, and scrollback, and can switch on font ligatures for fonts that have them.

### Extras

- **Rendering and text:** WebGL rendering (*Settings… → GPU rendering*, falling back to the normal renderer if it isn't available) and Unicode 11 widths.
- **Images:** inline images (sixel and the iTerm2 protocol).
- **Links:** OSC 8 hyperlinks, and plain web addresses. **Ctrl+click** opens `http`, `https` and `mailto` links only.
- **Clipboard from the server:** OSC 52, so programs like tmux and vim can *set* your clipboard. Reading your clipboard is never allowed.

### Shell integration

Add the snippet from **Shift+right-click → Shell integration…** to your remote `~/.bashrc` or `~/.zshrc`. Once the shell is sending marks, **Ctrl+Shift+↑ / ↓** jump between prompts (also in the pane menu as *Previous prompt* and *Next prompt*), and **Copy last command output** appears in the pane menu and the palette.

### Workspaces

**Save workspace…** (in the gear menu or the palette) stores the open terminal tabs and their pane layout under a name. Saved workspaces are listed at the bottom of the sidebar: double-click one to open it, and right-click to rename or delete it. Saving under an existing name replaces it. A workspace holds profile ids and layout only, never a secret, in `workspaces.json`.

When *Reopen my tabs when Portique starts* is on (it is by default), the open terminal tabs and their layouts come back at the next launch. File browsers and API tabs aren't restored.

## File browser (SFTP)

Right-click an SSH profile and choose **Open file browser (SFTP)**, or right-click an SSH tab and choose **Open file browser for this host**. It logs in with the profile's own credentials, host-key pinning and jump hosts. This computer is on the left, the server is on the right, and a list of transfers runs underneath.

- **Copy** by dragging files or folders between the panes, or by selecting them and pressing **Enter** or double-clicking a file to send it across. Double-click a folder to open it.
- **Rename, delete, new folder:** the right-click menu, or **F2**, **Del** and **Ctrl+Shift+N**.
- **Move around:** **Backspace** or **Alt+↑** goes up a folder, **F5** refreshes, **Ctrl+A** selects everything, and **Ctrl+click** or **Shift+click** select several. The path box takes a typed path: Enter goes there, and Esc puts back the current one.
- **Folder copies** are recursive. When you drop onto the folder you are looking at, Portique asks whether to skip or overwrite files that already exist; dropping onto a sub-folder always skips them. Symlinks *inside* a folder you copy are skipped.
- **Transfers** run three at a time. Each row in the list has a button that cancels it while it runs and removes it from the list afterwards, and **Clear finished** tidies the finished ones. A cancelled file is removed rather than left half-written.
- **Deleting a folder** removes everything in it, after a confirmation.

It speaks SFTP only. A server without the SFTP subsystem isn't supported. You don't need the old `scp` protocol, since OpenSSH's own `scp` uses SFTP now.

## The command palette

**Ctrl+Shift+P** opens one box for hosts, tabs, workspaces, splits, settings and looks, with matching that forgives gaps, and your recent choices first. It also holds quick connect for hosts you haven't saved, your saved commands, a toolbox of network checks and converters, tools that run on a connected server, and search through a terminal's scrollback. [The palette page](command-palette.md) covers all of it.

## Looks and settings

### Looks

**Interface colours…** (gear menu or palette) chooses the look of the window: **Nuit**, **Ivoire**, **Bordeaux**, **Forêt** or **Ardoise**, or your own colours. Dialogs, menus and the palette follow it. Terminals follow their own **colour theme**, chosen per profile. By default each tab is tinted with its terminal theme's colour; tick *Tabs use these colours, not their terminal theme's* to keep every tab in the interface look.

**Colour themes…** (gear menu) lists the terminal themes and lets you build your own. Built-in ones include Portique Nuit and Ivoire, Solarized Dark, Dracula, Nord, Gruvbox Dark, Green Phosphor, Amber and **SGI IRIX**. A theme can carry its own font: SGI IRIX also selects the bundled *Irix Screen Mono* font (CC0, see `THIRD-PARTY-NOTICES.md` in the repository root). The font is applied when you pick the theme, and a profile can still override it.

### The gear menu

The gear (*Menu and settings*) holds **Save workspace…**, a **Sidebar** switch (Ctrl+Shift+B), **SSH keys…**, **Interface colours…**, **Colour themes…**, **Settings…** and **Change master password…**. A lock button beside it locks the vault now.

### Settings…

- **Interface text size:** Normal or Large.
- **Reopen my tabs when Portique starts.**
- **Vault: Lock the vault after** Never, 1, 5, 15 (the default), 30 minutes or 1 hour, counted from your last key press, click or scroll. Using the vault also resets it. Open connections stay open when it locks; saved passwords and keys are asked for again.
- **File browser:** the default folder on this computer.
- **Local terminals:** described [above](#local-terminals).
- **Drop-down mode:** a terminal on a global hotkey.
- **GPU rendering for terminals.**

### Drop-down mode

Tick *Drop-down terminal on a global hotkey* in **Settings…**. The hotkey (Ctrl+` by default) shows and hides the window, docked to the top 45% of the screen at full width and above other windows. To change the hotkey, click its box and press the new keys; it needs Ctrl, Alt, Shift or Win, except for the function keys. F12 can't be used on Windows, which reserves it for debuggers. Some Linux desktops, Wayland among them, don't allow global hotkeys, and Portique reports that when it can't register one.

### Sidebar icons

Each row starts with an icon for its kind of connection, tinted to match: a boxed prompt for SSH, arrows for Telnet, a serial connector for Serial, a bare prompt for a local terminal, braces for an API connection and a grid for a saved workspace. Hover an icon for its name and a row for the address. File browser and API tabs carry the same icons.

## Security and your data

- **Vault.** Saved passwords, key passphrases, imported private keys and API secrets live in one encrypted file, `vault.bin`. A master password goes through Argon2id (128 MiB, 3 passes, 4 lanes) and then XChaCha20-Poly1305, with the header authenticated and a fresh nonce on every save. While unlocked, each secret stays sealed in memory and is opened only for the moment it is used; everything is wiped when it locks. The keys are kept in locked memory so they are not swapped to disk (and, on Linux, not written to a crash dump), and release builds on Linux refuse debuggers and memory reads from other programs (set `PORTIQUE_ALLOW_DEBUG=1` to turn that off when you need to debug). A new master password must be hard to guess: a bar shows how it rates, and several unrelated words work well. If `vault.bin` is older than the newest one this computer has opened (a restored backup, say), Portique warns and asks you to confirm before opening it. There is **no recovery** if you lose the master password. **Change master password…** is in the gear menu and the palette.
- **SSH keys.** **SSH keys…** (gear menu, palette, or **Manage keys…** in the profile editor) imports a private key into the vault and lists what it holds. A profile then chooses its *Private key*. Deleting a key warns you that profiles using it will stop connecting. `keys.json` holds only names and fingerprints.
- **Where things are.** Everything lives in `~/.config/portique` (`%APPDATA%\portique` on Windows): `profiles.json`, `vault.bin`, `keys.json`, `known_hosts.json` (pinned host keys), `themes.json`, `workspaces.json`, `settings.json` and `api.json` (API requests and environments).
- **To move to another computer or system,** copy that whole folder. Without `known_hosts.json` you will be asked to trust each server again, and without `api.json` your saved API requests are gone.

## Shortcuts

Press **F1**, or choose *Keyboard shortcuts* at the foot of the sidebar, for the list in the app.

| Keys | What they do |
|---|---|
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Shift+D / Ctrl+Shift+E | Split right / down |
| Alt+Shift+arrows | Move between panes |
| Ctrl+Shift+W | Close the pane, or the tab if it is the last pane |
| Ctrl+Shift+B | Hide or show the sidebar. Drag its edge to resize (it never gets narrower than your longest name) and double-click the edge to reset |
| Ctrl+Shift+C / V | Copy / paste in a terminal |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+F | Find in the terminal's scrollback |
| Ctrl+Shift+A | New API request |
