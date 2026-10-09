/** What a request is, and the pure helpers around it (query-string sync, cURL in and out). */

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export interface Pair {
  key: string;
  value: string;
  on: boolean;
}

export type BodyKind = "none" | "json" | "text" | "form";
export type AuthKind = "none" | "bearer" | "basic" | "header";

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
  auth: { kind: AuthKind; token: string; user: string; pass: string; name: string; value: string };
  insecure: boolean;
  follow: boolean;
  timeout: number;
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

export interface ApiData {
  requests: HttpRequest[];
  envs: Environment[];
  /** The environment requests run in ("" for none). */
  activeEnv: string;
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
    auth: { kind: "none", token: "", user: "", pass: "", name: "", value: "" },
    insecure: false,
    follow: true,
    timeout: 30,
  };
}

/** Fills in anything missing, so older or hand-edited files never break the UI. */
export function sanitizeRequest(raw: Partial<HttpRequest> | null | undefined): HttpRequest {
  const b = blankRequest();
  const r = { ...b, ...(raw ?? {}) };
  const pairs = (v: unknown): Pair[] =>
    Array.isArray(v) ? v.filter((p) => p && typeof p === "object").map((p) => ({ key: String(p.key ?? ""), value: String(p.value ?? ""), on: p.on !== false })) : [];
  return {
    ...r,
    id: String(r.id || b.id),
    name: String(r.name ?? ""),
    group: String(r.group ?? ""),
    method: (METHODS as readonly string[]).includes(r.method) ? r.method : "GET",
    url: String(r.url ?? ""),
    params: pairs(r.params),
    headers: pairs(r.headers),
    form: pairs(r.form),
    bodyText: String(r.bodyText ?? ""),
    bodyKind: ["none", "json", "text", "form"].includes(r.bodyKind) ? r.bodyKind : "none",
    auth: { ...b.auth, ...(r.auth ?? {}) },
    timeout: Number(r.timeout) > 0 ? Number(r.timeout) : 30,
    insecure: r.insecure === true,
    follow: r.follow !== false,
  };
}

export function sanitizeData(raw: unknown): ApiData {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ApiData>;
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

/** The request as a curl command. Variables stay as `{{name}}`, so secrets are never copied out. */
export function toCurl(r: HttpRequest): string {
  const parts = ["curl"];
  if (r.method !== "GET") parts.push("-X", r.method);
  parts.push(shq(r.url.trim()));
  for (const h of r.headers) if (h.on && h.key.trim()) parts.push("-H", shq(`${h.key.trim()}: ${h.value}`));
  if (r.bodyKind === "json" && !r.headers.some((h) => h.on && h.key.toLowerCase() === "content-type")) parts.push("-H", shq("Content-Type: application/json"));
  const a = r.auth;
  if (a.kind === "bearer" && a.token) parts.push("-H", shq(`Authorization: Bearer ${a.token}`));
  if (a.kind === "basic") parts.push("-u", shq(`${a.user}:${a.pass}`));
  if (a.kind === "header" && a.name) parts.push("-H", shq(`${a.name}: ${a.value}`));
  if (r.bodyKind === "json" || r.bodyKind === "text") parts.push("--data-raw", shq(r.bodyText));
  if (r.bodyKind === "form") for (const f of r.form) if (f.on && f.key) parts.push("--data-urlencode", shq(`${f.key}=${f.value}`));
  if (r.insecure) parts.push("-k");
  if (r.follow) parts.push("-L");
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
      case "-m": case "--max-time": if (Number(val) > 0) r.timeout = Math.ceil(Number(val)); break;
      case "--url": url = val ?? ""; break;
      case "-k": case "--insecure": r.insecure = true; break;
      case "-L": case "--location": r.follow = true; break;
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
  if (authIdx >= 0 && r.auth.kind === "none") {
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
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtMillis(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
