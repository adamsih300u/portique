# Agent guide

For AI coding agents working in this repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md); this page says the same things in the order an agent needs them, plus the rules that keep several agents' work consistent.

Portique is a Tauri 2 desktop app (Rust backend, plain TypeScript interface, no UI framework) for terminals, SFTP and an API client. See the [README](README.md) for what it is and [docs/using-portique.md](docs/using-portique.md) for what it does.

## Before you start

1. Read this page, then the part of [CONTRIBUTING.md](CONTRIBUTING.md#how-the-code-is-laid-out) that covers the area you'll touch.
2. Skim `docs/changes/` for earlier changes in that area. Their decisions still apply unless a newer file supersedes them.
3. Look at the neighbouring code and copy its style before writing yours.

## Hard rules

- **Secrets live only in the vault.** Never put a password, token or key in a JSON file, a log, an error message or a commit. The interface may write a secret but must never read one back; Rust substitutes secret values when they are needed.
- **Never change what's already on users' disks.** The vault's authenticated-data string `termix-vault`, the data file names, and the legacy theme ids `termix-dark` / `termix-light` are frozen. Add a migration instead.
- **Don't name other products we resemble** (in docs, code, comments, UI text, commits or PRs). Describe the feature in plain words.
- **Never push to `main`, never force-push, never merge.** Work on a branch off `dev` and open a PR into `dev`. Merging `dev` into `main` is a release decision for the maintainer.
- **Don't edit the version by hand** (release-please owns it) or `CHANGELOG.md`.
- **Don't use credentials you weren't given.** If a push or API call needs sign-in you don't have, stop and say exactly what is needed.

## Where things live

```
src/            interface: main.ts (shell), api.ts (calls into Rust), *-tab.ts (tabs), http-*.ts (API client), editors.ts (dialogs), chrome.ts (looks), styles.css
src-tauri/src/  backend: lib.rs (commands), session.rs, ssh.rs, tunnel.rs, sftp.rs, telnet.rs, serial.rs, http.rs, store.rs, vault.rs, keys.rs, window.rs
docs/           guides; docs/changes/ has one file per change
```

The full file-by-file table is in [CONTRIBUTING.md](CONTRIBUTING.md#how-the-code-is-laid-out). Things that trip agents up:

- **A new backend command needs three edits**: the function and its entry in `generate_handler!` in `lib.rs`, a typed wrapper in `src/api.ts`, and (if the window should be allowed to use a plugin) `src-tauri/capabilities/default.json`.
- **Terminal, SFTP and SSH-proxy sessions stream over a `Channel`.** Frame byte `0` is data, `1` is a JSON `{state, message}` status. `session::start` dispatches by protocol; a new protocol needs an arm there.
- **Profiles are shared with the backend.** `Profile` in `store.rs` and in `src/api.ts` must match. Fields the frontend owns are kept as opaque JSON in Rust (`Profile.api`).
- **API connection data is split on purpose:** a connection's settings are in its profile (`profiles.json`); its requests and environments are in `api.json`, keyed by the profile id (`http-store.ts`). Secret environment values are in the vault under `apienv:<envId>:<name>`.
- **Styling uses variables.** `chrome.ts` re-tints them per region (sidebar, tab bar, content, and the document root so dialogs match). Use `var(--…)`, not hex colours, outside terminals.
- **The interface has no framework.** Build DOM with `h()` from `ui.ts`; use `textContent` or text nodes for anything that came from outside, never `innerHTML` with data.

## Commands

    npm install
    npx tsc --noEmit                                         # type-check (CI runs this)
    cargo test --manifest-path src-tauri/Cargo.toml --lib    # backend tests (CI runs these)
    npm run build                                            # interface bundle
    npm run tauri dev                                        # run the app

Windows executable from Linux: see [CONTRIBUTING.md](CONTRIBUTING.md#a-windows-build-from-linux). There is no interface test runner yet; for visual changes, serve `npx vite preview` in a headless browser with a mocked `window.__TAURI_INTERNALS__` and check each interface look, a light one especially. Say in the change file what you did and did not run. Don't claim something works on Windows or against a real SSH server unless you ran it there.

## Doing a change

1. **Work in a worktree** under `.claude/worktrees/` on a branch off `dev`, named `<type>/<slug>` (`feat`, `fix`, `docs`, `refactor`, `chore`). Reuse an existing build cache with `CARGO_TARGET_DIR` and a symlinked `node_modules` if you can.
2. **Keep it small.** One branch is one PR is one change file. If it needs two sentences too many to describe, split it.
3. **Write `docs/changes/<slug>.md`** from [docs/changes/TEMPLATE.md](docs/changes/TEMPLATE.md) as you go. It holds the long description and the decisions. CI checks that the file is new and has every section and decision field; run `node scripts/check-change-file.mjs origin/dev` before you push.
4. **Record decisions ADR-style** in that file: context, decision, consequences, alternatives considered. If a decision will keep constraining later work, also write it as a numbered record in [docs/adr/](docs/adr/README.md) (copy `docs/adr/TEMPLATE.md`) and add a line to *Standing decisions* below.
5. **Commit with a Conventional Commit message** (`feat(api): …`, `fix(ui): …`). The body says why. Add whatever attribution trailer your environment asks for.
6. **Open the PR into `dev`** with a Conventional Commit title and a short body from `.github/pull_request_template.md`: what, why, link to the change file. Don't paste the long description into the PR.
7. **Finish by reporting**: what you did, where it lives (branch, path, PR), what you ran and its result, and anything you couldn't do.

Done means: type-check and backend tests pass, the change file exists and is honest about gaps, docs affected by the change are updated, and the diff has nothing unrelated in it.

## Standing decisions

Decisions that still bind new work. Each links to its record in [docs/adr/](docs/adr/README.md), where the context and alternatives are.

- An API endpoint is a **profile** (`protocol: "api"`) whose tab holds its saved requests. There is no global request list. → [ADR-0001](docs/adr/0001-api-endpoint-is-a-profile.md)
- API requests are sent **from Rust**, and secret variables are filled in there and never returned to the interface. → [ADR-0002](docs/adr/0002-send-requests-from-rust.md), [ADR-0003](docs/adr/0003-secrets-never-read-back.md)
- Sending through an SSH host uses a **local SOCKS5 proxy** over the existing forwarder, with names resolved on the server. → [ADR-0004](docs/adr/0004-ssh-socks5-proxy-for-requests.md)
- **Outside terminals the interface follows the interface look**, never a terminal theme; meaningful colours are the `--ok/--warn/--danger/--info` family. → [ADR-0005](docs/adr/0005-interface-follows-the-look.md)
- **Pushes to `dev` publish `vX.Y.Z-dev.N` prereleases**; `dev` is merged into `main` with a **merge commit**, never squashed, so the next version can be predicted. → [ADR-0006](docs/adr/0006-dev-merged-with-merge-commit.md), [dev-prereleases](docs/changes/dev-prereleases.md)
- **Nothing merges into `main` or `dev` without the maintainer's approval.** Agents never merge, approve, or edit the protection rules. → [ADR-0007](docs/adr/0007-maintainer-approves-merges.md)
- **The README is short.** Detail goes in `docs/`; long PR descriptions go in `docs/changes/`. → [ADR-0008](docs/adr/0008-short-readme.md)
- The interface stays **quiet**: context menus and shortcuts over permanent buttons.
- The app was renamed from Termix to **Portique**; the frozen on-disk names above are the reason some `termix` strings remain.
