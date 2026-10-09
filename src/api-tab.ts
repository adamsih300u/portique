import type { Profile } from "./api";
import { environmentsDialog } from "./http-env";
import { HttpRequest, toCurl } from "./http-model";
import { EditorHost, RequestEditor, requestLabel } from "./http-request";
import { httpStore } from "./http-store";
import { exportRequests, importRequests } from "./http-transfer";
import { contextMenu, MenuEntries, menuOn } from "./menu";
import { h, promptText } from "./ui";

const SHORT: Record<string, string> = { GET: "GET", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DEL", HEAD: "HEAD", OPTIONS: "OPT" };
const RAIL_KEY = "portique.api.rail";

/** localStorage for small per-viewer conveniences; failures (private windows, blocked storage) are ignored. */
const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, v: string) { try { localStorage.setItem(key, v); } catch {} },
};

interface Row {
  id: string;
  name: string;
  method: string;
  group: string;
  unsaved: boolean;
  dirty: boolean;
}

/**
 * An API connection, open as a tab: the saved requests of that endpoint down the left,
 * and the request being worked on (with its response) on the right.
 */
export class ApiTab {
  readonly el = h("div", { class: "apitab" });
  readonly header: HTMLElement;
  readonly closeBtn = h("button", { class: "mini", title: "Close tab" }, "✕");
  private readonly label = h("span", { class: "tlabel" });
  private readonly dirtyDot = h("span", { class: "api-dirty", title: "Unsaved changes" }, "•");

  profile: Profile;
  private readonly conn: ReturnType<typeof httpStore.forConn>;
  /** Every request opened in this tab, saved or not, with its own response and unsaved edits. */
  private readonly editors = new Map<string, RequestEditor>();
  private current: RequestEditor | null = null;
  private filter = "";
  private readonly folded: Set<string>;
  private readonly list = h("div", { class: "rail-list" });
  private readonly search = h("input", { class: "rail-search", placeholder: "Filter requests…", spellcheck: false, autocomplete: "off" });
  private readonly stage = h("div", { class: "api-stage" });
  private readonly host: EditorHost;
  private paint = 0;
  disposed = false;

  constructor(profile: Profile, private readonly opts: { editConnection: (p: Profile) => void }) {
    this.profile = profile;
    this.conn = httpStore.forConn(profile.id);
    this.folded = new Set((store.get(`${RAIL_KEY}.folded.${profile.id}`) ?? "").split("\n").filter(Boolean));
    this.host = {
      store: this.conn,
      settings: () => this.profile.api,
      connName: () => this.profile.name,
      onState: () => this.stateChanged(),
      editConnection: () => this.opts.editConnection(this.profile),
    };

    this.header = h("div", { class: "tab apitab-header" }, this.label, h("span", { class: "tbadge" }, h("span", { title: "API connection" }, "API")), this.dirtyDot, this.closeBtn);
    this.header.style.setProperty("--tab-bg", "var(--bg)");
    this.label.textContent = profile.name;

    const newBtn = h("button", { class: "primary rail-new", title: "New request (Ctrl+Shift+A)", onclick: () => this.newRequest() }, "+ New");
    const more = h("button", { class: "icon rail-more", title: "Import, export, environments, settings", onclick: () => {
      const r = more.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 2, this.connectionMenu());
    } }, "⋯");
    const rail = h("div", { class: "api-rail" },
      h("div", { class: "rail-head" }, h("span", { class: "rail-title" }, "Requests"), newBtn, more),
      h("div", { class: "rail-searchbox" }, this.search),
      this.list);
    const w = Number(store.get(RAIL_KEY));
    if (w >= 160 && w <= 520) this.el.style.setProperty("--rail", `${w}px`);
    const gutter = h("div", { class: "gutter api-rail-gutter", title: "Drag to resize" });
    gutter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add("drag");
      const left = this.el.getBoundingClientRect().left;
      const mv = (ev: PointerEvent) => this.el.style.setProperty("--rail", `${Math.min(520, Math.max(160, ev.clientX - left))}px`);
      const up = () => {
        gutter.classList.remove("drag");
        gutter.removeEventListener("pointermove", mv);
        gutter.removeEventListener("pointerup", up);
        store.set(RAIL_KEY, String(Math.round(rail.getBoundingClientRect().width)));
      };
      gutter.addEventListener("pointermove", mv);
      gutter.addEventListener("pointerup", up);
    });
    this.el.append(rail, gutter, this.stage);

    this.search.addEventListener("input", () => { this.filter = this.search.value.trim().toLowerCase(); this.renderRail(); });
    // Right-clicking blank space in the list offers what you can add to the connection (rows have their own menus).
    this.list.addEventListener("contextmenu", (e) => menuOn(e, this.connectionMenu()));
    this.conn.listeners.add(this.onStore);

    // Start on the request used last time, or the first one, or a fresh one to type into.
    const saved = this.conn.data.requests;
    const last = store.get(`${RAIL_KEY}.last.${profile.id}`);
    const first = saved.find((r) => r.id === last) ?? saved[0];
    if (first) this.select(first.id);
    else this.newRequest();
  }

  // ------------------------------------------------------------ the rail

  private readonly onStore = () => this.renderRail();

  /** Redraws the list soon, once, however many changes come at it (typing changes the request on every key). */
  private stateChanged() {
    if (this.disposed) return;
    this.dirtyDot.style.display = this.dirty ? "" : "none";
    if (this.paint) return;
    this.paint = requestAnimationFrame(() => { this.paint = 0; this.renderRail(); });
  }

  private rows(): Row[] {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const r of this.conn.data.requests) {
      seen.add(r.id);
      const e = this.editors.get(r.id);
      out.push({ id: r.id, name: r.name, method: (e?.req.method ?? r.method), group: r.group, unsaved: false, dirty: !!e?.dirty });
    }
    for (const [id, e] of this.editors) if (!seen.has(id)) out.push({ id, name: requestLabel(e.req), method: e.req.method, group: "", unsaved: true, dirty: true });
    return out;
  }

  private renderRail() {
    const q = this.filter;
    const rows = this.rows().filter((r) => !q || `${r.name} ${r.group} ${r.method}`.toLowerCase().includes(q));
    const groups = new Map<string, Row[]>();
    for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    const order = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    const out: HTMLElement[] = [];
    for (const g of order) {
      const items = (groups.get(g) ?? []).sort((a, b) => Number(b.unsaved) - Number(a.unsaved) || a.name.localeCompare(b.name));
      const closed = g !== "" && this.folded.has(g) && !q;
      if (g !== "") {
        out.push(h("div", { class: "rail-folder", title: closed ? "Show" : "Hide", onclick: () => this.fold(g) },
          h("span", { class: "rail-caret" }, closed ? "▸" : "▾"), g, h("span", { class: "rail-count" }, String(items.length))));
      }
      if (!closed) out.push(...items.map((r) => this.rowEl(r, g !== "")));
    }
    if (!out.length) {
      out.push(h("div", { class: "rail-empty" }, q ? "No requests match." : "No saved requests yet.",
        q ? null : h("small", {}, "Type an address on the right and press Ctrl+S to save it here.")));
    }
    this.list.replaceChildren(...out);
  }

  private rowEl(r: Row, indent: boolean): HTMLElement {
    const el = h("div", { class: "rail-row" + (r.id === this.current?.req.id ? " on" : "") + (indent ? " in" : "") + (r.unsaved ? " draft" : ""), title: r.name,
      onclick: () => this.select(r.id),
      oncontextmenu: (e: MouseEvent) => {
        el.classList.add("ctx");
        menuOn(e, this.rowMenu(r), () => el.classList.remove("ctx"));
      } },
      h("span", { class: `rail-m m-${r.method}` }, SHORT[r.method] ?? r.method),
      h("span", { class: "rail-name" }, r.name),
      r.dirty && !r.unsaved ? h("span", { class: "api-dirty", title: "Unsaved changes" }, "•") : null);
    return el;
  }

  private fold(group: string) {
    if (!this.folded.delete(group)) this.folded.add(group);
    store.set(`${RAIL_KEY}.folded.${this.profile.id}`, [...this.folded].join("\n"));
    this.renderRail();
  }

  private rowMenu(r: Row): MenuEntries {
    const e = this.editors.get(r.id);
    if (r.unsaved) {
      return [
        { label: "Save…", hint: "Ctrl+S", action: () => { this.select(r.id); void e?.save(); } },
        null,
        { label: "Discard", danger: true, action: () => this.discard(r.id) },
      ];
    }
    const saved = this.conn.request(r.id);
    if (!saved) return [];
    return [
      { label: "Rename…", action: () => void this.rename(saved) },
      { label: "Move to folder…", action: () => void this.move(saved) },
      { label: "Duplicate", action: () => void this.conn.duplicateRequest(r.id).then((c) => c && this.select(c.id)) },
      { label: "Copy as cURL", action: () => void navigator.clipboard.writeText(toCurl(e?.req ?? saved, this.profile.api)) },
      null,
      { label: "Delete…", danger: true, action: () => void this.remove(saved) },
    ];
  }

  private connectionMenu(): MenuEntries {
    return [
      { label: "New request", hint: "Ctrl+Shift+A", action: () => this.newRequest() },
      null,
      { label: "Import requests…", action: () => void importRequests(this.conn) },
      { label: "Export requests…", action: () => void exportRequests(this.conn) },
      null,
      { label: "Environments…", action: () => void environmentsDialog(this.conn, this.conn.data.activeEnv) },
      { label: "Connection settings…", action: () => this.opts.editConnection(this.profile) },
    ];
  }

  // ------------------------------------------------------------ requests

  /** Starts a new, empty request and puts the cursor in its address. */
  newRequest() {
    const e = new RequestEditor(this.host);
    this.attach(e);
    this.showEditor(e);
    e.focusIfEmpty();
  }

  /** Shows a saved request, opening it first if it isn't yet. Unsaved edits to it are kept while it is open. */
  select(id: string) {
    let e = this.editors.get(id);
    if (!e) {
      const saved = this.conn.request(id);
      if (!saved) return;
      e = new RequestEditor(this.host, saved);
      this.attach(e);
    }
    this.showEditor(e);
  }

  /** True if this tab has the request open (so the app can bring it forward instead of opening it twice). */
  has(id: string): boolean {
    return this.editors.has(id);
  }

  private attach(e: RequestEditor) {
    this.editors.set(e.req.id, e);
    this.stage.append(e.el);
  }

  private showEditor(e: RequestEditor) {
    this.current = e;
    for (const x of this.editors.values()) x.el.style.display = x === e ? "" : "none";
    store.set(`${RAIL_KEY}.last.${this.profile.id}`, e.req.id);
    this.renderRail();
    this.dirtyDot.style.display = this.dirty ? "" : "none";
    this.list.querySelector(".rail-row.on")?.scrollIntoView?.({ block: "nearest" });
  }

  private discard(id: string) {
    const e = this.editors.get(id);
    if (!e) return;
    this.editors.delete(id);
    e.dispose();
    if (this.current === e) this.fallback();
    else this.renderRail();
  }

  /** After the shown request goes away: show another, or a fresh one. */
  private fallback() {
    this.current = null;
    const next = [...this.editors.values()][0] ?? null;
    if (next) this.showEditor(next);
    else this.newRequest();
  }

  private async rename(r: HttpRequest) {
    const name = await promptText("Rename request", "Name", r.name);
    if (name) await this.conn.saveRequest({ ...r, name });
  }

  private async move(r: HttpRequest) {
    const folder = await promptText("Move request", "Folder (leave empty for none)", r.group);
    if (folder !== null) await this.conn.saveRequest({ ...r, group: folder });
    else if (r.group) await this.conn.saveRequest({ ...r, group: "" }); // emptied the box: take it out of its folder
  }

  private async remove(r: HttpRequest) {
    if (!confirm(`Delete request "${r.name}"?`)) return;
    await this.conn.deleteRequest(r.id);
    const e = this.editors.get(r.id);
    if (e) {
      this.editors.delete(r.id);
      e.dispose();
      if (this.current === e) this.fallback();
    }
    this.renderRail();
  }

  /** The tab's own menu (also the rail's ⋯ menu). */
  menuEntries(): MenuEntries {
    return this.connectionMenu();
  }

  importFile() {
    return importRequests(this.conn);
  }

  exportFile() {
    return exportRequests(this.conn);
  }

  manageEnvironments() {
    void environmentsDialog(this.conn, this.conn.data.activeEnv);
  }

  editSettings() {
    this.opts.editConnection(this.profile);
  }

  /** The request being worked on. */
  get active(): RequestEditor | null {
    return this.current;
  }

  get dirty(): boolean {
    return [...this.editors.values()].some((e) => e.dirty);
  }

  // ------------------------------------------------------------ Tab-like surface used by the app shell

  show(on: boolean) {
    this.el.style.display = on ? "" : "none";
    this.header.classList.toggle("active", on);
    this.header.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (on) this.current?.focusIfEmpty();
  }

  refit() {}
  setGpu(_on: boolean) {}
  usesProfile(id: string) {
    return this.profile.id === id;
  }

  /** The connection was edited: take the new settings and name. */
  applyProfile(p: Profile) {
    if (p.id !== this.profile.id) return;
    this.profile = p;
    this.label.textContent = p.name;
    for (const e of this.editors.values()) e.applyConnection();
  }

  get title(): string {
    return this.profile.name;
  }

  /** Called when the tab is closing; false if the user chose to keep it open. */
  confirmClose(): boolean {
    const n = [...this.editors.values()].filter((e) => e.dirty).length;
    return n === 0 || confirm(`${n === 1 ? "A request has" : `${n} requests have`} changes that aren't saved. Close this tab anyway?`);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.paint);
    this.conn.listeners.delete(this.onStore);
    for (const e of this.editors.values()) e.dispose();
    this.editors.clear();
    this.el.remove();
    this.header.remove();
  }
}
