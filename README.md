# Portique

*Your servers, within reach.*

Portique is a desktop app for the machines and services you look after. Everything opens as a tab in one window:

- **Terminals** for SSH, Telnet, serial ports and (if you turn them on) the shells on your own computer, with splits and saved workspaces.
- **A file browser** for any SSH host: your computer on one side, the server on the other, drag to copy.
- **An API client**: point it at an endpoint, save the requests you use, check the responses, and keep tokens out of sight.
- **A command palette** (Ctrl+Shift+P) that reaches all of it, and also holds network checks, converters and generators, and tools that look at and manage a connected server.

It runs on Windows and Linux. Under the hood it's Rust (Tauri 2) with a plain TypeScript interface and xterm.js for the terminals.

A few things we care about:

- **Secrets stay secret.** Passwords, key passphrases and API tokens live in one encrypted vault, never in plain files.
- **A quiet interface.** Right-click menus and shortcuts rather than rows of buttons, and every screen follows your chosen look (nuit, ivoire, bordeaux…).
- **Yours, on your computer.** No account, no cloud. Settings are plain files in your config folder.

*Portique* is French for the gantry or portico you walk through to reach somewhere. That's the idea.

## Try it

Each release has downloads for Windows (a `.zip` holding `portique.exe`) and Linux (a `.tar.gz`, an AppImage and a `.deb`) on the [Releases page](https://github.com/adamsih300u/portique/releases). Every change to the code that lands on the `dev` branch is published there as a prerelease (a change to only docs or repository settings is not). Windows needs the WebView2 runtime, which Windows 10 and 11 include.

To run it from source, install [Node.js](https://nodejs.org) 22 and [Rust](https://rustup.rs), then:

    npm install
    npm run tauri dev

On Linux you also need a few system libraries; [CONTRIBUTING.md](CONTRIBUTING.md#running-testing-building) lists them, and explains how to build a Windows executable from Linux.

## Read on

- [Using Portique](docs/using-portique.md) is the full tour of what it can do.
- [The command palette](docs/command-palette.md) covers quick connect, saved commands, the toolbox and the server tools.
- [The API client](docs/api-client.md) covers connections, environments, checks and import.
- [Agent access](docs/agent-access.md) covers letting an AI agent use your terminals, in tabs you can watch.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how the code is laid out and how we work.
- [AGENTS.md](AGENTS.md) is the same, for AI coding agents.

## Licence

Portique is MIT licensed, see `LICENSE`. Third-party notices are in `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-LICENSES.md`; after changing dependencies run `npm run licenses` to regenerate the latter.
