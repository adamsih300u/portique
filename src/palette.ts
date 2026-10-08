import { h } from "./ui";

export interface PaletteItem {
  id: string;
  title: string;
  /** Dimmed text after the title (a host, a path…). */
  subtitle?: string;
  /** Heading in the unfiltered list; also a small tag when searching. */
  group: string;
  /** Extra words that should match but aren't shown. */
  keywords?: string;
  /** Shortcut shown on the right. */
  hint?: string;
  run: () => void;
}

export interface FindOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** What find mode searches: the focused terminal of the active tab. */
export interface FindTarget {
  find(query: string, opts: FindOptions, dir: "next" | "prev", incremental: boolean): boolean;
  clear(): void;
  /** Called whenever the match count or the active match changes. */
  onResults(cb: (index: number, count: number) => void): void;
}

export interface PaletteHooks {
  items(): PaletteItem[];
  /** The search target, or null when the active tab has nothing to search. */
  findTarget(): FindTarget | null;
}

// ---------------------------------------------------------------- fuzzy matching

interface Match {
  score: number;
  /** Indexes of the matched characters in the title (for highlighting). */
  at: number[];
}

/** Subsequence match with bonuses for word starts and runs; null if `q` isn't in `text`. */
function fuzzy(q: string, text: string): Match | null {
  const t = text.toLowerCase();
  const at: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\s\-_./:@(]/.test(t[i - 1]);
    score += 1 + (wordStart ? 8 : 0) + (i === prev + 1 ? 5 : 0) - Math.min(3, i - from) * 0.5;
    at.push(i);
    prev = i;
    from = i + 1;
  }
  // Prefer matches near the start and shorter titles.
  return { score: score - at[0] * 0.2 - text.length * 0.02, at };
}

function rank(items: PaletteItem[], query: string): { item: PaletteItem; at: number[] }[] {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return items.map((item) => ({ item, at: [] }));
  const out: { item: PaletteItem; at: number[]; score: number }[] = [];
  for (const item of items) {
    const m = fuzzy(q.replace(/ /g, ""), item.title);
    if (m) out.push({ item, at: m.at, score: m.score + 20 });
    else {
      // Fall back to the other words: every query word must appear somewhere.
      const hay = `${item.title} ${item.subtitle ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
      if (q.split(" ").every((w) => hay.includes(w))) out.push({ item, at: [], score: 5 });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- recents

const RECENT_KEY = "portique.palette.recent";
const MAX_RECENT = 6;

function recents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recents().filter((x) => x !== id)].slice(0, MAX_RECENT)));
  } catch {} // a convenience only
}

// ---------------------------------------------------------------- the palette

let closeCurrent: ((restoreFocus: boolean) => void) | null = null;
/** The last search, so reopening find mode picks up where it left off. */
const lastFind: { query: string; opts: FindOptions } = { query: "", opts: { regex: false, caseSensitive: false, wholeWord: false } };

export const paletteOpen = () => closeCurrent !== null;
export const closePalette = () => closeCurrent?.(true);

/** Shows the palette. `mode` "find" starts in terminal search when there is something to search. */
export function openPalette(hooks: PaletteHooks, mode: "commands" | "find" = "commands") {
  if (closeCurrent) return closeCurrent(true);
  if (document.querySelector(".overlay")) return; // a dialog (e.g. the vault unlock) is up

  const previous = document.activeElement as HTMLElement | null;
  const target = hooks.findTarget();
  let finding = false;
  let sel = 0;
  let shown: { item: PaletteItem; at: number[] }[] = [];
  let findCount: { index: number; count: number } | null = null;

  const input = h("input", { class: "pal-input", spellcheck: false, autocomplete: "off", "aria-label": "Command palette" });
  const chip = h("span", { class: "pal-mode" });
  const count = h("span", { class: "pal-count" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" });
  const optBtn = (key: keyof FindOptions, label: string, title: string) => {
    const b = h("button", { class: "pal-opt", title, tabindex: -1, onclick: () => { lastFind.opts[key] = !lastFind.opts[key]; sync(); input.focus(); } }, label);
    return b;
  };
  const opts = h("span", { class: "pal-opts" },
    optBtn("caseSensitive", "Aa", "Match case (Alt+C)"), optBtn("wholeWord", "ab", "Whole word (Alt+W)"), optBtn("regex", ".*", "Regular expression (Alt+R)"));
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Command palette" },
    h("div", { class: "pal-row" }, chip, input, count, opts), list, foot);
  const overlay = h("div", { class: "pal-overlay", onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(true); } }, box);

  const close = (restoreFocus: boolean) => {
    if (finding) target?.clear();
    overlay.remove();
    closeCurrent = null;
    if (restoreFocus) previous?.focus?.();
  };
  closeCurrent = close;

  // -------- commands mode

  function items(): PaletteItem[] {
    const base = hooks.items();
    if (target) base.unshift({ id: "find", title: "Find in terminal…", group: "Terminal", hint: "Ctrl+Shift+F", keywords: "search scrollback", run: () => {} });
    return base;
  }

  function renderCommands() {
    const all = items();
    const q = input.value;
    if (!q.trim()) {
      const rec = recents().map((id) => all.find((i) => i.id === id)).filter((i): i is PaletteItem => !!i);
      const rest = all.filter((i) => !rec.includes(i));
      shown = [...rec.map((item) => ({ item, at: [] as number[], recent: true })), ...rest.map((item) => ({ item, at: [] as number[], recent: false }))];
    } else shown = rank(all, q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const rows: HTMLElement[] = [];
    let heading = "";
    shown.forEach((m, i) => {
      if (!q.trim()) {
        const g = (m as { recent?: boolean }).recent ? "Recent" : m.item.group;
        if (g !== heading) rows.push(h("div", { class: "pal-group" }, (heading = g)));
      }
      rows.push(row(m, i, !!q.trim()));
    });
    if (!shown.length) rows.push(h("div", { class: "pal-empty" }, "Nothing matches"));
    list.replaceChildren(...rows);
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }

  function row(m: { item: PaletteItem; at: number[] }, i: number, tag: boolean): HTMLElement {
    const t = m.item.title;
    const title = h("span", { class: "pal-title" });
    const at = new Set(m.at);
    for (let k = 0; k < t.length; ) {
      const hit = at.has(k);
      let e = k;
      while (e < t.length && at.has(e) === hit) e++;
      title.append(hit ? h("mark", {}, t.slice(k, e)) : t.slice(k, e));
      k = e;
    }
    return h("div", { class: "pal-item" + (i === sel ? " on" : ""), role: "option",
      onmousemove: () => { if (sel !== i) { sel = i; list.querySelectorAll(".pal-item").forEach((r, j) => r.classList.toggle("on", j === i)); } },
      onclick: () => run(m.item) },
      title, m.item.subtitle ? h("span", { class: "pal-sub" }, m.item.subtitle) : null,
      h("span", { class: "pal-fill" }),
      tag ? h("span", { class: "pal-tag" }, m.item.group) : null,
      m.item.hint ? h("kbd", {}, m.item.hint) : null);
  }

  function run(item: PaletteItem) {
    if (item.id === "find") return startFind();
    remember(item.id);
    close(false);
    item.run();
  }

  // -------- find mode

  function startFind() {
    if (!target) return;
    finding = true;
    findCount = null;
    input.value = lastFind.query;
    target.onResults((index, n) => { findCount = { index, count: n }; sync(); });
    sync();
    input.focus();
    input.select();
    if (lastFind.query) doFind("next", true);
  }

  function leaveFind() {
    target?.clear();
    finding = false;
    input.value = "";
    sel = 0;
    sync();
    input.focus();
  }

  function doFind(dir: "next" | "prev", incremental = false) {
    if (!target) return;
    lastFind.query = input.value;
    const found = target.find(input.value, lastFind.opts, dir, incremental);
    if (!input.value) findCount = null;
    else if (!found && !findCount) findCount = { index: -1, count: 0 };
    sync();
  }

  // -------- shared

  function sync() {
    box.classList.toggle("finding", finding);
    chip.textContent = finding ? "Find" : "";
    chip.style.display = finding ? "" : "none";
    opts.style.display = finding ? "" : "none";
    count.style.display = finding ? "" : "none";
    input.placeholder = finding ? "Find in this terminal's scrollback…" : "Type a command, host or tab…";
    list.style.display = finding ? "none" : "";
    for (const [i, key] of (["caseSensitive", "wholeWord", "regex"] as const).entries()) opts.children[i].classList.toggle("on", lastFind.opts[key]);
    if (finding) {
      const c = findCount;
      count.textContent = !input.value ? "" : !c || c.count === 0 ? "No results" : c.index < 0 ? `${c.count >= 1000 ? "1000+" : c.count} matches` : `${c.index + 1} of ${c.count >= 1000 ? "1000+" : c.count}`;
      count.classList.toggle("none", !!input.value && (!c || c.count === 0));
      foot.replaceChildren(h("span", {}, h("kbd", {}, "Enter"), " next  ", h("kbd", {}, "Shift+Enter"), " previous  ", h("kbd", {}, "Esc"), " close — the match stays selected for copying"));
    } else {
      renderCommands();
      foot.replaceChildren(h("span", {}, h("kbd", {}, "↑↓"), " choose  ", h("kbd", {}, "Enter"), " run  ", h("kbd", {}, "Esc"), " close"),
        target ? h("span", {}, "Type ", h("kbd", {}, "/"), " to search the terminal") : h("span", {}));
    }
  }

  input.addEventListener("input", () => {
    if (finding) return doFind("next", true);
    if (input.value === "/" && target) { input.value = ""; return startFind(); }
    sel = 0;
    renderCommands();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the window's shortcuts must not see keys typed here
    const key = e.key;
    if (key === "Escape") return e.preventDefault(), close(true);
    if (e.ctrlKey && e.shiftKey && e.code === "KeyP") return e.preventDefault(), close(true);
    if (e.ctrlKey && e.shiftKey && e.code === "KeyF") {
      e.preventDefault();
      if (!finding && target) startFind();
      return;
    }
    if (finding) {
      if (key === "Enter") { e.preventDefault(); doFind(e.shiftKey ? "prev" : "next"); }
      else if (key === "F3") { e.preventDefault(); doFind(e.shiftKey ? "prev" : "next"); }
      else if (key === "Backspace" && !input.value) { e.preventDefault(); leaveFind(); }
      else if (e.altKey && (e.code === "KeyC" || e.code === "KeyW" || e.code === "KeyR")) {
        e.preventDefault();
        const k = e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : "regex";
        lastFind.opts[k] = !lastFind.opts[k];
        sync();
        doFind("next", true);
      }
      return;
    }
    if (key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); renderCommands(); }
    else if (key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); renderCommands(); }
    else if (key === "Enter") { e.preventDefault(); const m = shown[sel]; if (m) run(m.item); }
  });

  document.body.append(overlay);
  if (mode === "find" && target) startFind();
  else sync();
  input.focus();
}
