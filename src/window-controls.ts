import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./ui";

const svg = (d: string) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 10 10");
  el.innerHTML = d; // static literals below, never user data
  return el;
};
const ICONS = {
  min: '<path d="M1 5.5h8"/>',
  max: '<rect x="1.5" y="1.5" width="7" height="7"/>',
  restore: '<path d="M3 3V1.5h5.5V7H7"/><rect x="1.5" y="3" width="5.5" height="5.5"/>',
  close: '<path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/>',
};

/** An undecorated maximised window on Windows overshoots the work area by its invisible resize
 * border, hiding the bottom rows behind the taskbar. Shrink the app by however far it overshoots. */
function syncInset(maximized: boolean) {
  const over = maximized ? Math.round(window.screenY + window.innerHeight - ((screen as { availTop?: number }).availTop ?? 0) - screen.availHeight) : 0;
  document.documentElement.style.setProperty("--inset-bottom", `${Math.max(0, over)}px`);
}

/** Slim minimise / maximise / close buttons, plus a drag spacer, for the undecorated window. */
export function windowControls(): HTMLElement[] {
  const win = getCurrentWindow();
  const maxBtn = h("button", { class: "wc", title: "Maximise", tabindex: -1, onclick: () => void win.toggleMaximize() }, svg(ICONS.max));
  const sync = async () => {
    const on = await win.isMaximized().catch(() => false);
    syncInset(on);
    maxBtn.replaceChildren(svg(on ? ICONS.restore : ICONS.max));
    maxBtn.title = on ? "Restore" : "Maximise";
  };
  void win.onResized(() => void sync()).catch(() => {});
  void sync();
  return [
    h("div", { class: "tab-drag", "data-tauri-drag-region": true }),
    h("div", { class: "winctl" },
      h("button", { class: "wc", title: "Minimise", tabindex: -1, onclick: () => void win.minimize() }, svg(ICONS.min)),
      maxBtn,
      h("button", { class: "wc close", title: "Close", tabindex: -1, onclick: () => void win.close() }, svg(ICONS.close))),
  ];
}
