import { api, Channel, type FileEntry, type Listing, type Profile, type TransferItem } from "./api";
import { askLoginSecret, confirmHostKey } from "./host-prompts";
import { type MenuEntries, menuOn } from "./menu";
import { h, modal, promptText } from "./ui";
import { protoIcon } from "./proto-icon";
import { ensureUnlocked } from "./vault-ui";

type Side = "local" | "remote";
type FileState = "connecting" | "connected" | "disconnected";

const DRIVES = "@drives";
/** Where the local pane was last time (a per-viewer convenience, so storage failures are ignored). */
const LAST_LOCAL = "portique.sftp.local";

// ---------------------------------------------------------------- formatting

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDate(sec: number | null): string {
  if (sec === null) return "";
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ICONS = {
  dir: '<path d="M1.5 4.5V12a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z"/>',
  file: '<path d="M4 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"/><path d="M9 1.5V5h3.5"/>',
  link: '<path d="M6 10 10 6M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
};
function icon(kind: keyof typeof ICONS, cls = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("class", `fm-icon ${cls}`);
  el.innerHTML = ICONS[kind]; // static literals above, never user data
  return el;
}

const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

// ---------------------------------------------------------------- one pane

interface PaneDeps {
  list(path: string): Promise<Listing>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Copy these entries of `from` to the other side (into `destDir` if given, else its current folder). */
  send(from: FilePane, names: string[], destDir?: string): void;
}

/** What is being dragged between the panes. */
let dragging: { pane: FilePane; names: string[] } | null = null;

class FilePane {
  readonly el: HTMLElement;
  path = "";
  parent: string | null = null;
  entries: FileEntry[] = [];
  private selected = new Set<string>();
  private anchor: string | null = null;
  private sortKey: "name" | "size" | "mtime" = "name";
  private sortDir: 1 | -1 = 1;
  private hidden = false;
  /** The local side is always usable; the remote side waits for the connection. */
  private enabled: boolean;
  private readonly pathInput = h("input", { class: "fm-path", spellcheck: false, autocomplete: "off", "aria-label": "Folder" });
  private readonly upBtn = h("button", { class: "mini", title: "Parent folder (Backspace)", onclick: () => this.up() }, "↑");
  private readonly head = h("div", { class: "fm-cols" });
  private readonly list = h("div", { class: "fm-list", tabindex: 0 });
  private readonly status = h("div", { class: "fm-status" });
  private readonly note = h("div", { class: "fm-note" });
  private readonly titleEl = h("span", { class: "fm-title" });

  constructor(readonly side: Side, title: string, private deps: PaneDeps) {
    this.titleEl.textContent = title;
    this.enabled = side === "local";
    this.note.style.display = "none";
    this.el = h("div", { class: `fm-pane ${side}` },
      h("div", { class: "fm-head" }, this.titleEl, this.pathInput, this.upBtn),
      h("div", { class: "fm-body" }, this.head, this.list, this.note),
      this.status);
    this.pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.go(this.pathInput.value.trim());
      else if (e.key === "Escape") { this.pathInput.value = this.shownPath(); this.list.focus(); }
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("contextmenu", (e) => menuOn(e, this.menu(false)));
    this.list.addEventListener("pointerdown", (e) => { if (e.target === this.list) this.select([]); });
    this.wireDrop(this.list, () => this.path);
    this.renderHead();
  }

  // -------- paths

  join(dir: string, name: string): string {
    if (this.side === "remote") return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
    if (dir === DRIVES) return name;
    const sep = dir.includes("\\") ? "\\" : "/";
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
  }

  private shownPath() {
    return this.path === DRIVES ? "Computer" : this.path;
  }

  /** Enables the pane (the remote side is greyed until connected) or shows a message in its place. */
  setAvailable(on: boolean, message = "", actions: HTMLElement[] = []) {
    this.enabled = on;
    this.el.classList.toggle("off", !on);
    this.note.replaceChildren(...(message ? [h("div", {}, message), ...actions] : []));
    this.note.style.display = on ? "none" : "";
    if (!on) this.status.textContent = "";
  }

  async go(path: string): Promise<boolean> {
    this.el.classList.add("loading");
    try {
      const l = await this.deps.list(path);
      this.path = l.path;
      this.parent = l.parent;
      this.entries = l.entries;
      this.selected = new Set([...this.selected].filter((n) => l.entries.some((e) => e.name === n)));
      this.pathInput.value = this.shownPath();
      this.upBtn.disabled = this.parent === null;
      this.render();
      if (this.side === "local" && l.path !== DRIVES) try { localStorage.setItem(LAST_LOCAL, l.path); } catch {}
      return true;
    } catch (e) {
      this.pathInput.value = this.shownPath();
      this.status.replaceChildren(h("span", { class: "err" }, String(e)));
      return false;
    } finally {
      this.el.classList.remove("loading");
    }
  }

  refresh() {
    return this.path || this.side === "remote" ? this.go(this.path) : Promise.resolve(false);
  }

  up() {
    if (this.parent !== null) void this.go(this.parent);
  }

  // -------- rendering

  private visible(): FileEntry[] {
    const k = this.sortKey;
    return this.entries
      .filter((e) => this.hidden || !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        const d = k === "name" ? compareNames(a.name, b.name) : k === "size" ? a.size - b.size : (a.mtime ?? 0) - (b.mtime ?? 0);
        return (d || compareNames(a.name, b.name)) * (k === "name" || d ? this.sortDir : 1);
      });
  }

  private renderHead() {
    const col = (key: "name" | "size" | "mtime", label: string) =>
      h("button", { class: "fm-col" + (this.sortKey === key ? " on" : ""), onclick: () => {
        if (this.sortKey === key) this.sortDir = (this.sortDir * -1) as 1 | -1;
        else {
          this.sortKey = key;
          this.sortDir = 1;
        }
        this.renderHead();
        this.render();
      } }, label, this.sortKey === key ? h("span", {}, this.sortDir === 1 ? " ▴" : " ▾") : null);
    this.head.replaceChildren(col("name", "Name"), col("size", "Size"), col("mtime", "Modified"));
  }

  private render() {
    const rows = this.visible();
    this.list.replaceChildren(
      ...(this.parent !== null
        ? [h("div", { class: "fm-row up", ondblclick: () => this.up() }, h("span", { class: "fm-name" }, icon("dir"), ".."), h("span"), h("span"))]
        : []),
      ...rows.map((e) => this.row(e)));
    this.updateStatus(rows);
  }

  private row(e: FileEntry): HTMLElement {
    const r = h("div", { class: "fm-row" + (this.selected.has(e.name) ? " sel" : ""), draggable: true, "data-name": e.name,
      onclick: (ev: MouseEvent) => this.click(e, ev),
      ondblclick: () => this.open(e),
      oncontextmenu: (ev: MouseEvent) => {
        if (!this.selected.has(e.name)) this.select([e.name]);
        menuOn(ev, this.menu(true));
      },
      ondragstart: (ev: DragEvent) => {
        if (!this.selected.has(e.name)) this.select([e.name]);
        dragging = { pane: this, names: [...this.selected] };
        ev.dataTransfer?.setData("text/plain", dragging.names.join("\n"));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      },
      ondragend: () => { dragging = null; },
    },
      h("span", { class: "fm-name", title: e.name }, icon(e.isDir ? "dir" : "file", e.isDir ? "dir" : ""), e.isLink ? icon("link", "lnk") : null, e.name),
      h("span", { class: "fm-size" }, e.isDir ? "" : fmtSize(e.size)),
      h("span", { class: "fm-date" }, fmtDate(e.mtime)));
    if (e.isDir) this.wireDrop(r, () => this.join(this.path, e.name), true);
    return r;
  }

  private updateStatus(rows = this.visible()) {
    const sel = rows.filter((e) => this.selected.has(e.name));
    const bytes = sel.reduce((s, e) => s + (e.isDir ? 0 : e.size), 0);
    this.status.textContent = `${rows.length} item${rows.length === 1 ? "" : "s"}` +
      (sel.length ? ` · ${sel.length} selected${bytes ? ` (${fmtSize(bytes)})` : ""}` : "");
  }

  private wireDrop(el: HTMLElement, dest: () => string, stop = false) {
    el.addEventListener("dragover", (e) => {
      if (!dragging || dragging.pane === this || !this.enabled) return;
      e.preventDefault();
      if (stop) e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      el.classList.add("drop");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop");
      if (!dragging || dragging.pane === this || !this.enabled) return;
      e.preventDefault();
      if (stop) e.stopPropagation();
      const d = dragging;
      dragging = null;
      this.deps.send(d.pane, d.names, dest());
    });
  }

  // -------- selection and actions

  private select(names: string[], anchor?: string) {
    this.selected = new Set(names);
    if (anchor !== undefined) this.anchor = anchor;
    for (const r of this.list.querySelectorAll<HTMLElement>(".fm-row[data-name]")) r.classList.toggle("sel", this.selected.has(r.dataset.name!));
    this.updateStatus();
  }

  private click(e: FileEntry, ev: MouseEvent) {
    this.list.focus();
    const names = this.visible().map((x) => x.name);
    if (ev.shiftKey && this.anchor && names.includes(this.anchor)) {
      const [a, b] = [names.indexOf(this.anchor), names.indexOf(e.name)].sort((x, y) => x - y);
      this.select(names.slice(a, b + 1));
    } else if (ev.ctrlKey || ev.metaKey) {
      const s = new Set(this.selected);
      s.has(e.name) ? s.delete(e.name) : s.add(e.name);
      this.select([...s], e.name);
    } else this.select([e.name], e.name);
  }

  private open(e: FileEntry) {
    if (e.isDir) void this.go(this.join(this.path, e.name));
    else this.deps.send(this, [e.name]);
  }

  selectedNames(): string[] {
    return this.visible().filter((e) => this.selected.has(e.name)).map((e) => e.name);
  }

  private onKey(ev: KeyboardEvent) {
    const rows = this.visible();
    const names = rows.map((r) => r.name);
    const cur = [...this.selected].pop();
    const move = (to: number) => {
      const n = names[Math.max(0, Math.min(names.length - 1, to))];
      if (n === undefined) return;
      if (ev.shiftKey && this.anchor) {
        const [a, b] = [names.indexOf(this.anchor), names.indexOf(n)].sort((x, y) => x - y);
        this.select(names.slice(a, b + 1));
      } else this.select([n], n);
      this.list.querySelector(`.fm-row[data-name="${CSS.escape(n)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const key = ev.key;
    if (key === "ArrowDown") move(cur ? names.indexOf(cur) + 1 : 0);
    else if (key === "ArrowUp") move(cur ? names.indexOf(cur) - 1 : names.length - 1);
    else if (key === "Home") move(0);
    else if (key === "End") move(names.length - 1);
    else if (key === "Backspace" || (ev.altKey && key === "ArrowUp")) this.up();
    else if (key === "Enter") { const e = rows.find((r) => r.name === cur); if (e) this.open(e); }
    else if (key === "Delete") void this.del();
    else if (key === "F2") void this.renameSelected();
    else if (key === "F5") void this.refresh();
    else if (key === "a" && (ev.ctrlKey || ev.metaKey)) this.select(names);
    else if (key === "N" && ev.ctrlKey && ev.shiftKey) void this.newFolder();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  menu(onItem: boolean): MenuEntries {
    const names = this.selectedNames();
    const other = this.side === "local" ? "Upload" : "Download";
    return [
      ...(onItem && names.length ? [
        { label: names.length === 1 && this.entries.find((e) => e.name === names[0])?.isDir ? "Open" : `${other} ${this.side === "local" ? "→" : "←"}`,
          hint: "Enter", action: () => { const e = this.entries.find((x) => x.name === names[0]); e?.isDir && names.length === 1 ? void this.go(this.join(this.path, e.name)) : this.deps.send(this, names); } },
        ...(names.length === 1 && this.entries.find((e) => e.name === names[0])?.isDir ? [{ label: `${other} folder ${this.side === "local" ? "→" : "←"}`, action: () => this.deps.send(this, names) }] : []),
        null,
        { label: "Rename…", hint: "F2", action: () => void this.renameSelected() },
        { label: "Delete…", hint: "Del", danger: true, action: () => void this.del() },
        null,
      ] : []),
      { label: "New folder…", hint: "Ctrl+Shift+N", action: () => void this.newFolder() },
      { label: "Refresh", hint: "F5", action: () => void this.refresh() },
      { label: "Show hidden files", checked: this.hidden, action: () => { this.hidden = !this.hidden; this.render(); } },
      null,
      ...(onItem && names.length === 1 ? [{ label: "Copy path", action: () => void navigator.clipboard.writeText(this.join(this.path, names[0])).catch(() => {}) }] : []),
    ];
  }

  private async renameSelected() {
    const [old] = this.selectedNames();
    if (!old || this.selectedNames().length !== 1) return;
    const name = await promptText("Rename", "New name", old);
    if (!name || name === old) return;
    if (/[\\/]/.test(name)) return alert("A name can't contain slashes.");
    try {
      await this.deps.rename(this.join(this.path, old), this.join(this.path, name));
      this.selected = new Set([name]);
      await this.go(this.path);
    } catch (e) { alert(String(e)); }
  }

  private async del() {
    const names = this.selectedNames();
    if (!names.length) return;
    const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
    const folders = names.some((n) => this.entries.find((e) => e.name === n)?.isDir);
    if (!confirm(`Delete ${what}${folders ? " and everything inside" : ""}${this.side === "remote" ? " on the server" : ""}? This can't be undone.`)) return;
    try {
      for (const n of names) await this.deps.remove(this.join(this.path, n));
    } catch (e) { alert(String(e)); }
    await this.go(this.path);
  }

  private async newFolder() {
    const name = await promptText("New folder", "Name");
    if (!name) return;
    if (/[\\/]/.test(name)) return alert("A name can't contain slashes.");
    try {
      await this.deps.mkdir(this.join(this.path, name));
      this.selected = new Set([name]);
      await this.go(this.path);
    } catch (e) { alert(String(e)); }
  }

  focus() {
    this.list.focus();
  }
}

// ---------------------------------------------------------------- transfers

interface Transfer {
  tid: string;
  name: string;
  upload: boolean;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message: string;
  /** Where the copy lands, so that pane can be refreshed when it finishes. */
  dest: FilePane;
  destDir: string;
  started: number;
  speed: number;
  sample: { t: number; done: number };
  el: HTMLElement;
  bar: HTMLElement;
  info: HTMLElement;
  stateEl: HTMLElement;
  cancel: HTMLButtonElement;
}

// ---------------------------------------------------------------- the tab

/** An SFTP file browser: this computer on the left, the server on the right, transfers underneath. */
export class FileTab {
  readonly el = h("div", { class: "filetab" });
  readonly header: HTMLElement;
  readonly closeBtn = h("button", { class: "mini", title: "Close tab" }, "✕");
  private readonly dot = h("span", { class: "status connecting" });
  private readonly label = h("span", { class: "tlabel" });
  private readonly local: FilePane;
  private readonly remote: FilePane;
  private readonly txList = h("div", { class: "fm-tx-list" });
  private readonly txSummary = h("span", { class: "fm-tx-sum" });
  private readonly transfers = new Map<string, Transfer>();
  private sid: string | null = null;
  private lastSecrets: [string?, string?] = [];
  private state: FileState = "connecting";
  disposed = false;
  onChange: () => void = () => {};
  /** The global default start folder for the local pane (Settings); a profile's own folder wins over it. */
  static defaultLocalDir = "";

  constructor(readonly profile: Profile) {
    this.header = h("div", { class: "tab filetab-header" }, this.dot, this.label, h("span", { class: "tbadge" }, protoIcon("sftp")), this.closeBtn);
    this.header.style.setProperty("--tab-bg", "var(--bg)");
    this.label.textContent = profile.name;

    this.local = new FilePane("local", "This computer", {
      list: (p) => api.localList(p),
      mkdir: (p) => api.localMkdir(p),
      rename: (a, b) => api.localRename(a, b),
      remove: (p) => api.localDelete(p),
      send: (from, names, dir) => void this.send(from, names, dir),
    });
    this.remote = new FilePane("remote", profile.name, {
      list: (p) => api.sftpList(this.requireSid(), p),
      mkdir: (p) => api.sftpMkdir(this.requireSid(), p),
      rename: (a, b) => api.sftpRename(this.requireSid(), a, b),
      remove: (p) => api.sftpDelete(this.requireSid(), p),
      send: (from, names, dir) => void this.send(from, names, dir),
    });

    const clear = h("button", { class: "fm-link", onclick: () => this.clearFinished() }, "Clear finished");
    const gutterV = h("div", { class: "gutter fm-gutter-v", title: "Drag to resize" });
    const gutterH = h("div", { class: "gutter fm-gutter-h", title: "Drag to resize" });
    const top = h("div", { class: "fm-top" }, this.local.el, gutterV, this.remote.el);
    const tx = h("div", { class: "fm-transfers" },
      h("div", { class: "fm-tx-head" }, h("span", { class: "fm-title" }, "Transfers"), this.txSummary, clear),
      this.txList);
    this.el.append(top, gutterH, tx);
    this.dragResize(gutterV, (x, _y, box) => {
      const r = Math.min(0.85, Math.max(0.15, (x - box.left) / box.width));
      this.local.el.style.flex = `${r} 1 0`;
      this.remote.el.style.flex = `${1 - r} 1 0`;
    }, top);
    this.dragResize(gutterH, (_x, y, box) => {
      this.el.style.setProperty("--fm-tx", `${Math.min(box.height - 160, Math.max(70, box.bottom - y))}px`);
    }, this.el);
    this.updateSummary();

    this.remote.setAvailable(false, "Connecting…");
    void this.startLocal();
    void this.connect();
  }

  private dragResize(g: HTMLElement, move: (x: number, y: number, box: DOMRect) => void, box: HTMLElement) {
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add("drag");
      const r = box.getBoundingClientRect();
      const mv = (ev: PointerEvent) => move(ev.clientX, ev.clientY, r);
      const up = () => { g.classList.remove("drag"); g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); };
      g.addEventListener("pointermove", mv);
      g.addEventListener("pointerup", up);
    });
  }

  // ------------------------------------------------------------ Tab-like surface used by the app shell

  show(on: boolean) {
    this.el.style.display = on ? "" : "none";
    this.header.classList.toggle("active", on);
    this.header.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (on) (this.remote.path ? this.remote : this.local).focus();
  }

  refit() {}
  setGpu(_on: boolean) {}
  applyProfile(_p: Profile) {}
  usesProfile(id: string) {
    return this.profile.id === id;
  }

  dispose() {
    this.disposed = true;
    if (this.sid) void api.close(this.sid);
    this.sid = null;
    this.el.remove();
    this.header.remove();
  }

  // ------------------------------------------------------------ connection

  get title(): string {
    return `${this.profile.name} (files)`;
  }

  private requireSid(): string {
    if (!this.sid || this.state !== "connected") throw new Error("Not connected");
    return this.sid;
  }

  private setState(s: FileState) {
    this.state = s;
    this.dot.className = `status ${s}`;
    this.dot.title = { connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected" }[s];
  }

  private async startLocal() {
    let last = "";
    try { last = localStorage.getItem(LAST_LOCAL) ?? ""; } catch {}
    // The profile's folder, then the global default, then wherever it was last, then the home folder.
    for (const dir of [this.profile.localDir, FileTab.defaultLocalDir, last]) {
      if (dir && (await this.local.go(dir))) return;
    }
    await this.local.go("");
  }

  async connect(password?: string, passphrase?: string) {
    this.setState("connecting");
    this.remote.setAvailable(false, `Connecting to ${this.profile.host}…`);
    this.lastSecrets = [password, passphrase];
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => this.onFrame(buf);
    try {
      this.sid = await api.connectSftp(this.profile.id, ch, password, passphrase);
    } catch (e) {
      this.fail(String(e));
    }
  }

  private fail(message: string) {
    this.sid = null;
    this.setState("disconnected");
    for (const t of this.transfers.values()) if (t.state === "queued" || t.state === "running") this.updateTransfer(t.tid, "error", t.done, t.total, "Connection closed");
    const retry = h("button", { onclick: () => void this.connect(...this.lastSecrets) }, "Reconnect");
    this.remote.setAvailable(false, message, [retry]);
  }

  private onFrame(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0 || this.disposed) return;
    const { state, message } = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    switch (state) {
      case "connecting":
        this.remote.setAvailable(false, message);
        break;
      case "connected":
        this.setState("connected");
        this.remote.setAvailable(true);
        void this.remote.go(this.profile.remoteDir).then((ok) => ok || this.remote.go(""));
        break;
      case "vault-locked":
        void ensureUnlocked().then(() => { this.sid = null; return this.connect(...this.lastSecrets); });
        break;
      case "confirm-host":
        void confirmHostKey(JSON.parse(message));
        break;
      case "need-password":
      case "need-passphrase":
        void this.askSecret(state === "need-passphrase");
        break;
      case "transfer": {
        const t = JSON.parse(message);
        this.updateTransfer(t.tid, t.state, t.done, t.total, t.message);
        break;
      }
      case "lost":
        this.fail("Connection lost.");
        break;
      case "closed":
        this.fail("The connection was closed.");
        break;
      case "error":
        this.fail(message);
        break;
    }
  }

  private async askSecret(passphrase: boolean) {
    const secret = await askLoginSecret(this.profile, passphrase);
    if (secret === null) return this.fail("Cancelled.");
    this.sid = null;
    await this.connect(passphrase ? undefined : secret, passphrase ? secret : undefined);
  }

  // ------------------------------------------------------------ transfers

  private async send(from: FilePane, names: string[], destDir?: string) {
    if (this.state !== "connected" || !this.sid) return alert("Not connected to the server yet.");
    const to = from === this.local ? this.remote : this.local;
    const upload = from === this.local;
    const dir = destDir ?? to.path;
    const entries = names.map((n) => from.entries.find((e) => e.name === n)).filter((e): e is FileEntry => !!e);
    if (!entries.length) return;

    // Only the folder on screen is known; a drop onto a sub-folder skips existing files rather than asking.
    const clash = dir === to.path ? entries.filter((e) => to.entries.some((x) => x.name === e.name)) : [];
    let overwrite = false;
    if (clash.length) {
      const list = clash.slice(0, 6).map((e) => e.name).join(", ") + (clash.length > 6 ? `, and ${clash.length - 6} more` : "");
      const answer = await modal("Already there", h("div", {}, h("p", {}, `${clash.length === 1 ? "This item exists" : `${clash.length} items exist`} in the destination:`), h("p", { class: "mono" }, list)),
        [{ label: "Cancel" }, { label: "Skip existing" }, { label: "Overwrite", primary: true }]);
      if (!answer || answer === "Cancel") return;
      overwrite = answer === "Overwrite";
    }
    const items: TransferItem[] = entries.map((e) => ({ src: from.join(from.path, e.name), dst: to.join(dir, e.name), isDir: e.isDir }));
    try {
      const started = await api.sftpTransfer(this.sid, upload, items, overwrite);
      for (const s of started) this.addTransfer(s.tid, s.name, upload, to, dir);
    } catch (e) {
      alert(String(e));
    }
  }

  private addTransfer(tid: string, name: string, upload: boolean, dest: FilePane, destDir: string) {
    if (this.transfers.has(tid)) return;
    const bar = h("div", { class: "fm-bar" }, h("div"));
    const info = h("span", { class: "fm-tx-info" });
    const stateEl = h("span", { class: "fm-tx-state" });
    const cancel = h("button", { class: "mini", title: "Cancel", onclick: () => {
      const t = this.transfers.get(tid);
      if (t && (t.state === "queued" || t.state === "running")) void api.sftpCancel(this.sid ?? "", tid);
      else this.removeTransfer(tid);
    } }, "✕");
    const el = h("div", { class: "fm-tx" },
      h("span", { class: "fm-tx-dir", title: upload ? "Upload" : "Download" }, upload ? "↑" : "↓"),
      h("span", { class: "fm-tx-name", title: name }, name), bar, info, stateEl, cancel);
    const t: Transfer = { tid, name, upload, state: "queued", done: 0, total: 0, message: "", dest, destDir, started: Date.now(), speed: 0, sample: { t: Date.now(), done: 0 }, el, bar, info, stateEl, cancel };
    this.transfers.set(tid, t);
    this.txList.prepend(el);
    this.render(t);
  }

  private updateTransfer(tid: string, state: string, done: number, total: number, message: string) {
    const t = this.transfers.get(tid);
    if (!t) return;
    const now = Date.now();
    if (now - t.sample.t >= 400 || state !== "running") {
      const inst = ((done - t.sample.done) / Math.max(1, now - t.sample.t)) * 1000;
      t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      t.sample = { t: now, done };
    }
    const finishing = (state === "done" || state === "error" || state === "cancelled") && t.state !== state;
    Object.assign(t, { state, done, total, message });
    this.render(t);
    if (finishing && t.dest.path === t.destDir) void t.dest.refresh();
    this.updateSummary();
  }

  private render(t: Transfer) {
    const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
    (t.bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
    t.el.className = `fm-tx ${t.state}`;
    const active = t.state === "running";
    t.info.textContent = t.total ? `${fmtSize(t.done)} / ${fmtSize(t.total)}${active && t.speed > 0 ? ` · ${fmtSize(t.speed)}/s` : ""}` : active ? "Preparing…" : "";
    t.stateEl.textContent = { queued: "Waiting", running: `${Math.round(pct)}%`, done: t.message || "Done", error: t.message || "Failed", cancelled: "Cancelled" }[t.state];
    t.stateEl.title = t.message;
    t.cancel.title = active || t.state === "queued" ? "Cancel" : "Remove from list";
  }

  private removeTransfer(tid: string) {
    this.transfers.get(tid)?.el.remove();
    this.transfers.delete(tid);
    this.updateSummary();
  }

  private clearFinished() {
    for (const t of [...this.transfers.values()]) if (t.state !== "queued" && t.state !== "running") this.removeTransfer(t.tid);
  }

  private updateSummary() {
    const all = [...this.transfers.values()];
    const active = all.filter((t) => t.state === "queued" || t.state === "running").length;
    const failed = all.filter((t) => t.state === "error").length;
    this.txSummary.textContent = all.length
      ? [active ? `${active} active` : "", failed ? `${failed} failed` : "", `${all.length - active - failed} finished`].filter((s) => !s.startsWith("0") && s).join(" · ")
      : "Nothing yet — drag files between the panes, or double-click one";
  }
}
