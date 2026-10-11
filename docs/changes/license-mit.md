# License Portique under MIT and ship third-party notices

- **Branch:** `chore/license-mit`
- **PR:** see the draft PR for this branch
- **Status:** draft
- **Author:** Claude, for Adam Pilbeam

## Summary

Portique now has a licence: MIT, copyright Adam Pilbeam. Every library compiled into the app has its licence text reproduced in a generated file, and the release archives, `.deb` and AppImage are set up to carry the licence files.

## Why

The repo had no `LICENSE`, so by default nobody could use or redistribute it. The libraries and fonts we ship each require their notice to travel with the binary (MIT, BSD, Apache-2.0, ISC, OFL, MPL-2.0), and `THIRD-PARTY-NOTICES.md` only covered the two fonts.

## What changed

- `LICENSE` (MIT), plus `license` and `authors` in `package.json` and `Cargo.toml`, and `copyright`, `license`, `licenseFile` in `tauri.conf.json`.
- `scripts/gen-licenses.mjs` (`npm run licenses`) writes `THIRD-PARTY-LICENSES.md`: licence text for 491 Rust crates and npm packages, grouped so each distinct text appears once.
- `THIRD-PARTY-NOTICES.md` now explains the layout, the licence choice for dual-licensed crates, and where the source of the six MPL-2.0 crates lives.
- `.github/workflows/build.yml`: the zip and tar.gz now include `LICENSE` and both notice files; `tauri.conf.json` bundles them as resources for deb and AppImage.
- README gets a short Licence section.

## How to review

Read `scripts/gen-licenses.mjs` and `THIRD-PARTY-NOTICES.md`. `THIRD-PARTY-LICENSES.md` is 2 MB of generated text; skim the "no licence file" section at the end rather than the whole file.

## What was tested

The generator ran on Linux against the offline cargo registry and `node_modules`; the JSON configs parse; `cargo metadata --locked` still works (no lockfile change). **Not run:** the CI workflow, `tauri build` with the new `resources` and `licenseFile` keys, a Windows build.

## Not done / follow-ups

- No CI check that `THIRD-PARTY-LICENSES.md` is up to date; a stale file is easy to miss after a Dependabot bump.
- Twelve crates ship no licence file (e.g. `russh`, Apache-2.0). They are listed with licence, repo and authors; their licence text appears under the same heading elsewhere in the file.
- `AGENTS.md` (on `docs/repo-guides`) could list the licence under Standing decisions once that PR merges.

## Decisions

### D1. Licence Portique under MIT

- **Status:** accepted
- **Context:** Sole-author project; every dependency licence is permissive or file-level copyleft.
- **Decision:** MIT, copyright Adam Pilbeam.
- **Consequences:** Anyone may use and redistribute it. Dependencies stay compatible as long as we avoid GPL/AGPL-only crates; dual-licensed ones (`unescaper`) are used under their permissive option.
- **Alternatives considered:** Apache-2.0 (patent grant) and GPL/AGPL (keeps forks open); not chosen.

### D2. Generate the dependency licence file instead of writing it by hand

- **Status:** accepted
- **Context:** About 500 packages; hand-written notices would go stale at once.
- **Decision:** A small script reads `cargo tree` for Linux and Windows (normal dependencies only) and the production entries of `package-lock.json`.
- **Consequences:** Regenerate after dependency changes. Dev/build-only and other-OS-only crates are left out on purpose.
- **Alternatives considered:** `cargo-about` (not installed, adds a tool and a config file, and doesn't cover npm).
