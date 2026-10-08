import { h } from "./ui";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  /** Right-aligned shortcut hint. */
  hint?: string;
  /** Draws a check mark: for on/off settings. */
  checked?: boolean;
}

/** A menu is a list of items; a `null` entry draws a separator. */
export type MenuEntries = (MenuItem | null)[];

let close: (() => void) | null = null;

/** Pops a context menu at the pointer. Only one is open at a time. */
export function contextMenu(x: number, y: number, entries: MenuEntries, onClose?: () => void) {
  close?.();
  const items = entries.filter((e, i, a) => e || (i > 0 && i < a.length - 1 && a[i - 1])); // no leading/trailing/double separators
  const buttons: HTMLButtonElement[] = [];
  const el = h("div", { class: "menu", role: "menu" },
    ...items.map((it) => {
      if (!it) return h("div", { class: "menu-sep" });
      const b = h("button", { class: "menu-item" + (it.danger ? " danger" : ""), role: "menuitem",
        onclick: () => { dismiss(); it.action(); } },
        it.checked !== undefined ? h("span", { class: "menu-check" }, it.checked ? "✓" : "") : null,
        h("span", { class: "menu-label" }, it.label), it.hint ? h("kbd", {}, it.hint) : null);
      buttons.push(b);
      return b;
    }));

  const dismiss = () => {
    el.remove();
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("wheel", dismiss, true);
    close = null;
    onClose?.();
  };
  const outside = (e: Event) => { if (!el.contains(e.target as Node)) dismiss(); };
  const key = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") dismiss();
    else if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[i < 0 ? buttons.length - 1 : (i - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  close = dismiss;
  document.body.append(el);
  // Keep the menu inside the window.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  window.addEventListener("pointerdown", outside, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("wheel", dismiss, true);
}

/** Handy for `oncontextmenu`: suppresses the native menu and opens ours at the pointer. */
export function menuOn(e: MouseEvent, entries: MenuEntries, onClose?: () => void) {
  e.preventDefault();
  e.stopPropagation();
  contextMenu(e.clientX, e.clientY, entries, onClose);
}
