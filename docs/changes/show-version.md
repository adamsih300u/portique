# Show the version on the empty screen

- **Branch:** `feat/show-version`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

The pane shown when no tab is open now has the running version at the foot, small and faint, as `v0.5.0` (or `v0.5.1-dev.42` in a dev build). It is the same string the GitHub release or prerelease is named, so a person can tell at a glance whether they have the latest, and a bug report can quote it.

## Why

The release pipeline now publishes numbered builds ([release-from-main](release-from-main.md)) and the app gave no way to see which one you were running. The text can be selected, so it can be copied into an issue.

[ADR-0005](../adr/0005-interface-follows-the-look.md) governs the colours (a CSS variable, no hex), [ADR-0009](../adr/0009-italic-is-the-apps-voice.md) the type (upright, since it is a label and not the app's voice), and the standing rule to keep the interface quiet is why it is one faint line on an existing pane and not a control or a dialog.

## What changed

- `main.ts`: asks Tauri for the app's version and fills a line at the foot of the empty pane. The line stays hidden until the answer arrives, and stays hidden if it never does.
- `styles.css`: the line's style (small, tabular numbers, half opacity, positioned at the bottom, selectable).

No capability change: `core:default` already allows reading the version.

## How to review

`appVersion` in `main.ts`, and the two `.empty .version` rules.

## What was tested

`npx tsc --noEmit`, `npm run lint` (no new warnings), `npx vitest run` (154 tests), `npm run build`. In headless Chromium against a mocked backend: the default dark look and the Ivoire light look, in a normal and in a short (900 by 420) window. The line sits below the hint text without touching it.

**Not run:** against the real Tauri backend, so the actual string a packaged build reports is unchecked. The dev build stamps its version into `tauri.conf.json` (`scripts/set-version.mjs`), which is where the value comes from, so it should read `v0.5.1-dev.N` in a dev build and `v0.5.0` in a release. Also not run: Windows, and a window shorter than about 400 pixels, where the line would meet the hint text.

## Not done / follow-ups

- The version is only on the empty screen. An *About* entry in the gear menu or the palette would reach people who always have a tab open.
- A shortcut or button to copy it.

## Decisions

### D1. Read the version from the running app, not from a build constant

- **Status:** accepted
- **Context:** Dev builds are stamped with a version in CI (`0.5.1-dev.42`) that is never committed, so the repository's `package.json` is the last release, not what is running.
- **Decision:** `getVersion()` from Tauri's app API, which reads the version the build was packaged with.
- **Consequences:** The number on screen is the number in the release name, for dev builds as well as releases, with no build step to keep in sync. In a plain browser, or if the call fails, nothing is shown.
- **Alternatives considered:** Injecting `package.json`'s version at build time (it would say 0.5.0 on every dev build). Showing it in the title bar (the window already shows it in places, but not in the interface; this stays where nothing else is).
