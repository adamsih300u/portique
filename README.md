# Portique

*Your servers, within reach.*

Portique is a desktop app for the machines and services you look after. Everything opens as a tab in one window:

- **Terminals** for SSH, Telnet, serial ports and (if you turn them on) the shells on your own computer, with splits, saved workspaces and a command palette.
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

    npm run build
    cd src-tauri
    cargo build --release --target x86_64-pc-windows-gnu --features custom-protocol

`--features custom-protocol` is required: without it the window tries to reach the dev server. The result is `target/x86_64-pc-windows-gnu/release/portique.exe`; ship it in a folder together with `WebView2Loader.dll` (same directory) `LICENSE`, `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-LICENSES.md`. It needs the WebView2 runtime, which Windows 10/11 include. CI builds the official Windows executable natively, so this is only for local test builds.

## Licence

Portique is MIT licensed, see `LICENSE`. Third-party notices are in `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-LICENSES.md`; after changing dependencies run `npm run licenses` to regenerate the latter.
    npm install
    npm run tauri dev

## Read on

- [Using Portique](docs/using-portique.md) is the full tour of what it can do.
- [The API client](docs/api-client.md) covers connections, environments, checks and import.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how the code is laid out and how we work.
- [AGENTS.md](AGENTS.md) is the same, for AI coding agents.
