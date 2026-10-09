import { api, HttpPayload, HttpResult, Profile } from "./api";
import { Captured, CheckResult, ResponseView, runCaptures, runChecks } from "./http-checks";
import { environmentsDialog } from "./http-env";
import {
  ApiSettings, AuthKind, BodyKind, blankRequest, Capture, Check, fmtBytes, fmtMillis, fromCurl, HttpRequest, isAbsoluteUrl, JSON_TOKEN,
  looksLikeCurl, mergeHeaders, METHODS, Method, Pair, paramsFromUrl, prettyJson, resolveUrl, sanitizeRequest, stripBase, toCurl, withQuery,
} from "./http-model";
import { dropProxy, proxyPort } from "./http-proxy";
import type { ConnStore } from "./http-store";
import { MenuEntries, menuOn } from "./menu";
import { h, promptText } from "./ui";

type Section = "params" | "headers" | "auth" | "body" | "after";
type Outcome = { res: HttpResult } | { error: string } | { cancelled: true } | null;

const LAYOUT_KEY = "portique.api.layout";
const HEADER_NAMES = ["Accept", "Accept-Language", "Authorization", "Cache-Control", "Content-Type", "Cookie", "If-None-Match", "Origin", "Referer", "User-Agent", "X-API-Key", "X-Requested-With"];
const BIG_JSON = 300_000; // above this the response is shown without colouring, to stay quick

/** The SSH profiles a request can be sent from, as they are right now. */
async function sshProfiles(): Promise<Profile[]> {
  const all = await api.listProfiles().catch(() => [] as Profile[]);
  return all.filter((p) => p.protocol === "ssh").sort((a, b) => a.name.localeCompare(b.name));
}

const enabled = (p: Pair[]) => p.filter((x) => x.on && x.key.trim());

/** A short name for an unsaved request, from its URL ("GET api.example.com/users"). */
export function requestLabel(r: HttpRequest): string {
  if (r.name) return r.name;
  const u = r.url.trim().replace(/^[a-z]+:\/\//i, "").replace(/\?.*$/, "").replace(/\/$/, "");
  return u ? (u.length > 34 ? u.slice(0, 33) + "…" : u) : "New request";
}

function replaceAll<T>(arr: T[], next: T[]) {
  arr.splice(0, arr.length, ...next);
}

// ---------------------------------------------------------------- a key/value table

/**
 * Editable rows of on/off, name, value. There is always an empty row at the end to type into;
 * typing in it makes it real, without redrawing (and so without losing the cursor).
 */
export function pairsTable(pairs: Pair[], onChange: () => void, o: { key: string; value: string; names?: string }) {
  const el = h("div", { class: "kv" });
  const row = (p: Pair | null): HTMLElement => {
    let cur = p;
    const on = h("input", { type: "checkbox", checked: p?.on ?? true, disabled: !p, "aria-label": "Use this row" });
    const key = h("input", { value: p?.key ?? "", placeholder: p ? "" : o.key, spellcheck: false, autocomplete: "off", ...(o.names ? { list: o.names } : {}) });
    const value = h("input", { value: p?.value ?? "", placeholder: p ? "" : o.value, spellcheck: false, autocomplete: "off" });
    const del = h("button", { class: "mini row-del", title: "Remove row", tabIndex: -1, onclick: () => {
      if (!cur) return;
      pairs.splice(pairs.indexOf(cur), 1);
      r.remove();
      onChange();
    } }, "✕");
    const r = h("div", { class: "kv-row" + (p ? "" : " ghost") }, on, key, value, del);
    const touch = () => {
      if (!cur) {
        cur = { key: "", value: "", on: true };
        pairs.push(cur);
        on.disabled = false;
        r.classList.remove("ghost");
        el.append(row(null));
      }
      cur.key = key.value;
      cur.value = value.value;
      onChange();
    };
    key.addEventListener("input", touch);
    value.addEventListener("input", touch);
    on.addEventListener("change", () => { if (cur) { cur.on = on.checked; r.classList.toggle("off", !cur.on); onChange(); } });
    r.classList.toggle("off", !!cur && !cur.on);
    return r;
  };
  const draw = () => el.replaceChildren(...pairs.map(row), row(null));
  draw();
  return { el, draw };
}

/**
 * Editable rows made of arbitrary cells, with the same always-present empty row as `pairsTable`.
 * `cells` builds the controls for one item and calls `touch` whenever the user changes something.
 */
function rowsTable<T>(items: T[], blank: () => T, onChange: () => void, columns: string, heads: string[], cells: (item: T, touch: () => void) => HTMLElement[]) {
  const el = h("div", { class: "rt" });
  el.style.setProperty("--cols", columns);
  const row = (item: T | null): HTMLElement => {
    const draft = item ?? blank();
    let real = item !== null;
    const r = h("div", { class: "rt-row" + (real ? "" : " ghost") });
    const touch = () => {
      if (!real) {
        real = true;
        items.push(draft);
        r.classList.remove("ghost");
        el.append(row(null));
      }
      onChange();
    };
    const del = h("button", { class: "mini row-del", title: "Remove row", tabIndex: -1, onclick: () => {
      if (!real) return;
      items.splice(items.indexOf(draft), 1);
      r.remove();
      onChange();
    } }, "✕");
    r.append(...cells(draft, touch), del);
    return r;
  };
  el.append(h("div", { class: "rt-row head" }, ...heads.map((t) => h("span", {}, t)), h("span")), ...items.map(row), row(null));
  return el;
}

// ---------------------------------------------------------------- response colouring

/** JSON as coloured text. Built from text nodes, so nothing in the response is ever treated as markup. */
function highlightJson(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const [all, str, colon, word] = m;
    const cls = str ? (colon ? "j-key" : "j-str") : word ? (word === "null" ? "j-null" : "j-bool") : "j-num";
    frag.append(h("span", { class: cls }, str ? str : all));
    if (colon) frag.append(colon);
    last = m.index + all.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// ---------------------------------------------------------------- the request editor

/** What a request editor needs from the connection tab that holds it. */
export interface EditorHost {
  readonly store: ConnStore;
  /** The connection's current settings, read whenever a request is sent, so edits to the connection apply at once. */
  settings(): ApiSettings;
  connName(): string;
  /** The request's name, method or unsaved state changed. */
  onState(e: RequestEditor): void;
  /** Open the connection's settings. */
  editConnection(): void;
}

const AUTH_NAMES: Record<AuthKind, string> = { inherit: "", none: "none", bearer: "Bearer token", basic: "username and password", header: "API key", oauth2: "OAuth 2.0" };

/** One request: its address, what it sends, and the last response. */
export class RequestEditor {
  readonly el = h("div", { class: "reqedit" });

  req: HttpRequest;
  private baseline: string;
  private section: Section;
  private outcome: Outcome = null;
  private inflight: string | null = null;
  private view: "body" | "headers" | "checks" = "body";
  /** What the checks and saves found in the last response. */
  private after: { results: CheckResult[]; captured: Captured[]; saved: boolean } | null = null;
  private lastVia = "";
  private busyText = "Waiting for the server…";
  private cancelRequested = false;
  private raw = false;
  private wrap = true;
  disposed = false;

  private readonly method = h("select", { class: "api-method", "aria-label": "Method" }, ...METHODS.map((m) => h("option", { value: m }, m)));
  private readonly baseChip = h("span", { class: "api-base" });
  private readonly url = h("input", { class: "api-url", spellcheck: false, autocomplete: "off", placeholder: "/path, or paste a curl command" });
  private readonly send = h("button", { class: "primary api-send" });
  private readonly envSel = h("select", { class: "api-env", title: "Environment: the values that {{variables}} are filled in with" });
  private readonly sections = h("div", { class: "api-sections", role: "tablist" });
  private readonly panel = h("div", { class: "api-panel" });
  private readonly reqBox = h("div", { class: "api-req" });
  private readonly resBox = h("div", { class: "api-res" });
  private params!: ReturnType<typeof pairsTable>;
  private readonly unsubscribe: () => void;

  /** `saved` opens a saved request; otherwise a new, empty one. */
  constructor(private readonly host: EditorHost, saved?: HttpRequest) {
    this.req = saved ? sanitizeRequest(structuredClone(saved)) : blankRequest();
    this.baseline = JSON.stringify(this.req);
    this.section = this.req.bodyKind !== "none" ? "body" : "params";

    const bar = h("div", { class: "api-bar" }, this.method, h("div", { class: "api-addr-box" }, this.baseChip, this.url), this.send, this.envSel);
    const gutter = h("div", { class: "gutter api-gutter", title: "Drag to resize" });
    const split = h("div", { class: "api-split" }, this.reqBox, gutter, this.resBox);
    this.reqBox.append(this.sections, this.panel);
    this.el.append(bar, split);
    this.applyLayout(split);
    this.dragResize(gutter, split);

    this.wire();
    this.fillEnvs();
    const onStore = () => { this.fillEnvs(); this.syncMeta(); };
    this.host.store.listeners.add(onStore);
    this.unsubscribe = () => this.host.store.listeners.delete(onStore);
    this.syncFromRequest();
    this.setSending(false);
    this.renderResponse();
  }

  // ------------------------------------------------------------ wiring

  private wire() {
    this.method.addEventListener("change", () => {
      this.req.method = this.method.value as Method;
      this.changed();
    });
    this.url.addEventListener("input", () => {
      this.req.url = this.url.value;
      replaceAll(this.req.params, paramsFromUrl(this.req.url, this.req.params));
      if (this.section === "params") this.params.draw();
      this.changed();
    });
    this.url.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!looksLikeCurl(text)) return;
      e.preventDefault();
      this.importCurl(text);
    });
    this.send.addEventListener("click", () => (this.inflight ? this.cancel() : void this.sendNow()));
    this.envSel.addEventListener("change", async () => {
      if (this.envSel.value === "\0manage") {
        this.fillEnvs();
        await environmentsDialog(this.host.store, this.host.store.data.activeEnv);
        this.fillEnvs();
      } else await this.host.store.setActiveEnv(this.envSel.value);
    });
    window.addEventListener("keydown", this.onKey);
    // Right-clicking blank space (not a text box, which keeps its own copy/paste menu) opens the request menu.
    this.el.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, .api-res")) return;
      menuOn(e, this.menuEntries());
    });
    this.resBox.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      menuOn(e, this.responseMenu());
    });
  }

  private dragResize(g: HTMLElement, split: HTMLElement) {
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add("drag");
      const box = split.getBoundingClientRect();
      const side = split.classList.contains("side");
      const mv = (ev: PointerEvent) => {
        const r = side ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
        const c = Math.min(0.85, Math.max(0.15, r));
        this.reqBox.style.flex = `${c} 1 0`;
        this.resBox.style.flex = `${1 - c} 1 0`;
      };
      const up = () => { g.classList.remove("drag"); g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); };
      g.addEventListener("pointermove", mv);
      g.addEventListener("pointerup", up);
    });
    g.addEventListener("dblclick", () => { this.reqBox.style.flex = ""; this.resBox.style.flex = ""; });
  }

  private applyLayout(split: HTMLElement = this.el.querySelector(".api-split")!) {
    let side = false;
    try { side = localStorage.getItem(LAYOUT_KEY) === "side"; } catch {}
    split.classList.toggle("side", side);
    this.reqBox.style.flex = "";
    this.resBox.style.flex = "";
  }

  private toggleLayout() {
    const split = this.el.querySelector(".api-split") as HTMLElement;
    const side = !split.classList.contains("side");
    try { localStorage.setItem(LAYOUT_KEY, side ? "side" : "stack"); } catch {}
    this.applyLayout(split);
  }

  /** Shortcuts work whenever this is the request on screen, wherever focus happens to be (but not under a dialog). */
  private readonly onKey = (e: KeyboardEvent) => {
    if (this.el.getClientRects().length === 0 || document.querySelector(".overlay")) return;
    const plain = e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === "Enter") { e.preventDefault(); void this.sendNow(); }
    else if (plain && e.key.toLowerCase() === "s") { e.preventDefault(); void this.save(); }
    else if (plain && e.key.toLowerCase() === "l") { e.preventDefault(); this.url.focus(); this.url.select(); }
    else if (e.key === "Escape" && this.inflight && !document.querySelector(".menu")) { e.preventDefault(); this.cancel(); }
  };

  // ------------------------------------------------------------ the request

  /** Updates every control from `this.req` (after opening, or after importing a curl command). */
  private syncFromRequest() {
    this.method.value = this.req.method;
    this.url.value = this.req.url;
    this.renderSections();
    this.renderPanel();
    this.refreshHeader();
  }

  private changed() {
    this.refreshHeader();
    this.renderSections(true);
  }

  get dirty(): boolean {
    return JSON.stringify(this.req) !== this.baseline && !(this.isBlank() && !this.host.store.request(this.req.id));
  }

  private isBlank(): boolean {
    const b = blankRequest();
    return JSON.stringify({ ...this.req, id: "" }) === JSON.stringify({ ...b, id: "" });
  }

  private refreshHeader() {
    this.method.className = `api-method m-${this.req.method}`;
    this.refreshBase();
    this.host.onState(this);
  }

  /** The connection's base address, shown dimmed in front of the path. */
  private refreshBase() {
    const base = this.host.settings().baseUrl;
    const own = isAbsoluteUrl(this.req.url);
    this.baseChip.textContent = base.replace(/^[a-z]+:\/\//i, "");
    this.baseChip.style.display = base ? "" : "none";
    this.baseChip.classList.toggle("off", own);
    this.baseChip.title = own
      ? "This request has a full address of its own, so the connection's base address isn't used"
      : `The base address of ${this.host.connName()}. Change it in the connection's settings.`;
  }

  /** The address the request really goes to. */
  private fullUrl(): string {
    return resolveUrl(this.host.settings().baseUrl, this.req.url);
  }

  private count(s: Section): string {
    const r = this.req;
    switch (s) {
      case "params": return enabled(r.params).length ? String(enabled(r.params).length) : "";
      case "headers": return enabled(r.headers).length ? String(enabled(r.headers).length) : "";
      case "auth": return { inherit: "", none: "none", bearer: "Bearer", basic: "Basic", header: "Key", oauth2: "OAuth" }[r.auth.kind];
      case "after": { const n = r.checks.filter((c) => c.on).length + r.captures.filter((c) => c.on && c.name).length; return n ? String(n) : ""; }
      case "body": return { none: "", json: "JSON", text: "Text", form: "Form" }[r.bodyKind];
      default: return "";
    }
  }

  private renderSections(onlyCounts = false) {
    const defs: [Section, string][] = [["params", "Params"], ["headers", "Headers"], ["auth", "Auth"], ["body", "Body"], ["after", "After"]];
    if (onlyCounts && this.sections.children.length === defs.length) {
      defs.forEach(([s], i) => { (this.sections.children[i].querySelector(".cnt") as HTMLElement).textContent = this.count(s); });
      return;
    }
    this.sections.replaceChildren(...defs.map(([s, label]) =>
      h("button", { class: "api-section" + (s === this.section ? " on" : ""), role: "tab", "aria-selected": String(s === this.section),
        onclick: () => { this.section = s; this.renderSections(); this.renderPanel(); } },
        label, h("span", { class: "cnt" }, this.count(s)))));
  }

  private renderPanel() {
    const r = this.req;
    const note = (...c: (Node | string)[]) => h("p", { class: "api-note" }, ...c);
    const field = (label: string, input: Node) => h("label", { class: "api-field" }, h("span", {}, label), input);
    const bind = (input: HTMLInputElement | HTMLTextAreaElement, set: (v: string) => void) => input.addEventListener("input", () => { set(input.value); this.changed(); });

    switch (this.section) {
      case "params": {
        this.params = pairsTable(r.params, () => {
          this.req.url = withQuery(this.req.url, this.req.params);
          this.url.value = this.req.url;
          this.changed();
        }, { key: "name", value: "value" });
        this.panel.replaceChildren(this.params.el, note("Parameters are added to the address as ", h("code", {}, "?name=value"), ". Untick a row to leave it out."));
        break;
      }
      case "headers": {
        const list = h("datalist", { id: "api-header-names" }, ...HEADER_NAMES.map((n) => h("option", { value: n })));
        const t = pairsTable(r.headers, () => this.changed(), { key: "Header", value: "value", names: "api-header-names" });
        const inherited = mergeHeaders(this.host.settings().headers, []).filter((c) => !r.headers.some((x) => x.on && x.key.trim().toLowerCase() === c.key.trim().toLowerCase()));
        this.panel.replaceChildren(list, t.el,
          ...(inherited.length ? [note("Also sent with every request on this connection: ", h("code", {}, inherited.map((x) => x.key.trim()).join(", ")), ". Add a header here with the same name to replace one.")] : []),
          note("Content-Type is set for you when you choose a JSON or form body."));
        break;
      }
      case "auth": {
        const cAuth = this.host.settings().auth.kind;
        const inheritLabel = `Use the connection's sign-in (${cAuth === "none" ? "none" : AUTH_NAMES[cAuth]})`;
        const kind = h("select", {}, ...([["inherit", inheritLabel], ["none", "No authentication"], ["bearer", "Bearer token"], ["basic", "Username and password"], ["header", "API key in a header"], ["oauth2", "OAuth 2.0 (client credentials)"]] as [AuthKind, string][])
          .map(([v, l]) => h("option", { value: v, selected: v === r.auth.kind }, l)));
        const fields = h("div", { class: "api-fields" });
        const draw = () => {
          const a = r.auth;
          const mk = (label: string, key: "token" | "user" | "pass" | "name" | "value" | "tokenUrl" | "clientId" | "clientSecret" | "scope", secret = false, ph = "") => {
            const i = h("input", { value: a[key], type: secret ? "password" : "text", spellcheck: false, autocomplete: "off", placeholder: ph });
            bind(i, (v) => (a[key] = v));
            return field(label, i);
          };
          fields.replaceChildren(...({
            inherit: () => [note(cAuth === "none" ? "The connection has no sign-in set up, so this request is sent without credentials. Pick a type above to give this request its own." : `Signs in the way the connection does (${AUTH_NAMES[cAuth]}). Change that in the connection's settings, or pick a type above to use something different for this request.`)],
            none: () => [note("This request is sent without credentials, even if the connection has some.")],
            bearer: () => [mk("Token", "token", false, "{{token}}"), note("Sent as ", h("code", {}, "Authorization: Bearer …"), ".")],
            basic: () => [mk("Username", "user"), mk("Password", "pass", true)],
            header: () => [mk("Header name", "name", false, "X-API-Key"), mk("Value", "value", false, "{{apiKey}}")],
            oauth2: () => [mk("Token URL", "tokenUrl", false, "https://login.example.com/oauth/token"), mk("Client ID", "clientId", false, "{{clientId}}"), mk("Client secret", "clientSecret", true, "{{clientSecret}}"), mk("Scope (optional)", "scope"),
              note("Portique signs in for you when you press Send, keeps the token until it expires, and signs in again if the API refuses it.")],
          }[a.kind]()), ...(a.kind === "none" || a.kind === "inherit" ? [] : [note("Tip: put the secret in an environment and enter it here as ", h("code", {}, "{{name}}"), ", so it stays in the vault and out of saved requests.")]));
        };
        kind.addEventListener("change", () => { r.auth.kind = kind.value as AuthKind; draw(); this.changed(); });
        draw();
        this.panel.replaceChildren(field("Type", kind), fields);
        break;
      }
      case "body": {
        const kind = h("select", {}, ...([["none", "No body"], ["json", "JSON"], ["text", "Plain text"], ["form", "Form fields"]] as [BodyKind, string][])
          .map(([v, l]) => h("option", { value: v, selected: v === r.bodyKind }, l)));
        const content = h("div", { class: "api-body-edit" });
        const draw = () => {
          if (r.bodyKind === "none") return content.replaceChildren(note("This request has no body."));
          if (r.bodyKind === "form") {
            return content.replaceChildren(pairsTable(r.form, () => this.changed(), { key: "name", value: "value" }).el, note("Sent as ", h("code", {}, "application/x-www-form-urlencoded"), ", encoded for you."));
          }
          const ta = h("textarea", { class: "api-text", value: r.bodyText, spellcheck: false, placeholder: r.bodyKind === "json" ? '{\n  "name": "value"\n}' : "" });
          const msg = h("span", { class: "api-json-msg" });
          const fmt = h("button", { class: "fm-link", onclick: () => {
            const p = prettyJson(ta.value);
            if (p === null) return;
            ta.value = p; r.bodyText = p; this.changed(); check();
          } }, "Format");
          const check = () => {
            const v = ta.value.trim();
            let bad = "";
            if (r.bodyKind === "json" && v && !v.includes("{{")) try { JSON.parse(v); } catch (e) { bad = String((e as Error).message).replace(/^JSON\.parse: /, ""); }
            msg.textContent = bad ? `Not valid JSON: ${bad}` : "";
            fmt.style.display = r.bodyKind === "json" && !bad && v ? "" : "none";
          };
          ta.addEventListener("input", () => { r.bodyText = ta.value; this.changed(); check(); });
          check();
          content.replaceChildren(ta, h("div", { class: "api-text-foot" }, msg, fmt));
        };
        kind.addEventListener("change", () => { r.bodyKind = kind.value as BodyKind; draw(); this.changed(); });
        draw();
        this.panel.replaceChildren(field("Type", kind), content);
        break;
      }
      case "after": {
        const sourceSel = (value: string, options: [string, string][]) => {
          const el = h("select", {}, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
          return el;
        };
        const checks = rowsTable<Check>(r.checks, () => ({ on: true, source: "status", path: "", op: "is", value: "200" }), () => this.changed(),
          "18px 118px minmax(0,1fr) 124px minmax(0,1fr) 22px", ["", "Check", "", "", "Value"], (c, touch) => {
            const on = h("input", { type: "checkbox", checked: c.on, "aria-label": "Use this check" });
            const what = sourceSel(c.source, [["status", "Status"], ["json", "JSON field"], ["header", "Header"], ["body", "Body"]]);
            const path = h("input", { value: c.path, spellcheck: false, autocomplete: "off" });
            const op = sourceSel(c.op, [["is", "is"], ["isnt", "is not"], ["contains", "contains"], ["exists", "exists"], ["lt", "is less than"], ["gt", "is more than"]]);
            const value = h("input", { value: c.value, spellcheck: false, autocomplete: "off" });
            const sync = () => {
              const needsPath = c.source === "json" || c.source === "header";
              path.style.visibility = needsPath ? "" : "hidden";
              path.placeholder = c.source === "json" ? "user.name  or  items[0].id" : "header name";
              value.style.visibility = c.op === "exists" ? "hidden" : "";
              value.placeholder = c.source === "status" ? "200" : "value";
            };
            on.addEventListener("change", () => { c.on = on.checked; touch(); });
            what.addEventListener("change", () => { c.source = what.value as Check["source"]; if (c.source === "status" && !c.value) c.value = "200"; sync(); touch(); });
            op.addEventListener("change", () => { c.op = op.value as Check["op"]; sync(); touch(); });
            path.addEventListener("input", () => { c.path = path.value; touch(); });
            value.addEventListener("input", () => { c.value = value.value; touch(); });
            sync();
            return [on, what, path, op, value];
          });
        const saves = rowsTable<Capture>(r.captures, () => ({ on: true, source: "json", path: "", name: "", secret: false }), () => this.changed(),
          "18px 118px minmax(0,1fr) minmax(0,1fr) 54px 22px", ["", "Take", "", "Save as", "Secret"], (c, touch) => {
            const on = h("input", { type: "checkbox", checked: c.on, "aria-label": "Use this row" });
            const from = sourceSel(c.source, [["json", "JSON field"], ["header", "Header"]]);
            const path = h("input", { value: c.path, spellcheck: false, autocomplete: "off", placeholder: "access_token  or  data.items[0].id" });
            const name = h("input", { value: c.name, spellcheck: false, autocomplete: "off", placeholder: "variable name, e.g. token" });
            const secret = h("input", { type: "checkbox", checked: c.secret, title: "Keep it in the vault instead of the environment file", "aria-label": "Secret" });
            const sync = () => { path.placeholder = c.source === "json" ? "access_token  or  data.items[0].id" : "header name"; };
            on.addEventListener("change", () => { c.on = on.checked; touch(); });
            from.addEventListener("change", () => { c.source = from.value as Capture["source"]; sync(); touch(); });
            path.addEventListener("input", () => { c.path = path.value; touch(); });
            name.addEventListener("input", () => { c.name = name.value.trim(); touch(); });
            secret.addEventListener("change", () => { c.secret = secret.checked; touch(); });
            return [on, from, path, name, secret];
          });
        this.panel.replaceChildren(
          h("h4", { class: "api-h" }, "Check the response"),
          checks,
          note("Checks run after every send. The result shows on the response, so you can see at a glance whether the API did what you expect."),
          h("h4", { class: "api-h" }, "Remember from the response"),
          saves,
          note("Values are kept in the selected environment, so the next request can use them as ", h("code", {}, "{{name}}"), ". Handy for tokens and ids. Tick Secret to keep one in the vault."));
        break;
      }
    }
  }

  /** A rename or move done from the sidebar shows up here too, without counting as an unsaved change. */
  private syncMeta() {
    const saved = this.host.store.request(this.req.id);
    if (!saved || (saved.name === this.req.name && saved.group === this.req.group)) return;
    const base = JSON.parse(this.baseline);
    this.req.name = base.name = saved.name;
    this.req.group = base.group = saved.group;
    this.baseline = JSON.stringify(base);
    this.refreshHeader();
  }

  // ------------------------------------------------------------ environments

  private fillEnvs() {
    const { envs, activeEnv } = this.host.store.data;
    this.envSel.replaceChildren(
      h("option", { value: "" }, "No environment"),
      ...envs.map((e) => h("option", { value: e.id }, e.name)),
      h("option", { value: "\0manage" }, envs.length ? "Manage environments…" : "Set up environments…"));
    this.envSel.value = envs.some((e) => e.id === activeEnv) ? activeEnv : "";
  }

  // ------------------------------------------------------------ sending

  private payload(id: string): HttpPayload {
    const r = this.req;
    const conn = this.host.settings();
    const env = this.host.store.env;
    const a = r.auth.kind === "inherit" ? conn.auth : r.auth;
    return {
      id,
      method: r.method,
      url: this.fullUrl(),
      headers: mergeHeaders(conn.headers, r.headers).map((p): [string, string] => [p.key.trim(), p.value]),
      body: r.bodyKind === "none" ? { kind: "none" }
        : r.bodyKind === "form" ? { kind: "form", pairs: enabled(r.form).map((p): [string, string] => [p.key, p.value]) }
        : { kind: r.bodyKind, text: r.bodyText },
      auth: a.kind === "bearer" ? { kind: "bearer", token: a.token }
        : a.kind === "basic" ? { kind: "basic", user: a.user, pass: a.pass }
        : a.kind === "header" ? { kind: "header", name: a.name, value: a.value }
        : a.kind === "oauth2" ? { kind: "oauth2", tokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope }
        : { kind: "none" },
      insecure: conn.insecure,
      followRedirects: conn.follow,
      timeoutSecs: conn.timeout,
      envId: env?.id ?? "",
      vars: Object.fromEntries((env?.vars ?? []).filter((v) => !v.secret && v.key).map((v) => [v.key, v.value])),
    };
  }

  async sendNow() {
    if (this.inflight) return;
    if (!this.fullUrl().trim()) {
      this.outcome = { error: "Enter an address to send the request to." };
      this.after = null;
      this.renderResponse();
      this.url.focus();
      return;
    }
    const id = crypto.randomUUID();
    this.inflight = id;
    this.cancelRequested = false;
    this.outcome = null;
    this.after = null;
    this.view = "body";
    this.busyText = "Waiting for the server…";
    this.setSending(true);
    const via = this.host.settings().via;
    this.lastVia = "";
    try {
      let port: number | undefined;
      if (via) {
        const p = (await sshProfiles()).find((x) => x.id === via);
        if (!p) throw new Error("The SSH host this connection sends from no longer exists. Choose another in the connection's settings.");
        this.lastVia = p.name;
        this.busyText = `Connecting to ${p.name}…`;
        this.renderResponse();
        port = await proxyPort(p);
        this.busyText = `Waiting for the server (through ${p.name})…`;
        if (this.cancelRequested) throw new Error("Cancelled");
        this.renderResponse();
      }
      const res = await api.httpSend({ ...this.payload(id), ...(port ? { proxyPort: port } : {}) });
      this.outcome = { res };
      await this.runAfter(res);
    } catch (e) {
      const msg = String(e).replace(/^Error: /, "");
      this.outcome = msg === "Cancelled" ? { cancelled: true } : { error: msg };
      if (via && msg.startsWith("Could not connect through the SSH host")) void dropProxy(via); // the login may have died: log in afresh next time
    } finally {
      this.inflight = null;
      if (!this.disposed) {
        this.setSending(false);
        this.renderResponse();
      }
    }
  }

  /** Runs this request's checks and saves against the response. */
  private async runAfter(res: HttpResult) {
    const r = this.req;
    if (!r.checks.some((c) => c.on) && !r.captures.some((c) => c.on && c.name)) return;
    const view: ResponseView = { status: res.status, headers: res.headers, body: res.binary ? "" : res.body };
    const results = runChecks(r.checks, view);
    const captured = runCaptures(r.captures, view);
    let saved = true;
    const found = captured.filter((c) => c.value !== null).map((c) => ({ name: c.name, value: c.value as string, secret: c.secret }));
    if (found.length) saved = await this.host.store.capture(found).catch(() => false);
    this.after = { results, captured, saved };
    if (results.some((c) => !c.pass)) this.view = "checks"; // a failure is worth seeing right away
  }

  private cancel() {
    this.cancelRequested = true;
    if (this.inflight) void api.httpCancel(this.inflight);
  }

  private setSending(on: boolean) {
    this.send.textContent = on ? "Cancel" : "Send";
    this.send.classList.toggle("primary", !on);
    this.send.title = on ? "Stop waiting (Esc)" : "Send the request (Ctrl+Enter)";
    this.resBox.classList.toggle("busy", on);
    if (on) this.renderResponse();
  }

  // ------------------------------------------------------------ the response

  private renderResponse() {
    const box = this.resBox;
    const msg = (cls: string, ...c: (Node | string)[]) => box.replaceChildren(h("div", { class: `api-msg ${cls}` }, ...c));
    if (this.inflight) return msg("busy", h("span", { class: "api-spin" }), this.busyText, h("small", {}, "Esc to cancel"));
    const o = this.outcome;
    if (!o) return msg("", h("div", { class: "api-hint" }, "The response will appear here"), h("small", {}, h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Enter"), " to send"));
    if ("cancelled" in o) return msg("", "Cancelled");
    if ("error" in o) return msg("err", h("div", {}, o.error));
    const res = o.res;
    const cls = res.status >= 500 ? "s5" : res.status >= 400 ? "s4" : res.status >= 300 ? "s3" : res.status >= 200 ? "s2" : "s1";
    const json = this.view === "body" && !res.binary ? prettyJson(res.body) : null;
    const after = this.after;
    const failed = after ? after.results.filter((c) => !c.pass).length : 0;
    const tab = (v: "body" | "headers" | "checks", label: string) => h("button", { class: "api-vtab" + (this.view === v ? " on" : ""), onclick: () => { this.view = v; this.renderResponse(); } }, label);
    const status = h("div", { class: "api-status" },
      h("span", { class: `api-code ${cls}` }, `${res.status}${res.reason ? " " + res.reason : ""}`),
      h("span", { class: "api-stat", title: `Headers after ${fmtMillis(res.headMillis)}` }, fmtMillis(res.millis)),
      h("span", { class: "api-stat" }, fmtBytes(res.size) + (res.truncated ? "+" : "")),
      ...(this.lastVia ? [h("span", { class: "api-stat via", title: "Sent through this SSH host" }, `via ${this.lastVia}`)] : []),
      ...(after && after.results.length ? [h("button", { class: "api-pill " + (failed ? "bad" : "good"), title: "Show the checks", onclick: () => { this.view = "checks"; this.renderResponse(); } },
        failed ? `✗ ${failed} of ${after.results.length} failed` : `✓ ${after.results.length} passed`)] : []),
      h("span", { class: "api-spacer" }),
      ...(json ? [h("button", { class: "fm-link", title: this.raw ? "Show indented" : "Show as received", onclick: () => { this.raw = !this.raw; this.renderResponse(); } }, this.raw ? "Pretty" : "Raw")] : []),
      tab("body", "Body"), tab("headers", `Headers ${res.headers.length}`),
      ...(after && (after.results.length || after.captured.length) ? [tab("checks", "Checks")] : []));

    const content = h("div", { class: "api-content" });
    if (this.view === "checks" && after) {
      content.append(h("div", { class: "api-checks" },
        ...after.results.map((c) => h("div", { class: "api-check " + (c.pass ? "good" : "bad") }, h("span", { class: "mark" }, c.pass ? "✓" : "✗"), h("span", {}, c.label), h("span", { class: "why" }, c.detail))),
        ...after.captured.map((c) => h("div", { class: "api-check " + (c.value === null ? "bad" : !after.saved ? "bad" : "note") },
          h("span", { class: "mark" }, c.value === null ? "✗" : "↳"),
          h("span", {}, c.value === null ? `Couldn't save {{${c.name}}}` : after.saved ? `Saved {{${c.name}}}${c.secret ? " (secret)" : ""}` : `Not saved: {{${c.name}}}`),
          h("span", { class: "why" }, c.value === null ? c.why : after.saved ? (c.secret ? "" : c.value.length > 60 ? c.value.slice(0, 57) + "…" : c.value) : "Choose an environment at the top right first"))),
      ));
    } else if (this.view === "headers") {
      content.append(h("div", { class: "api-addr" }, h("span", {}, "Address"), h("code", {}, res.url)), h("div", { class: "api-headers" }, ...res.headers.flatMap(([k, v]) => [h("span", { class: "hk" }, k), h("span", { class: "hv" }, v)])));
    } else if (res.binary) {
      content.append(h("div", { class: "api-msg" }, h("div", {}, "This response isn't text, so it can't be shown here."), h("small", {}, `${res.headers.find(([k]) => k === "content-type")?.[1] ?? "Unknown type"} · ${fmtBytes(res.size)}`)));
    } else if (!res.body) {
      content.append(h("div", { class: "api-msg" }, "The response has no body."));
    } else {
      const shown = json && !this.raw ? json : res.body;
      const pre = h("pre", { class: "api-pre" + (this.wrap ? " wrap" : "") });
      if (json && !this.raw && shown.length < BIG_JSON) pre.append(highlightJson(shown));
      else pre.textContent = shown;
      content.append(pre);
      if (res.truncated) content.append(h("div", { class: "api-trunc" }, "The response is larger than 20 MB. Only the first part is shown."));
    }
    box.replaceChildren(status, content);
  }

  private responseMenu(): MenuEntries {
    const o = this.outcome;
    const res = o && "res" in o ? o.res : null;
    return [
      ...(res && !res.binary && res.body ? [{ label: "Copy body", action: () => void navigator.clipboard.writeText(this.view === "body" && !this.raw ? prettyJson(res.body) ?? res.body : res.body) }] : []),
      ...(res ? [{ label: "Copy headers", action: () => void navigator.clipboard.writeText(res.headers.map(([k, v]) => `${k}: ${v}`).join("\n")) }] : []),
      ...(res ? [{ label: "Wrap long lines", checked: this.wrap, action: () => { this.wrap = !this.wrap; this.renderResponse(); } }, null] : []),
      ...this.menuEntries(),
    ];
  }

  // ------------------------------------------------------------ saving, importing

  /** What the right-click menu (and the tab's own menu) offers. */
  menuEntries(): MenuEntries {
    return [
      { label: this.inflight ? "Cancel request" : "Send", hint: this.inflight ? "Esc" : "Ctrl+Enter", action: () => (this.inflight ? this.cancel() : void this.sendNow()) },
      { label: "Save", hint: "Ctrl+S", action: () => void this.save() },
      null,
      { label: "Copy as cURL", action: () => void navigator.clipboard.writeText(toCurl(this.req, this.host.settings())) },
      { label: "Environments…", action: () => void environmentsDialog(this.host.store, this.host.store.data.activeEnv).then(() => this.fillEnvs()) },
      { label: "Connection settings…", action: () => this.host.editConnection() },
      { label: "Show response beside the request", checked: this.el.querySelector(".api-split")?.classList.contains("side"), action: () => this.toggleLayout() },
    ];
  }

  async save(): Promise<boolean> {
    if (!this.req.name) {
      const guess = this.req.url ? `${this.req.method} ${requestLabel(this.req)}` : "";
      const typed = await promptText("Save request", "Name (write Folder/Name to file it in a folder)", guess);
      if (!typed) return false;
      const slash = typed.indexOf("/");
      if (slash > 0 && slash < typed.length - 1) {
        this.req.group = typed.slice(0, slash).trim();
        this.req.name = typed.slice(slash + 1).trim();
      } else this.req.name = typed;
    }
    await this.host.store.saveRequest(this.req);
    this.baseline = JSON.stringify(this.req);
    this.refreshHeader();
    return true;
  }

  private importCurl(text: string) {
    try {
      const r = fromCurl(text);
      r.url = stripBase(this.host.settings().baseUrl, r.url); // a full address on this connection becomes a short one
      r.params = paramsFromUrl(r.url, []);
      this.req = { ...r, id: this.req.id, name: this.req.name, group: this.req.group };
      this.section = this.req.bodyKind !== "none" ? "body" : this.req.headers.length ? "headers" : "params";
      this.syncFromRequest();
    } catch (e) {
      this.outcome = { error: String((e as Error).message ?? e) };
      this.renderResponse();
    }
  }

  // ------------------------------------------------------------ used by the connection tab

  /** The connection's settings changed (base address, sign-in, headers): refresh what shows them. */
  applyConnection() {
    this.refreshBase();
    if (this.section === "auth" || this.section === "headers") this.renderPanel();
  }

  /** Puts the cursor in the address box when there is nothing in it yet. */
  focusIfEmpty() {
    if (!this.url.value) this.url.focus();
  }

  get title(): string {
    return requestLabel(this.req);
  }

  /** Stops anything in flight and lets go of the shortcut handler. */
  dispose() {
    this.disposed = true;
    if (this.inflight) void api.httpCancel(this.inflight);
    this.unsubscribe();
    window.removeEventListener("keydown", this.onKey);
    this.el.remove();
  }
}
