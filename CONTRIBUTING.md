# Contributing to Portique

This page explains how the code is laid out and how we work on it. [AGENTS.md](AGENTS.md) says the same for AI coding agents, so keep the two in step.

## The short version

1. Branch off `dev`: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `refactor/<slug>` or `chore/<slug>`.
2. Keep it small. If you can't describe the change in two sentences, split it.
3. Add `docs/changes/<slug>.md`: the long description, with the decisions you made written up ADR-style.
4. Open a PR into `dev` with a [Conventional Commit](https://www.conventionalcommits.org/) title and a **short** body that links to that file.
5. Squash-merge. The PR title becomes the commit message, and release notes are built from it.

## How the code is laid out

Portique is a [Tauri 2](https://tauri.app/) app: a Rust backend does the networking, files and secrets, and a plain TypeScript interface (no UI framework, built with Vite) draws the window.

```
src/            the interface (TypeScript + one stylesheet)
src-tauri/src/  the backend (Rust)
docs/           guides, and one file per change in docs/changes/
.github/        CI, release automation, PR template
```

### Interface (`src/`)

| Area | Files |
|---|---|
| App shell: sidebar, tabs, shortcuts, workspaces | `main.ts` |
| Talking to the backend (typed `invoke` wrappers and shared types) | `api.ts` |
| Terminals: split layout and the xterm.js terminal | `panes.ts`, `terminal-tab.ts` |
| SFTP file browser tab | `file-tab.ts` |
| API client | `api-tab.ts` (the tab), `http-request.ts` (one request), `api-connection.ts` (connection form), `http-model.ts` (types, address and header rules, curl), `http-checks.ts`, `http-import.ts`, `http-transfer.ts`, `http-store.ts`, `http-env.ts`, `http-proxy.ts` |
| Dialogs: profile editor, keys, themes, settings, vault | `editors.ts`, `settings-ui.ts`, `vault-ui.ts`, `host-prompts.ts` |
| Building blocks: DOM helper and modal, context menu, command palette | `ui.ts`, `menu.ts`, `palette.ts` |
| Palette Toolbox: the tool list and dialog (`toolbox.ts`), their logic and tests (`toolbox-core.ts`) | `toolbox.ts`, `toolbox-core.ts` |
| Looks: interface colours, terminal themes, emblem | `chrome.ts`, `themes.ts`, `emblem.ts` |
| Everything else | `help.ts` (shortcut panel), `shell-integration.ts`, `window-controls.ts` |
| All styling | `styles.css` (colours are CSS variables such as `--bg`, `--accent`, `--ok`) |

### Backend (`src-tauri/src/`)

| File | What it does |
|---|---|
| `lib.rs` | Registers the Tauri commands the interface can call, and app start-up |
| `session.rs` | Running sessions and the frames they stream to the interface |
| `ssh.rs`, `tunnel.rs`, `sftp.rs` | SSH shells, jump hosts, port forwards, the local SOCKS proxy, SFTP |
| `telnet.rs`, `serial.rs` | The other two network and serial terminal protocols |
| `local.rs` | Shells on this computer (cmd, PowerShell, WSL, Linux shells) run on a pseudo-terminal |
| `toolbox.rs` | The Toolbox's network checks: name lookup, port check, TCP ping, Wake-on-LAN |
| `http.rs` | The API client's HTTP engine: variables, OAuth, proxy |
| `store.rs` | Profiles, themes and the config folder |
| `vault.rs`, `keys.rs` | The encrypted vault and imported SSH keys |
| `window.rs` | Settings, drop-down mode, opening links |

### How the two halves talk

- The interface calls Rust through commands listed in `lib.rs` and wrapped in `src/api.ts`. Add a command in both places.
- Terminals, SFTP and the SSH proxy stream over a Tauri `Channel`. Each frame starts with a byte: `0` is terminal data, `1` is a JSON status message.
- **Secrets only ever live in the vault.** The interface can write a secret but never reads one back; Rust fills in secret values at the moment they are needed.
- Data files sit in the config folder (`~/.config/portique`, or `%APPDATA%\portique`): `profiles.json`, `api.json`, `themes.json`, `workspaces.json`, `settings.json`, `keys.json`, `known_hosts.json`, and the encrypted `vault.bin`.

## Running, testing, building

Linux needs: `pkg-config build-essential libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libudev-dev libxdo-dev`.

    npm install
    npm run tauri dev                 # run the app
    npx tsc --noEmit                  # type-check the interface
    cargo test --manifest-path src-tauri/Cargo.toml --lib    # backend tests
    npm run build                     # build the interface alone

CI runs the type-check and `cargo test`, then builds Linux and Windows. The SSH integration tests are `#[ignore]`d because they need local `sshd` instances (see `src-tauri/src/ssh.rs`); run them with `cargo test -- --ignored` and point `XDG_CONFIG_HOME` at a scratch folder first, because they write a vault.

There is no automated test runner for the interface yet. For visual changes, serve the built interface (`npx vite preview`) in a headless browser with a stand-in for `window.__TAURI_INTERNALS__`, and look at the result in each interface look (a light one especially).

### A Windows build from Linux

One-time: `rustup target add x86_64-pc-windows-gnu`, and install `mingw-w64`, `nasm` and `cmake`.

    npm run build
    cargo build --release --target x86_64-pc-windows-gnu --features custom-protocol --manifest-path src-tauri/Cargo.toml

`--features custom-protocol` is required; without it the window tries to reach the dev server. Ship `portique.exe` with `WebView2Loader.dll` beside it. CI builds the official Windows executable natively, so this is for local testing only.

## Working on a change

**One branch, one PR, one change file.**

- **Branches** come off `dev` and are named `<type>/<slug>`. `dev` is the integration branch; `main` is stable and only moves when `dev` is merged into it.
- **Short PRs.** A reviewer should be able to read the diff in one sitting. Move unrelated tidying to its own branch.
- **The PR body is short**: what changed, why, and a link. The template in `.github/pull_request_template.md` has the shape.
- **The long description goes in `docs/changes/<slug>.md`**, copied from `docs/changes/TEMPLATE.md`. It has the summary, how to review, what was tested, and the decisions. CI fails a PR that adds none, or whose file is still the template (`scripts/check-change-file.mjs`). A PR that truly needs none, such as a typo fix in an old change file, takes the `no-change-file` label; dependency and release PRs from bots are skipped.
- **Decisions are written ADR-style** in that file: for each real choice, the context, what was decided, what it costs, and what else was considered. A decision that will keep constraining future work also becomes a numbered record in [`docs/adr/`](docs/adr/README.md) and a line in the standing decisions in `AGENTS.md`.
- **PRs open as drafts** and are marked ready for review once CI passes and the author has nothing more to add. A draft means "not ready for your eyes yet"; ready means "please review". Agents follow the same rule (see `AGENTS.md`).
- **Commits and PR titles** follow Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, with `!` for breaking changes. Write the commit body to explain *why*.

### Dev builds and releases

Every push to `dev` is built and published as a **prerelease** on the Releases page, named for the version the next release will have: `v0.1.1-dev.17`. The Linux (`.tar.gz`, AppImage, `.deb`) and Windows (`.zip`) files carry that version in their names and inside the app, with SHA-256 sums. The newest ten are kept. Pull requests are built too, but only as workflow artifacts.

Merging `dev` into `main` makes release-please open (or update) a release PR that bumps the version in `package.json`, `Cargo.toml`, `Cargo.lock` and `tauri.conf.json` and writes `CHANGELOG.md`. Merging that PR tags the release (`v0.1.1`) and attaches the builds. The version is the dev build's without `-dev.N`, as long as `main` is built from the same commits.

- **Merge `dev` into `main` with a merge commit, never a squash.** The dev builds work out the next version from the commits since the last release tag, which only works if those commits stay in `main`'s history.
- Never edit the version by hand.

## House style

- **Match the surrounding code**: its naming, its comment density, its idioms. Comments say why, not what.
- **Keep the interface quiet.** Prefer a right-click menu or a shortcut to another button; a permanent button is for a primary action only.
- **Follow the interface look, not the terminal theme**, outside the terminals themselves. Use the colour variables in `styles.css`; for colours that carry meaning use `--ok`, `--warn`, `--danger`, `--info`, so they stay readable on light looks.
- **Keep writing plain.** Say what a feature does in everyday words, in the app, the docs and commit messages. Don't name other products we resemble.
- **Never change what is already on users' disks**: the vault's authenticated-data string `termix-vault`, the file names above, or the legacy theme ids (`termix-dark`, `termix-light`, which are aliased). Migrate instead.
