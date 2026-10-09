# Use a GitHub-based app identifier instead of a personal domain

- **Branch:** `chore/bundle-identifier`
- **PR:** see the draft PR for this branch
- **Status:** draft
- **Author:** Claude, for Adam Pilbeam

## Summary

The Tauri app identifier changes from `net.pilbeams.portique` to `io.github.adamsih300u.portique`, so it matches the repository owner and no longer carries a personal domain.

## Why

The identifier is baked into every built app and is public once released. Adam did not want his domain tied to the project, and the GitHub-style form matches the repository (`adamsih300u/portique`). Doing it before the first release keeps the cost near zero.

## What changed

- `src-tauri/tauri.conf.json`: `identifier` only. Nothing else in the repo referenced the old value.

## How to review

One line. Check the new value is what you want to live with, because changing it again after release has real costs (see D1).

## What was tested

Read the code paths that could depend on the identifier. `store::data_dir()` uses `dirs::config_dir()/portique`, not Tauri's `app_data_dir`, so the vault and saved connections do not move. **Not run:** `tauri build` or the app on any platform.

## Not done / follow-ups

- Webview storage (localStorage) is keyed by the identifier on some platforms, so small UI preferences (palette recents, request layout, last local folder) reset once for anyone who ran an earlier build. Nothing else is lost.
- Existing git history still contains the author email and the old identifier in the initial commit; this change does not rewrite history.

## Decisions

### D1. Identifier is `io.github.adamsih300u.portique`

- **Status:** accepted
- **Context:** The identifier names the app on macOS, Windows and Linux and is visible in any build. Changing it after release can orphan per-app webview data and installer identity.
- **Decision:** Use `io.github.adamsih300u.portique`, matching the GitHub owner and repo.
- **Consequences:** No personal domain in builds. The value should now be treated as frozen once a release ships. Vault and connection data are unaffected because they live under `config_dir()/portique`.
- **Alternatives considered:** Keep `net.pilbeams.portique` (exposes the domain); a neutral name such as `app.portique.desktop` (implies a domain we do not own).
