# Agent guide

For AI coding agents working in this repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md); this page says the same things in the order an agent needs them, plus the rules that keep several agents' work consistent.

Portique is a Tauri 2 desktop app (Rust backend, plain TypeScript interface, no UI framework) for terminals, SFTP and an API client. See the [README](README.md) for what it is and [docs/using-portique.md](docs/using-portique.md) for what it does.

## Before you start

1. Read this page, then the part of [CONTRIBUTING.md](CONTRIBUTING.md#how-the-code-is-laid-out) that covers the area you'll touch.
2. Skim `docs/changes/` for earlier changes in that area. Their decisions still apply unless a newer file supersedes them.
3. **Consult the decision records.** Read the index in [docs/adr/README.md](docs/adr/README.md) and open each record that touches your area. Sort them into those that support your approach, those that constrain it and those it conflicts with. Cite the first two in your change file's *Why*. Put every conflict in front of the user, with what the record decided and why your approach departs from it, and wait for their ruling before you write code. When you cannot ask (a background run), stop at the conflict and report it. If the user rules for the new direction, write a new record that names the old one under *Supersedes* or *Related*, and update the old record's *Status* and *Superseded by*.
4. Look at the neighbouring code and copy its style before writing yours.

## Hard rules

- **Secrets live only in the vault.** Never put a password, token or key in a JSON file, a log, an error message or a commit. The interface may write a secret but must never read one back; Rust substitutes secret values when they are needed.
- **Never change what's already on users' disks.** The vault's authenticated-data string `termix-vault`, the data file names, and the legacy theme ids `termix-dark` / `termix-light` are frozen. Add a migration instead.
- **Don't name other products we resemble** (in docs, code, comments, UI text, commits or PRs). Describe the feature in plain words.
- **Never push to `main`, never force-push, never merge.** Work on a branch off `dev` and open a PR into `dev`. Merging `dev` into `main` is a release decision for the maintainer.
- **Don't edit the version by hand** (release-please owns it) or `CHANGELOG.md`.
- **Don't use credentials you weren't given.** If a push or API call needs sign-in you don't have, stop and say exactly what is needed.

## Where things live

```
src/            interface: main.ts (shell), api.ts (calls into Rust), *-tab.ts (tabs), http-*.ts (API client), agent-*.ts (agent access), editors.ts (dialogs), chrome.ts (looks), styles.css
src-tauri/src/  backend: lib.rs (commands), session.rs, ssh.rs, tunnel.rs, sftp.rs, telnet.rs, serial.rs, local.rs, toolbox.rs, http.rs, agent/ (the MCP server), store.rs, vault.rs, keys.rs, window.rs
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
    npm run lint                                             # eslint (CI runs this)
    npm test                                                 # interface unit tests (CI runs these)
    cargo test --manifest-path src-tauri/Cargo.toml --lib    # backend tests (CI runs these)
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   # CI runs this
    npm run build                                            # interface bundle
    npm run tauri dev                                        # run the app

Windows executable from Linux: see [CONTRIBUTING.md](CONTRIBUTING.md#a-windows-build-from-linux). Logic that doesn't need a window has unit tests in `src/*.test.ts`; there is no test runner for the screens, so for visual changes serve `npx vite preview` in a headless browser with a mocked `window.__TAURI_INTERNALS__` and check each interface look, a light one especially. Say in the change file what you did and did not run. Don't claim something works on Windows or against a real SSH server unless you ran it there.

## Doing a change

1. **Work in a worktree** under `.claude/worktrees/` on a branch off `dev`, named `<type>/<slug>` (`feat`, `fix`, `docs`, `refactor`, `chore`). Reuse an existing build cache with `CARGO_TARGET_DIR` and a symlinked `node_modules` if you can.
2. **Keep it small.** One branch is one PR is one change file. If it needs two sentences too many to describe, split it.
3. **Write `docs/changes/<slug>.md`** from [docs/changes/TEMPLATE.md](docs/changes/TEMPLATE.md) as you go. It holds the long description and the decisions. CI checks that the file is new and has every section and decision field; run `node scripts/check-change-file.mjs origin/dev` before you push.
4. **Record decisions ADR-style** in that file: context, decision, consequences, alternatives considered. If a decision will keep constraining later work, also write it as a numbered record in [docs/adr/](docs/adr/README.md) (copy `docs/adr/TEMPLATE.md`, and follow the style notes in that README: concise, positive, about 150 words) and add a line to *Standing decisions* below. A record that overrides or sits against an earlier one names it under *Supersedes* or *Related*.
5. **Commit with a Conventional Commit message** (`feat(api): …`, `fix(ui): …`). The body says why. Add whatever attribution trailer your environment asks for.
6. **Open the PR into `dev` as a draft** (`gh pr create --draft --base dev`) with a Conventional Commit title and a short body from `.github/pull_request_template.md`: what, why, link to the change file. Don't paste the long description into the PR.
7. **Mark it ready once CI passes, if your work is finished.** Wait for the checks (`gh pr checks <number> --watch`); a skipped check counts as passing. If they all pass, the PR has no conflicts and you have nothing more to add, run `gh pr ready <number>`. If a check fails, fix it and push; read the log first, and do not re-run it hoping it passes. If you cannot fix it, or the work is not finished, leave the PR a draft and say why in your report. Marking ready is the last thing you do: it asks the maintainer to review. **Never merge or approve** (see below).
8. **Finish by reporting**: what you did, where it lives (branch, path, PR), what you ran and its result (including whether the PR is draft or ready, and why), and anything you couldn't do.

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
- **Italic is for the app's voice** (wordmark, tagline, empty-state messages); controls and labels are upright, and category labels are serif small-caps. → [ADR-0009](docs/adr/0009-italic-is-the-apps-voice.md)
- A **local terminal** starts only from a shell Rust found, by id, and only when the settings turn it on; the interface never names a program. → [ADR-0010](docs/adr/0010-local-shells-start-by-id.md)
- **Server tools run beside the shell**, on a new channel of its connection, only while it is connected; a person must be able to see what a tool will change before it runs. → [ADR-0011](docs/adr/0011-server-commands-run-beside-the-shell.md)
- A server tool that **changes** something declares an `action`: the dialog shows the exact command first, nothing runs until the person presses the button, and root comes only from `sudo -n`; no tool enters a password. → [ADR-0012](docs/adr/0012-server-changes-show-their-command-first.md)
- **An older `vault.bin` is refused** until the person confirms; the vault carries a save counter and each computer remembers the highest it opened in `vault.seen`. Never store that note beside `vault.bin`. → [ADR-0013](docs/adr/0013-older-vault-is-refused.md)
- **Vault secrets are sealed in memory** and opened one at a time with `Vault::get`, which returns a self-wiping `Zeroizing<String>`. Don't hold one longer than the call needs, and don't add a way to open them all. → [ADR-0014](docs/adr/0014-secrets-sealed-in-memory.md)
- **Vault keys go in `LockedKey`, and secrets arrive as `Zeroizing<String>`.** A key never sits in an ordinary buffer, and a password a command receives is wrapped so it is wiped on drop. The master password is sent as raw bytes (`ipc.rs`, `secret-ipc.ts`), not JSON; keep any new command that takes it on that path. → [ADR-0015](docs/adr/0015-keys-pinned-and-process-hardened.md)
- **Agent access is off by default and set per profile**, in `settings.json` by profile id, never in the profile. An agent sees only profiles that are on and uses only sessions it opened itself. → [ADR-0016](docs/adr/0016-agent-access-is-off-and-per-profile.md)
- **The agent server lives in the app, on loopback only**, behind a per-start token and `Host`/`Origin` checks; `portique mcp` bridges stdio to it. → [ADR-0017](docs/adr/0017-agent-server-in-the-app-on-loopback.md)
- **An agent's command ends with markers typed around it in the open shell** (POSIX shells only); the person can see it and take the keyboard. The activity log stays in memory. → [ADR-0018](docs/adr/0018-commands-finish-with-markers-in-the-open-shell.md)
- **An agent's first step in a session needs the master password** (while a vault exists and the one setting is on): it is checked in Rust, a plain answer cannot grant it, and locking the vault ends it. → [ADR-0019](docs/adr/0019-an-agents-first-step-needs-the-master-password.md)
- The interface stays **quiet**: context menus and shortcuts over permanent buttons.
- The app was renamed from Termix to **Portique**; the frozen on-disk names above are the reason some `termix` strings remain.
