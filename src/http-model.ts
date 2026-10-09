/** What a request is, and the pure helpers around it (query-string sync, cURL in and out). */

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export interface Pair {
  key: string;
  value: string;
  on: boolean;
}

export type BodyKind = "none" | "json" | "text" | "form";
/** `inherit` (requests only) means: use the connection's sign-in. */
export type AuthKind = "inherit" | "none" | "bearer" | "basic" | "header" | "oauth2";

export interface AuthSettings {
  kind: AuthKind;
  token: string;
  user: string;
  pass: string;
  name: string;
  value: string;
  /** OAuth 2.0 client credentials. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export function blankAuth(kind: AuthKind = "none"): AuthSettings {
  return { kind, token: "", user: "", pass: "", name: "", value: "", tokenUrl: "", clientId: "", clientSecret: "", scope: "" };
}

function sanitizeAuth(raw: unknown, fallback: AuthKind): AuthSettings {
  const a = (raw && typeof raw === "object" ? raw : {}) as Partial<AuthSettings>;
  const b = blankAuth(fallback);
  const text = (k: keyof AuthSettings) => String(a[k] ?? b[k]);
  return {
    kind: (["inherit", "none", "bearer", "basic", "header", "oauth2"].includes(String(a.kind)) ? a.kind : fallback) as AuthKind,
    token: text("token"), user: text("user"), pass: text("pass"), name: text("name"), value: text("value"),
    tokenUrl: text("tokenUrl"), clientId: text("clientId"), clientSecret: text("clientSecret"), scope: text("scope"),
  };
}

/**
 * What an API connection (a profile of type "api") holds: where it points, how it signs in by default,
 * which headers every request carries, and how requests are sent.
 */
export interface ApiSettings {
  /** The endpoint, e.g. `https://api.example.com/v1`. Requests are written relative to it. May contain `{{variables}}`. */
  baseUrl: string;
  /** Id of an SSH profile to send through ("" for this computer). */
  via: string;
  auth: AuthSettings;
  headers: Pair[];
  insecure: boolean;
  follow: boolean;
  timeout: number;
}

export function defaultApiSettings(): ApiSettings {
  return { baseUrl: "", via: "", auth: blankAuth("none"), headers: [], insecure: false, follow: true, timeout: 30 };
}

export function sanitizeApiSettings(raw: unknown): ApiSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ApiSettings>;
  const d = defaultApiSettings();
  const auth = sanitizeAuth(o.auth, "none");
  if (auth.kind === "inherit") auth.kind = "none";
  return {
    baseUrl: String(o.baseUrl ?? "").trim(),
    via: String(o.via ?? ""),
    auth,
    headers: sanitizePairs(o.headers),
    insecure: o.insecure === true,
    follow: o.follow !== false,
    timeout: Number(o.timeout) > 0 ? Number(o.timeout) : d.timeout,
  };
}

function sanitizePairs(v: unknown): Pair[] {
  return Array.isArray(v) ? v.filter((p) => p && typeof p === "object").map((p) => ({ key: String(p.key ?? ""), value: String(p.value ?? ""), on: p.on !== false })) : [];
}

/** One thing to verify about the response. */
export interface Check {
  on: boolean;
  source: "status" | "header" | "json" | "body";
  /** The header name or JSON field (`user.name`, `items[0].id`); unused for status and body. */
  path: string;
  op: "is" | "isnt" | "contains" | "exists" | "lt" | "gt";
  value: string;
}

/** A value to take from the response and keep in the active environment as `{{name}}`. */
export interface Capture {
  on: boolean;
  source: "json" | "header";
  path: string;
  name: string;
  /** Keep it in the vault (for tokens) rather than in the environment file. */
  secret: boolean;
}

export interface HttpRequest {
  id: string;
  name: string;
  /** Folder in the sidebar ("" for none). */
  group: string;
  method: Method;
  url: string;
  /** The query parameters, including disabled ones; the enabled ones are also in `url`. */
  params: Pair[];
  headers: Pair[];
  bodyKind: BodyKind;
  bodyText: string;
  form: Pair[];
  auth: AuthSettings;
  checks: Check[];
  captures: Capture[];
}

export interface EnvVar {
  key: string;
  /** Empty for secrets: those are only in the vault. */
  value: string;
  secret: boolean;
}

export interface Environment {
  id: string;
  name: string;
  vars: EnvVar[];
}

/** Everything one API connection owns besides its settings (those are in the profile). */
export interface ConnData {
  requests: HttpRequest[];
  envs: Environment[];
  /** The environment requests run in ("" for none). */
  activeEnv: string;
}

/** The saved file: one entry per API connection, keyed by the connection's profile id. */
export interface ApiFile {
  version: 2;
  connections: Record<string, ConnData>;
}

export function blankRequest(): HttpRequest {
  return {
    id: crypto.randomUUID(),
    name: "",
    group: "",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    bodyKind: "none",
    bodyText: "",
    form: [],
    auth: blankAuth("inherit"),
    checks: [],
    captures: [],
  };
}

/** Fills in anything missing, so older or hand-edited files never break the UI. */
export function sanitizeRequest(raw: Partial<HttpRequest> | null | undefined): HttpRequest {
  const b = blankRequest();
  const r = { ...b, ...(raw ?? {}) } as HttpRequest;
  return {
    id: String(r.id || b.id),
    name: String(r.name ?? ""),
    group: String(r.group ?? ""),
    method: (METHODS as readonly string[]).includes(r.method) ? r.method : "GET",
    url: String(r.url ?? ""),
    params: sanitizePairs(r.params),
    headers: sanitizePairs(r.headers),
    form: sanitizePairs(r.form),
    bodyText: String(r.bodyText ?? ""),
    bodyKind: ["none", "json", "text", "form"].includes(r.bodyKind) ? r.bodyKind : "none",
    // Requests written before connections existed had "none" as their default: that means "use the connection's" now.
    auth: sanitizeAuth(r.auth, "inherit"),
    checks: (Array.isArray(r.checks) ? r.checks : []).filter((c) => c && typeof c === "object").map((c) => ({
      on: c.on !== false,
      source: (["status", "header", "json", "body"].includes(c.source) ? c.source : "status") as Check["source"],
      path: String(c.path ?? ""),
      op: (["is", "isnt", "contains", "exists", "lt", "gt"].includes(c.op) ? c.op : "is") as Check["op"],
      value: String(c.value ?? ""),
    })),
    captures: (Array.isArray(r.captures) ? r.captures : []).filter((c) => c && typeof c === "object").map((c) => ({
      on: c.on !== false,
      source: (c.source === "header" ? "header" : "json") as Capture["source"],
      path: String(c.path ?? ""),
      name: String(c.name ?? ""),
      secret: c.secret === true,
    })),
  };
}

export function sanitizeConn(raw: unknown): ConnData {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ConnData>;
  return {
    requests: (Array.isArray(o.requests) ? o.requests : []).map(sanitizeRequest),
    envs: (Array.isArray(o.envs) ? o.envs : [])
      .filter((e) => e && typeof e.name === "string")
      .map((e) => ({
        id: String(e.id || crypto.randomUUID()),
        name: e.name,
        vars: (Array.isArray(e.vars) ? e.vars : []).map((v) => ({ key: String(v.key ?? ""), value: String(v.value ?? ""), secret: v.secret === true })),
      })),
    activeEnv: typeof o.activeEnv === "string" ? o.activeEnv : "",
  };
}

/**
 * Reads the saved file. `legacy` is set for files from before connections existed (one global list of
 * requests and environments): the caller moves it into a connection of its own.
 */
export function sanitizeFile(raw: unknown): { file: ApiFile; legacy: ConnData | null } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const connections: Record<string, ConnData> = {};
  if (o.connections && typeof o.connections === "object") {
    for (const [id, c] of Object.entries(o.connections)) connections[id] = sanitizeConn(c);
  }
  const old = Array.isArray(o.requests) || Array.isArray(o.envs) ? sanitizeConn(o) : null;
  return { file: { version: 2, connections }, legacy: old && (old.requests.length || old.envs.length) ? old : null };
}

// ---------------------------------------------------------------- addresses and headers

/** True for `https://…`, and for an address that starts with a variable (which may hold a whole address). */
export const isAbsoluteUrl = (url: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) || url.trim().startsWith("{{");

/** The address a request really goes to: its own if it is complete, otherwise the connection's base followed by it. */
export function resolveUrl(base: string, url: string): string {
  const u = url.trim();
  const b = base.trim();
  if (!b || isAbsoluteUrl(u)) return u;
  if (!u) return b;
  if (u.startsWith("?") || u.startsWith("#")) return b + u;
  return b.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

/** The part of `url` after the connection's base address, if it starts with it (so a pasted full address becomes a short one). */
export function stripBase(base: string, url: string): string {
  const b = base.trim().replace(/\/+$/, "");
  const u = url.trim();
  if (!b || !u.toLowerCase().startsWith(b.toLowerCase())) return url;
  const rest = u.slice(b.length);
  return rest === "" || /^[/?#]/.test(rest) ? rest || "/" : url;
}

/** The connection's headers followed by the request's, the request's winning when both set one. */
export function mergeHeaders(conn: Pair[], req: Pair[]): Pair[] {
  const mine = new Set(req.filter((h) => h.on && h.key.trim()).map((h) => h.key.trim().toLowerCase()));
  return [...conn.filter((h) => h.on && h.key.trim() && !mine.has(h.key.trim().toLowerCase())), ...req.filter((h) => h.on && h.key.trim())];
}

// ---------------------------------------------------------------- query string <-> params table

/** Splits a URL at its `?` (and keeps any `#fragment` with the base, out of the query). */
export function splitUrl(url: string): { base: string; query: string | null; hash: string } {
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const q = head.indexOf("?");
  return q < 0 ? { base: head, query: null, hash } : { base: head.slice(0, q), query: head.slice(q + 1), hash };
}

/** The enabled parameters in a URL's query string, undecoded (what you typed is what is sent). */
export function parseQuery(url: string): Pair[] {
  const { query } = splitUrl(url);
  if (!query) return [];
  return query.split("&").filter((s) => s !== "").map((s) => {
    const i = s.indexOf("=");
    return i < 0 ? { key: s, value: "", on: true } : { key: s.slice(0, i), value: s.slice(i + 1), on: true };
  });
}

/** Rewrites the URL's query string from the enabled rows of the table. */
export function withQuery(url: string, params: Pair[]): string {
  const { base, hash } = splitUrl(url);
  const q = params.filter((p) => p.on && (p.key !== "" || p.value !== "")).map((p) => `${p.key}=${p.value}`);
  return base + (q.length ? "?" + q.join("&") : "") + hash;
}

/** After the URL was edited: take its parameters, but keep the disabled rows the table already had. */
export function paramsFromUrl(url: string, previous: Pair[]): Pair[] {
  return [...parseQuery(url), ...previous.filter((p) => !p.on)];
}

// ---------------------------------------------------------------- cURL

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The request as a curl command, with the connection's address, headers and sign-in folded in. Variables stay as `{{name}}`, so secrets are never copied out. */
export function toCurl(r: HttpRequest, conn: ApiSettings = defaultApiSettings()): string {
  const parts = ["curl"];
  if (r.method !== "GET") parts.push("-X", r.method);
  parts.push(shq(resolveUrl(conn.baseUrl, r.url)));
  const headers = mergeHeaders(conn.headers, r.headers);
  for (const h of headers) parts.push("-H", shq(`${h.key.trim()}: ${h.value}`));
  if (r.bodyKind === "json" && !headers.some((h) => h.key.toLowerCase() === "content-type")) parts.push("-H", shq("Content-Type: application/json"));
  const a = r.auth.kind === "inherit" ? conn.auth : r.auth;
  if (a.kind === "bearer" && a.token) parts.push("-H", shq(`Authorization: Bearer ${a.token}`));
  if (a.kind === "basic") parts.push("-u", shq(`${a.user}:${a.pass}`));
  if (a.kind === "header" && a.name) parts.push("-H", shq(`${a.name}: ${a.value}`));
  if (r.bodyKind === "json" || r.bodyKind === "text") parts.push("--data-raw", shq(r.bodyText));
  if (r.bodyKind === "form") for (const f of r.form) if (f.on && f.key) parts.push("--data-urlencode", shq(`${f.key}=${f.value}`));
  if (conn.insecure) parts.push("-k");
  if (conn.follow) parts.push("-L");
  return parts.join(" ");
}

/** Splits a shell command line into words (quotes, backslash escapes, line continuations). */
function shellWords(src: string): string[] {
  const s = src.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").trim();
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, j < 0 ? s.length : j);
      i = j < 0 ? s.length : j;
      has = true;
    } else if (c === '"') {
      i++;
      for (; i < s.length && s[i] !== '"'; i++) cur += s[i] === "\\" && '"\\$`'.includes(s[i + 1] ?? "") ? s[++i] : s[i];
      has = true;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2; // $'…' with escapes
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === "\\") {
          const n = s[++i];
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else cur += s[i];
      }
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** True if pasted text looks like a curl command. */
export const looksLikeCurl = (text: string) => /^\s*curl(\.exe)?\s/i.test(text);

/** Reads a curl command into a request. Throws a readable error if there is no URL in it. */
export function fromCurl(text: string): HttpRequest {
  const w = shellWords(text);
  if (!/^curl(\.exe)?$/i.test(w[0] ?? "")) throw new Error("That isn't a curl command.");
  const r = blankRequest();
  let method = "";
  let url = "";
  const data: string[] = [];
  const urlencoded: string[] = [];
  let getMode = false;
  const takes = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "-u", "--user", "--url", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-m", "--max-time", "--connect-timeout", "-o", "--output", "-F", "--form", "--json", "--oauth2-bearer"]);
  for (let i = 1; i < w.length; i++) {
    let a = w[i];
    let val: string | undefined;
    if (a.startsWith("--") && a.includes("=")) [a, val] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    else if (/^-[A-Za-z]./.test(a) && takes.has(a.slice(0, 2))) [a, val] = [a.slice(0, 2), a.slice(2)]; // -XPOST, -H'x: y'
    if (val === undefined && takes.has(a)) val = w[++i] ?? "";
    switch (a) {
      case "-X": case "--request": method = (val ?? "").toUpperCase(); break;
      case "-H": case "--header": {
        const at = (val ?? "").indexOf(":");
        if (at > 0) r.headers.push({ key: val!.slice(0, at).trim(), value: val!.slice(at + 1).trim(), on: true });
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": data.push(val ?? ""); break;
      case "--json": data.push(val ?? ""); r.headers.push({ key: "Content-Type", value: "application/json", on: true }); break;
      case "--data-urlencode": urlencoded.push(val ?? ""); break;
      case "-u": case "--user": { const at = (val ?? "").indexOf(":"); r.auth = { ...r.auth, kind: "basic", user: at < 0 ? val! : val!.slice(0, at), pass: at < 0 ? "" : val!.slice(at + 1) }; break; }
      case "--oauth2-bearer": r.auth = { ...r.auth, kind: "bearer", token: val ?? "" }; break;
      case "-A": case "--user-agent": r.headers.push({ key: "User-Agent", value: val ?? "", on: true }); break;
      case "-e": case "--referer": r.headers.push({ key: "Referer", value: val ?? "", on: true }); break;
      case "-b": case "--cookie": r.headers.push({ key: "Cookie", value: val ?? "", on: true }); break;
      case "-m": case "--max-time": break; // timeouts belong to the connection
      case "--url": url = val ?? ""; break;
      case "-k": case "--insecure": case "-L": case "--location": break; // these belong to the connection's settings
      case "-G": case "--get": getMode = true; break;
      case "-I": case "--head": method = method || "HEAD"; break;
      default:
        if (!a.startsWith("-") && !url) url = a;
    }
  }
  if (!url) throw new Error("There's no URL in that curl command.");
  r.url = url;
  // A bearer token written as a header is clearer in the Auth tab.
  const authIdx = r.headers.findIndex((h) => h.key.toLowerCase() === "authorization" && /^bearer\s+/i.test(h.value));
  if (authIdx >= 0 && r.auth.kind === "inherit") {
    r.auth = { ...r.auth, kind: "bearer", token: r.headers[authIdx].value.replace(/^bearer\s+/i, "") };
    r.headers.splice(authIdx, 1);
  }
  if (getMode && (data.length || urlencoded.length)) {
    const extra = [...data, ...urlencoded].join("&");
    r.url += (r.url.includes("?") ? "&" : "?") + extra;
  } else if (urlencoded.length || (data.length && /application\/x-www-form-urlencoded/i.test(r.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? ""))) {
    r.bodyKind = "form";
    r.form = [...data, ...urlencoded].join("&").split("&").filter(Boolean).map((s) => {
      const i = s.indexOf("=");
      return { key: i < 0 ? s : s.slice(0, i), value: i < 0 ? "" : s.slice(i + 1), on: true };
    });
    r.headers = r.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  } else if (data.length) {
    r.bodyText = data.join("&");
    const ct = r.headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";
    const isJson = /json/i.test(ct) || (!ct && /^\s*[{[]/.test(r.bodyText));
    r.bodyKind = isJson ? "json" : "text";
    if (/^application\/json\s*$/i.test(ct)) r.headers = r.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  }
  r.method = (METHODS as readonly string[]).includes(method) ? (method as Method) : data.length || urlencoded.length ? (getMode ? "GET" : "POST") : "GET";
  r.params = parseQuery(r.url);
  return r;
}

// ---------------------------------------------------------------- showing responses

/**
 * Re-indents JSON text without parsing the numbers, so very large integers and
 * exact decimals come out exactly as the server sent them. Returns null if it isn't JSON.
 */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t || !/^[{["\-\d tfn]/.test(t)) return null;
  try {
    JSON.parse(t);
  } catch {
    return null;
  }
  let out = "";
  let depth = 0;
  const nl = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      while (t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (/\s/.test(t[j])) j++;
      if (t[j] === (c === "{" ? "}" : "]")) { out += c + t[j]; i = j; } // keep empty containers on one line
      else { depth++; out += c + nl(); }
    } else if (c === "}" || c === "]") {
      depth--;
      out += nl() + c;
    } else if (c === ",") out += "," + nl();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}

export const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtMillis(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
