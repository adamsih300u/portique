# Portique

*Your servers, within reach.*

Portique is a desktop app for the machines and services you look after. Everything opens as a tab in one window:

- **Terminals** for SSH, Telnet and serial ports, with splits, saved workspaces and a command palette.
- **A file browser** for any SSH host: your computer on one side, the server on the other, drag to copy.
- **An API client**: point it at an endpoint, save the requests you use, check the responses, and keep tokens out of sight.

It runs on Windows and Linux. Under the hood it's Rust (Tauri 2) with a plain TypeScript interface and xterm.js for the terminals.

A few things we care about:

- **Secrets stay secret.** Passwords, key passphrases and API tokens live in one encrypted vault, never in plain files.
- **A quiet interface.** Right-click menus and shortcuts rather than rows of buttons, and every screen follows your chosen look (nuit, ivoire, bordeaux…).
- **Yours, on your computer.** No account, no cloud. Settings are plain files in your config folder.

*Portique* is French for the gantry or portico you walk through to reach somewhere. That's the idea.

## Try it

Each release and CI run has builds for Windows (`.exe`) and Linux (binary, AppImage, `.deb`). To run from source:

    npm install
    npm run tauri dev

## Read on

- [Using Portique](docs/using-portique.md) is the full tour of what it can do.
- [The API client](docs/api-client.md) covers connections, environments, checks and import.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how the code is laid out and how we work.
- [AGENTS.md](AGENTS.md) is the same, for AI coding agents.
