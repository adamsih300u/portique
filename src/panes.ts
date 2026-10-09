import { type Profile } from "./api";
import { type TabState, TerminalTab } from "./terminal-tab";
import { ensureFont, getTheme } from "./themes";
import { h } from "./ui";

/** "row": panes side by side (split right). "col": panes stacked (split down). */
export type Dir = "row" | "col";
export type Arrow = "left" | "right" | "up" | "down";

/** Serialisable pane tree: a profile id, or two children and how they divide the space. */
export type Layout = ({ p: string } | { d: Dir; r: number; a: Layout; b: Layout }) & {
  /** Custom tab name; only ever set on a tab's root node. */
  n?: string;
};

class Leaf {
  readonly el = h("div", { class: "pane" });
  parent: Split | null = null;
  constructor(readonly term: TerminalTab) {}
}

class Split {
  readonly el: HTMLElement;
  parent: Split | null = null;
  constructor(readonly dir: Dir, public ratio: number, public a: Node, public b: Node) {
    this.el = h("div", { class: `split ${dir}` });
  }
}

type Node = Leaf | Split;

const leavesOf = (n: Node): Leaf[] => (n instanceof Leaf ? [n] : [...leavesOf(n.a), ...leavesOf(n.b)]);
const MIN_RATIO = 0.1;
const STATE_TIPS: Record<TabState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Connection lost, reconnecting…",
  disconnected: "Disconnected",
};

/** One tab: a tree of terminal panes plus the tab-bar header that represents it. */
export class Tab {
  readonly el = h("div", { class: "tabview" });
  readonly header: HTMLElement;
  private readonly status = h("span", { class: "status connecting" });
  private readonly label = h("span", { class: "tlabel" });
  private readonly extra = h("span", { class: "tbadge" });
  readonly closeBtn = h("button", { class: "mini", title: "Close tab" }, "✕");
  private root!: Node;
  private focusedLeaf!: Leaf;
  /** Layout, focus or session state changed (used for persistence). */
  onChange: () => void = () => {};
  /** The focused pane (and so possibly the tab's name) changed. */
  onRetitle: () => void = () => {};
  /** Name chosen by the user; null means "use the profile name". */
  customName: string | null = null;
  /** 1-based position among open tabs of the same profile, or 0 when it is the only one. */
  private ordinal = 0;
  /** Shift+right-click inside a pane. */
  onPaneMenu: (e: MouseEvent) => void = () => {};

  private constructor() {
    this.header = h("div", { class: "tab" }, this.status, this.label, this.extra, this.closeBtn);
  }

  /** Builds a tab from a layout; profiles that no longer exist are dropped. Null if none survive. */
  static create(layout: Layout, find: (id: string) => Profile | undefined): Tab | null {
    const tab = new Tab();
    tab.customName = typeof layout.n === "string" && layout.n.trim() ? layout.n.trim() : null;
    const root = tab.build(layout, find);
    if (!root) return null;
    tab.root = root;
    tab.focusedLeaf = leavesOf(root)[0];
    tab.focusedLeaf.el.classList.add("focused");
    tab.el.append(root.el);
    tab.render();
    return tab;
  }

  get focused(): TerminalTab {
    return this.focusedLeaf.term;
  }
  /** Name shown in the tab bar and the command palette. */
  get title(): string {
    return this.customName ?? (this.ordinal ? `${this.focused.profile.name} ${this.ordinal}` : this.focused.profile.name);
  }
  setOrdinal(n: number) {
    if (n === this.ordinal) return;
    this.ordinal = n;
    this.render();
  }
  rename(name: string | null) {
    this.customName = name;
    this.render();
    this.onChange();
  }
  get paneCount(): number {
    return leavesOf(this.root).length;
  }

  // ------------------------------------------------------------ building

  private build(l: Layout, find: (id: string) => Profile | undefined): Node | null {
    if ("p" in l) {
      const p = find(l.p);
      return p ? this.makeLeaf(p) : null;
    }
    const a = this.build(l.a, find);
    const b = this.build(l.b, find);
    if (!a || !b) return a ?? b;
    const sp = new Split(l.d === "col" ? "col" : "row", Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, Number(l.r) || 0.5)), a, b);
    a.parent = b.parent = sp;
    sp.el.append(a.el, this.gutter(sp), b.el);
    this.applyRatio(sp);
    return sp;
  }

  private makeLeaf(p: Profile): Leaf {
    const term = new TerminalTab(p);
    const leaf = new Leaf(term);
    term.onState = () => this.render();
    term.onTunnels = () => this.render();
    term.onFocus = () => this.focus(leaf, false);
    term.onMenu = (e) => {
      this.focus(leaf);
      this.onPaneMenu(e);
    };
    void ensureFont(p.appearance.fontFamily, p.appearance.fontSize).then(() => {
      if (term.disposed) return; // closed while the font loaded
      term.mount(leaf.el);
      return term.connect();
    });
    return leaf;
  }

  private gutter(sp: Split): HTMLElement {
    const g = h("div", { class: "gutter", title: "Drag to resize, double-click to even out" });
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add("drag");
      const box = sp.el.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const r = sp.dir === "row" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
        sp.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
        this.applyRatio(sp);
      };
      const up = () => {
        g.classList.remove("drag");
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        this.onChange();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
    });
    g.addEventListener("dblclick", () => {
      sp.ratio = 0.5;
      this.applyRatio(sp);
      this.onChange();
    });
    return g;
  }

  private applyRatio(sp: Split) {
    sp.a.el.style.flex = `${sp.ratio} 1 0`;
    sp.b.el.style.flex = `${1 - sp.ratio} 1 0`;
  }

  // ------------------------------------------------------------ operations

  /** Splits the focused pane and opens `p` in the new half, which takes focus. */
  split(dir: Dir, p: Profile = this.focused.profile) {
    const target = this.focusedLeaf;
    const fresh = this.makeLeaf(p);
    const sp = new Split(dir, 0.5, target, fresh);
    sp.el.style.flex = target.el.style.flex;
    target.el.replaceWith(sp.el);
    sp.el.append(target.el, this.gutter(sp), fresh.el);
    this.replaceChild(target.parent, target, sp);
    target.parent = fresh.parent = sp;
    this.applyRatio(sp);
    this.focus(fresh);
    this.onChange();
  }

  /** Closes a pane. Returns true if it was the last one, i.e. the whole tab should go. */
  closeFocused(): boolean {
    const leaf = this.focusedLeaf;
    const sp = leaf.parent;
    if (!sp) return true;
    const sib = sp.a === leaf ? sp.b : sp.a;
    sib.el.style.flex = sp.el.style.flex;
    sp.el.replaceWith(sib.el);
    this.replaceChild(sp.parent, sp, sib);
    leaf.term.dispose();
    leaf.el.remove();
    this.focusedLeaf = leavesOf(sib)[0];
    this.focus(this.focusedLeaf);
    // Re-parenting can leave xterm's viewport stale; refit once the layout settles.
    requestAnimationFrame(() => this.refit());
    this.onChange();
    return false;
  }

  private replaceChild(parent: Split | null, old: Node, nu: Node) {
    nu.parent = parent;
    if (!parent) this.root = nu;
    else if (parent.a === old) parent.a = nu;
    else parent.b = nu;
  }

  focus(leaf: Leaf, grab = true) {
    this.focusedLeaf = leaf;
    for (const l of leavesOf(this.root)) l.el.classList.toggle("focused", l === leaf);
    if (grab) leaf.term.focus();
    this.render();
    this.onRetitle();
  }

  /** Moves focus to the neighbouring pane in a direction (by on-screen geometry). */
  moveFocus(dir: Arrow) {
    const c = this.focusedLeaf.el.getBoundingClientRect();
    const horiz = dir === "left" || dir === "right";
    const sign = dir === "left" || dir === "up" ? -1 : 1;
    let best: Leaf | null = null;
    let bestDist = Infinity;
    for (const l of leavesOf(this.root)) {
      if (l === this.focusedLeaf) continue;
      const r = l.el.getBoundingClientRect();
      const overlaps = horiz ? r.top < c.bottom && r.bottom > c.top : r.left < c.right && r.right > c.left;
      const dist = horiz ? (r.left + r.right - c.left - c.right) / 2 * sign : (r.top + r.bottom - c.top - c.bottom) / 2 * sign;
      if (overlaps && dist > 0 && dist < bestDist) [best, bestDist] = [l, dist];
    }
    if (best) this.focus(best);
  }

  layout(): Layout {
    const walk = (n: Node): Layout =>
      n instanceof Leaf ? { p: n.term.profile.id } : { d: n.dir, r: Math.round(n.ratio * 1000) / 1000, a: walk(n.a), b: walk(n.b) };
    const out = walk(this.root);
    if (this.customName) out.n = this.customName;
    return out;
  }

  /** Re-apply a profile after it was edited, in every pane that uses it. */
  applyProfile(p: Profile) {
    for (const l of leavesOf(this.root)) if (l.term.profile.id === p.id) l.term.applyProfile(p);
    this.render();
  }

  usesProfile(id: string) {
    return leavesOf(this.root).some((l) => l.term.profile.id === id);
  }

  show(on: boolean) {
    this.el.style.display = on ? "" : "none";
    this.header.classList.toggle("active", on);
    this.header.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (on) {
      this.refit();
      this.focusedLeaf.term.focus();
    }
  }

  refit() {
    for (const l of leavesOf(this.root)) l.term.refit();
  }

  setGpu(on: boolean) {
    for (const l of leavesOf(this.root)) l.term.setGpu(on);
  }

  dispose() {
    for (const l of leavesOf(this.root)) l.term.dispose();
    this.el.remove();
    this.header.remove();
  }

  // ------------------------------------------------------------ header

  /** Updates the tab header from the focused pane (and tunnel info from all panes). */
  private render() {
    const t = this.focusedLeaf.term;
    const th = getTheme(t.profile.appearance.themeId);
    this.header.style.setProperty("--tab-bg", th.background);
    this.header.style.setProperty("--tab-accent", th.ansi[4]);
    this.status.className = `status ${t.state}`;
    this.status.title = STATE_TIPS[t.state];
    this.label.textContent = this.title;
    this.header.title = this.customName ? `${t.profile.name} (renamed)` : "";
    const n = this.paneCount;
    const tunnels = leavesOf(this.root).flatMap((l) => l.term.tunnels);
    this.extra.replaceChildren(
      ...(n > 1 ? [h("span", { title: `${n} panes` }, `⊞${n}`)] : []),
      ...(tunnels.length
        ? [h("span", { class: tunnels.some((x) => x.error) ? "warn" : "", title: tunnels.map((x) => `${x.error ? "✕" : "✓"} ${x.label}${x.error ? ` (${x.error})` : ""}`).join("\n") }, `⇄${tunnels.length}`)]
        : []),
    );
    this.el.classList.toggle("multi", n > 1);
  }
}
