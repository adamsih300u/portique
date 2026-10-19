# Let closed terminals and the shortcuts panel go

- **Branch:** `fix/mouse-lag-long-session`
- **PR:** [#77](https://github.com/adamsih300u/portique/pull/77)
- **Status:** draft
- **Author:** Claude (agent)

## Summary

This change comes from a report that Portique responds a little less well to the mouse after a long session, with CPU and memory staying low. It fixes two small leaks found while looking into that. It is not shown to be the cause: a soak of `dev` in headless Chromium did not reproduce a slowdown that builds up (see What was tested).

- A closed terminal stays reachable from its Tauri channel handler until the backend ends the stream, so its xterm screen, DOM and listeners stay in memory until then. The terminal now detaches its handler when it closes or reconnects.
- Closing the shortcuts panel with F1 or the sidebar link left its two capture listeners on `window` until the next click. `closeHelp()` now removes them whichever way the panel closes.

## Why

The page keeps a `Channel`'s callback in a global table until the backend sends the stream's end message, which Tauri sends when the Rust side drops the channel. Each session's channel lives inside its `Emitter`, so a closed tab is held for as long as any `Emitter` clone lives. In the harness, with no end message, each closed terminal left about 26 nodes and 12 listeners behind, and these stayed after garbage collection.

## What changed

- `src/terminal-tab.ts`: keeps the session's `Channel` and adds `detachChannel()`, which swaps in a no-op handler. `dispose()` calls it, and so does `connect()` before it opens a new stream, so late frames from an old session cannot land in the new one.
- `src/help.ts`: listener removal moved into `closeHelp()`.

## What was tested

- `tsc --noEmit`, `eslint`, `vitest run`.
- Headless Chromium with a mocked Tauri backend, driven over CDP:
  - Churn: 6 cycles of opening 3 tabs, a tab menu, a pane menu, F1 twice, hovering, switching and closing back to 2 tabs. Without stream ends, retained nodes rose by about 78 per cycle and listeners by about 36. With stream ends, both stayed flat.
  - Soak: 4 terminals streaming at 20 lines/s for 8 minutes with steady hovering and tab clicks. Nodes, listeners, live WebGL contexts and input latency stayed flat throughout.
- **Not run:** the real app on Windows or Linux.

## Not done / follow-ups

- The reported slowdown is not explained yet. The next step is to confirm which build showed it: the WebGL context fix (#75) is in `v0.5.1-dev.45` but not in `v0.5.0`.
- Almost every Tauri command is synchronous, so it runs on the main thread, which on Windows also handles window input. None of them grows with uptime, but making `vault_touch`, `session_input`, `session_resize` and `save_workspaces` `async` would keep backend work off the input path.
