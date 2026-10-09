import { protoIcon, type IconKind } from "./proto-icon";
import { h } from "./ui";

/** Sidebar width before the user drags it, in unscaled pixels (multiplied by `--s` in CSS). */
export const DEFAULT_WIDTH = 250;
/** The sidebar never takes more than this share of the window. */
const MAX_SHARE = 0.5;
const KEY = "portique.sidebar";

export interface SidebarState {
  collapsed: boolean;
  /** Unscaled pixels; null means the default. */
  width: number | null;
}

/** Keeps `width` between the longest name (`min`) and half the window, with `min` winning if they clash. */
export function clampWidth(width: number, min: number, windowWidth: number): number {
  const max = Math.max(min, windowWidth * MAX_SHARE);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Reads a saved state, tolerating anything a hand-edited or older value might hold. */
export function parseState(raw: string | null): SidebarState {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<SidebarState>;
    const w = typeof v.width === "number" && Number.isFinite(v.width) && v.width > 0 ? v.width : null;
    return { collapsed: v.collapsed === true, width: w };
  } catch {
    return { collapsed: false, width: null };
  }
}

/** What the sidebar lists, however it is filtered or folded right now. */
export interface Names {
  groups: string[];
  rows: { name: string; icon: IconKind }[];
}

/**
 * Collapse and drag-to-resize for the sidebar. The state is a per-viewer convenience kept in
 * localStorage (failures are ignored). `names` returns everything the list can show, so the
 * minimum width fits the longest entry even when a search or a folded group hides it.
 */
export function initSidebar(app: HTMLElement, aside: HTMLElement, list: HTMLElement, names: () => Names) {
  let state: SidebarState = { collapsed: false, width: null };
  try { state = parseState(localStorage.getItem(KEY)); } catch { /* storage unavailable */ }

  const scale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--s")) || 1;

  /** Width, in unscaled pixels, that fits the longest group or profile name (and the list's scrollbar). */
  function minWidth(): number {
    const { groups, rows } = names();
    const ruler = h("div", { class: "side-ruler", "aria-hidden": "true" },
      ...groups.map((g) => h("div", { class: "group" }, g)),
      ...rows.map((r) => h("div", { class: "profile" },
        protoIcon(r.icon), h("span", { class: "pname" }, r.name))));
    aside.append(ruler);
    const widest = ruler.scrollWidth;
    ruler.remove();
    const scrollbar = list.offsetWidth - list.clientWidth;
    return Math.ceil((widest + scrollbar + 1) / scale());
  }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };

  function apply() {
    app.classList.toggle("side-hidden", state.collapsed);
    if (state.width == null) app.style.removeProperty("--side-w");
    else app.style.setProperty("--side-w", `calc(${state.width}px * var(--s))`);
  }

  /** Brings the saved width back inside the limits (names, scale or window size may have changed). */
  function refit() {
    if (state.width == null) {
      const min = minWidth();
      if (min > DEFAULT_WIDTH) { state.width = min; apply(); }
      return;
    }
    const next = clampWidth(state.width, minWidth(), window.innerWidth / scale());
    if (next !== state.width) { state.width = next; apply(); save(); }
  }

  const grip = h("div", { class: "side-grip", title: "Drag to resize, double-click to reset" });
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    const min = minWidth();
    const move = (ev: PointerEvent) => {
      state.width = clampWidth(ev.clientX / scale(), min, window.innerWidth / scale());
      apply();
    };
    const done = () => {
      grip.classList.remove("drag");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      grip.removeEventListener("pointercancel", done);
      save();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
  });
  grip.addEventListener("dblclick", () => { state.width = null; apply(); refit(); save(); });
  aside.append(grip);

  window.addEventListener("resize", refit);
  apply();

  return {
    isCollapsed: () => state.collapsed,
    toggle() { state.collapsed = !state.collapsed; apply(); save(); },
    refit,
  };
}
