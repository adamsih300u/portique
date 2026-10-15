# Keep terminals on the GPU renderer through a long session

- **Branch:** `fix/webgl-context-leak`
- **PR:** not opened yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

After a long session, typing and tab switching in Portique got sluggish while CPU and memory looked normal. Closed terminals kept their WebGL contexts, the browser engine pushed live terminals off the GPU to make room, and those terminals never came back. Closing a terminal now hands its context back at once, and a terminal that lost its context gets the GPU again when its tab is shown.

## Why

Each terminal pane draws with xterm's WebGL addon, one WebGL context per pane. Chromium (WebView2 on Windows) and WebKit keep at most 16 active contexts per page; past that they take the context of the oldest one. `WebglAddon.dispose()` only removes its canvas, so a closed terminal's context stays counted until garbage collection. Opening and closing tabs and splits over a session therefore evicts the contexts of terminals that are still open. When that happened, `onContextLoss` disposed the addon and the terminal stayed on xterm's DOM renderer for the rest of its life. The DOM renderer is far slower to type into, scroll and show.

## What changed

- `src/terminal-tab.ts`: `setGpu()` keeps the renderer's `WebGL2RenderingContext` when it loads the addon. The new `releaseGl()` disposes the addon, then calls `WEBGL_lose_context.loseContext()` on that context. It runs when a terminal is closed and when GPU rendering is switched off.
- `src/panes.ts`: `Tab.show(true)` asks every pane for the GPU renderer again (a no-op for panes that still have it).

## How to review

Start with `setGpu()` and `releaseGl()`. The addon keeps its context private, so `setGpu()` finds it on the canvases the addon has just added: it calls `getContext("webgl2")` on each one. Each of those canvases already holds a context: the 2D layers return null and the WebGL canvas returns its existing context. No context is ever created there. `releaseGl()` disposes the addon before it frees the context, so the addon's `webglcontextlost` handling is already gone and never fires for a closed terminal.

## What was tested

- `tsc --noEmit`, `eslint` (no new warnings) and `vitest run` (154 passed).
- A headless Chromium page that drives the real `TerminalTab` with a mocked Tauri backend:
  - one terminal open while 20 others open and close: on `origin/dev` the open terminal **loses** the GPU renderer; with this branch it keeps it;
  - 21 open at once: 16 keep the GPU (the browser limit), and the oldest gets it back on `setGpu(true)`, the call `Tab.show()` makes;
  - the context is captured, and the run logged 6 context losses: 5 from opening 21 terminals and 1 when the shown terminal took a context back. None came from closed terminals.
- **Not run:** the real app on Windows (WebView2) or Linux (WebKitGTK). Nobody has yet timed typing after a long session with the fix.

## Not done / follow-ups

- More than 16 terminals open at once still means some hidden ones run on the DOM renderer until they are shown. That is fine for hidden tabs. A tab with more than 16 visible panes would have panes taking contexts from each other, which is not handled.
- `help.ts`: closing the shortcuts panel with F1 (rather than Esc or a click away) leaves two window listeners behind. Small and unrelated to this slowdown; separate fix.

## Decisions

### D1. Win the GPU back when a tab is shown, not as soon as the context is lost

- **Status:** accepted
- **Context:** A lost terminal can only get a context by taking someone else's. Asking again straight from `onContextLoss` makes terminals take contexts from each other in a loop when more than 16 are open.
- **Decision:** a terminal that lost its context stays on the DOM renderer until its tab is shown, then asks again. The context it takes belongs to the oldest terminal, which in practice sits in a hidden tab.
- **Consequences:** visible panes are on the GPU in all normal layouts; hidden tabs may not be, which costs nothing while they are hidden. Showing such a tab rebuilds the glyph atlas once.
- **Alternatives considered:** dropping the GPU renderer from every hidden tab (keeps the count low, but every tab switch pays an atlas rebuild); retrying on a timer (contexts can bounce between terminals); leaving it to garbage collection (the bug).
