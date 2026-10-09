// The Toolbox's logic, with no interface in it so it can be tested: generators, converters and the text shown for the network checks.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- randomness

/** A uniform integer in [0, max), without modulo bias. */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

const SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  symbol: "!@#$%^&*()-_=+[]{};:,.?/",
};

export interface Generated {
  /** What the person sees. */
  text: string;
  /** What "Copy" puts on the clipboard, when that is only part of the text. */
  copy?: string;
}

/** `20` or `24 simple` (letters and digits only). At least one character of each kind is always present. */
export function generatePassword(spec: string): Generated {
  const words = spec.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const simple = words.includes("simple");
  const num = words.find((w) => /^\d+$/.test(w));
  const length = num ? Number(num) : 20;
  if (length < 8 || length > 128) throw new Error("Choose a length from 8 to 128");
  const kinds = simple ? [SETS.lower, SETS.upper, SETS.digit] : Object.values(SETS);
  const pool = kinds.join("");
  const chars = kinds.map((k) => k[randomInt(k.length)]);
  while (chars.length < length) chars.push(pool[randomInt(pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const password = chars.join("");
  const bits = Math.floor(length * Math.log2(pool.length));
  return { text: `${password}\n\n${length} characters from ${pool.length}, about ${bits} bits`, copy: password };
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** 32 random bytes as hex and as URL-safe base64. */
export function generateToken(): Generated {
  const b = randomBytes(32);
  const hex = toHex(b);
  return { text: `${hex}\n${base64UrlOf(b)}\n\n256 bits, shown as hex and as URL-safe base64`, copy: hex };
}

export function generateUuid(): Generated {
  const id = crypto.randomUUID();
  return { text: id, copy: id };
}

// ---------------------------------------------------------------- encodings

function binary(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export const base64Of = (b: Uint8Array) => btoa(binary(b));
const base64UrlOf = (b: Uint8Array) => base64Of(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const base64Encode = (s: string) => base64Of(enc.encode(s));

/** Plain or URL-safe base64, with or without padding and line breaks. */
export function base64Bytes(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) throw new Error("That isn't base64");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const base64Decode = (s: string) => dec.decode(base64Bytes(s));

export function urlEncode(s: string): string {
  return encodeURIComponent(s);
}

export function urlDecode(s: string): string {
  try {
    return decodeURIComponent(s.trim().replace(/\+/g, " "));
  } catch {
    throw new Error("That isn't a valid percent-encoded string");
  }
}

export const hexEncode = (s: string) => toHex(enc.encode(s));

export function hexDecode(s: string): string {
  const t = s.replace(/0x/gi, "").replace(/[\s:,-]+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(t)) throw new Error("That isn't hex");
  if (t.length % 2) throw new Error("Hex needs an even number of digits");
  return dec.decode(Uint8Array.from(t.match(/../g) ?? [], (x) => parseInt(x, 16)));
}

// ---------------------------------------------------------------- hashes, JSON, JWT

export async function hashText(s: string): Promise<string> {
  const data = enc.encode(s);
  const lines: string[] = [];
  for (const algo of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
    lines.push(`${algo.padEnd(8)} ${toHex(new Uint8Array(await crypto.subtle.digest(algo, data)))}`);
  }
  return lines.join("\n");
}

export function formatJson(s: string, minify = false): string {
  try {
    return JSON.stringify(JSON.parse(s), null, minify ? 0 : 2);
  } catch (e) {
    throw new Error(`That isn't valid JSON: ${(e as Error).message}`);
  }
}

export function decodeJwt(s: string, now = Date.now()): string {
  const parts = s.trim().replace(/^bearer\s+/i, "").split(".");
  if (parts.length < 2 || parts.length > 3) throw new Error("A token has two or three parts separated by dots");
  const json = (part: string) => {
    try {
      return JSON.parse(base64Decode(part)) as Record<string, unknown>;
    } catch {
      throw new Error("The token's header or payload isn't base64-encoded JSON");
    }
  };
  const header = json(parts[0]);
  const payload = json(parts[1]);
  const out = [`Header\n${JSON.stringify(header, null, 2)}`, `Payload\n${JSON.stringify(payload, null, 2)}`];
  const times = (["iat", "nbf", "exp"] as const)
    .filter((k) => typeof payload[k] === "number")
    .map((k) => `${k}  ${new Date((payload[k] as number) * 1000).toISOString()}  (${relative((payload[k] as number) * 1000, now)})`);
  if (times.length) out.push(times.join("\n"));
  const exp = payload.exp;
  if (typeof exp === "number") out.push(exp * 1000 < now ? "Expired" : "Not expired");
  out.push(parts[2] ? "The signature is present but not checked here." : "No signature.");
  return out.join("\n\n");
}

// ---------------------------------------------------------------- time

/** "3 days ago", "in 2 hours". */
export function relative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const a = Math.abs(d) / 1000;
  const [n, unit] = a < 60 ? [Math.round(a), "second"] : a < 3600 ? [Math.round(a / 60), "minute"] : a < 86400 ? [Math.round(a / 3600), "hour"] : a < 86400 * 60 ? [Math.round(a / 86400), "day"] : a < 86400 * 730 ? [Math.round(a / (86400 * 30.44)), "month"] : [Math.round(a / (86400 * 365.25)), "year"];
  const span = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return n === 0 ? "now" : d < 0 ? `${span} ago` : `in ${span}`;
}

/** A Unix time (seconds or milliseconds) or a date, in several readings. Empty means now. */
export function convertTime(input: string, now = Date.now()): string {
  const s = input.trim();
  let ms: number;
  if (!s) ms = now;
  else if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    ms = Math.abs(n) >= 1e11 ? n : n * 1000; // 1e11 seconds is the year 5138; 1e11 ms is 1973
  } else {
    ms = Date.parse(s);
    if (Number.isNaN(ms)) throw new Error("Enter a Unix time (seconds or milliseconds) or a date like 2026-10-09 14:30");
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("That time is out of range");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    `UTC         ${d.toISOString()}`,
    `Local       ${d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}${tz ? ` (${tz})` : ""}`,
    `Unix        ${Math.floor(ms / 1000)} seconds`,
    `            ${Math.floor(ms)} milliseconds`,
    `Relative    ${relative(ms, now)}`,
  ].join("\n");
}

// ---------------------------------------------------------------- cron

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MACROS: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };

export interface Cron {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** The fields as written, for the description. */
  text: string[];
  /** When both day fields are restricted a day matches either one; a field starting with `*` doesn't restrict. */
  domStar: boolean;
  dowStar: boolean;
}

function field(text: string, min: number, max: number, names: string[], offset: number, what: string): number[] {
  const out = new Set<number>();
  const value = (v: string) => {
    const i = names.indexOf(v.toLowerCase());
    const n = i >= 0 ? i + offset : /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isNaN(n) || n < min || n > max) throw new Error(`"${v}" isn't a valid ${what}`);
    return n;
  };
  for (const part of text.split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined || (step !== undefined && !/^\d+$/.test(step)) || Number(step) === 0) throw new Error(`"${part}" isn't a valid ${what} step`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b, c] = range.split("-");
      if (c !== undefined) throw new Error(`"${range}" isn't a valid ${what} range`);
      [lo, hi] = [value(a), value(b)];
      if (lo > hi) throw new Error(`"${range}" runs backwards`);
    } else {
      lo = value(range);
      hi = step === undefined ? lo : max;
    }
    for (let n = lo; n <= hi; n += step === undefined ? 1 : Number(step)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): Cron {
  const e = expr.trim().replace(/\s+/g, " ");
  const parts = (MACROS[e.toLowerCase()] ?? e).split(" ");
  if (parts.length !== 5) throw new Error("A cron expression has five fields: minute hour day-of-month month day-of-week");
  const dow = field(parts[4], 0, 7, DAYS, 0, "day of the week").map((d) => d % 7);
  return {
    minute: field(parts[0], 0, 59, [], 0, "minute"),
    hour: field(parts[1], 0, 23, [], 0, "hour"),
    dom: field(parts[2], 1, 31, [], 0, "day of the month"),
    month: field(parts[3], 1, 12, MONTHS, 1, "month"),
    dow: [...new Set(dow)].sort((a, b) => a - b),
    text: parts,
    domStar: parts[2].startsWith("*"),
    dowStar: parts[4].startsWith("*"),
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.month.includes(d.getMonth() + 1)) return false;
  const inDom = c.dom.includes(d.getDate());
  const inDow = c.dow.includes(d.getDay());
  return c.domStar || c.dowStar ? inDom && inDow : inDom || inDow;
}

/** The next `n` times the expression fires after `from`, in local time. */
export function cronNext(c: Cron, from: Date, n: number): Date[] {
  const out: Date[] = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const stop = from.getTime() + 8 * 366 * 86400_000; // far enough for a 29 February
  while (out.length < n && d.getTime() < stop) {
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.includes(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.includes(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      out.push(new Date(d));
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    }
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A sentence for the usual shapes; the next run times shown beside it cover the rest. */
export function describeCron(c: Cron): string {
  const [mi, ho, dm, mo, dw] = c.text;
  let when: string;
  if (c.minute.length === 1 && c.hour.length === 1) when = `At ${two(c.hour[0])}:${two(c.minute[0])}`;
  else if (mi === "*" && ho === "*") when = "Every minute";
  else if (/^\*\/\d+$/.test(mi) && ho === "*") when = `Every ${mi.slice(2)} minutes`;
  else if (c.minute.length === 1 && ho === "*") when = `At minute ${c.minute[0]} of every hour`;
  else if (/^\*\/\d+$/.test(ho) && c.minute.length === 1) when = `At minute ${c.minute[0]}, every ${ho.slice(2)} hours`;
  else when = `At minute ${list(c.minute.map(String))}, hour ${list(c.hour.map(String))}`;
  const where: string[] = [];
  if (dm !== "*") where.push(`on day ${list(c.dom.map(String))} of the month`);
  if (dw !== "*") where.push(`on ${list(c.dow.map((d) => DAY_NAMES[d]))}`);
  if (mo !== "*") where.push(`in ${list(c.month.map((m) => MONTH_NAMES[m - 1]))}`);
  if (dm !== "*" && dw !== "*" && !c.domStar && !c.dowStar) where.splice(0, 2, `on day ${list(c.dom.map(String))} of the month or ${list(c.dow.map((d) => DAY_NAMES[d]))}`);
  return `${when}${where.length ? `, ${where.join(", ")}` : ", every day"}.`;
}

export function explainCron(expr: string, now = new Date()): string {
  const c = parseCron(expr);
  const runs = cronNext(c, now, 5);
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return [describeCron(c), "", runs.length ? `Next runs (this computer's time)\n${runs.map((d) => `  ${fmt(d)}  (${relative(d.getTime(), now.getTime())})`).join("\n")}` : "It never runs (no date matches)."].join("\n");
}

// ---------------------------------------------------------------- subnets

function ipv4(s: string): number {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new Error(`"${s}" isn't an IPv4 address`);
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

const dotted = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** `192.168.1.10/24`, or an address and a mask (`192.168.1.10 255.255.255.0`). IPv4 only. */
export function subnet(input: string): string {
  const m = /^\s*(\S+?)\s*(?:\/\s*(\d{1,2})|\s+(\d+\.\d+\.\d+\.\d+))\s*$/.exec(input);
  if (!m) throw new Error("Enter an address and a prefix, like 192.168.1.10/24, or an address and a mask");
  const ip = ipv4(m[1]);
  let bits: number;
  if (m[2] !== undefined) bits = Number(m[2]);
  else {
    const mask = ipv4(m[3]);
    const ones = (mask >>> 0).toString(2).padStart(32, "0");
    if (!/^1*0*$/.test(ones)) throw new Error(`${m[3]} isn't a valid netmask`);
    bits = ones.indexOf("0") < 0 ? 32 : ones.indexOf("0");
  }
  if (bits > 32) throw new Error("A prefix is 0 to 32");
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  const bcast = (net | ~mask) >>> 0;
  const total = 2 ** (32 - bits);
  const hosts = bits >= 31 ? total : total - 2;
  const range = bits === 32 ? dotted(net) : bits === 31 ? `${dotted(net)} – ${dotted(bcast)}` : `${dotted(net + 1)} – ${dotted(bcast - 1)}`;
  const kind = ip >>> 24 === 10 || (ip >>> 20) === 0xac1 || ip >>> 16 === 0xc0a8 ? "private (RFC 1918)" : ip >>> 24 === 127 ? "loopback" : ip >>> 16 === 0xa9fe ? "link-local" : ip >>> 22 === 0x191 ? "shared (CGNAT)" : "";
  return [
    `Network      ${dotted(net)}/${bits}`,
    `Netmask      ${dotted(mask)}`,
    `Wildcard     ${dotted(~mask >>> 0)}`,
    `Broadcast    ${bits >= 31 ? "none" : dotted(bcast)}`,
    `Usable       ${range}`,
    `Hosts        ${hosts.toLocaleString()}`,
    kind ? `Kind         ${kind}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- network checks

export interface PortResult {
  port: number;
  open: boolean;
  ms: number | null;
  note: string;
}

const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995, 3306, 3389, 5432, 8080];
const SERVICES: Record<number, string> = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 110: "pop3", 143: "imap", 443: "https", 445: "smb", 465: "smtps",
  587: "submission", 993: "imaps", 995: "pop3s", 1433: "mssql", 3000: "dev server", 3306: "mysql", 3389: "rdp", 5432: "postgres", 5900: "vnc",
  6379: "redis", 8080: "http alt", 8443: "https alt", 9200: "elasticsearch", 27017: "mongodb",
};
const SCHEMES: Record<string, number> = { http: 80, https: 443, ssh: 22, ftp: 21, telnet: 23, smtp: 25, imap: 143, imaps: 993, rdp: 3389, postgres: 5432, postgresql: 5432, mysql: 3306, redis: 6379 };

export const MAX_PORTS = 64;

/** "22, 80, 8000-8010" as a list of ports, in the order given. */
export function parsePorts(spec: string): number[] {
  const out: number[] = [];
  for (const tok of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) throw new Error(`"${tok}" isn't a port`);
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a < 1 || b > 65535 || a > b) throw new Error(`"${tok}" isn't a valid port or range (1 to 65535)`);
    for (let p = a; p <= b; p++) if (!out.includes(p)) out.push(p);
    if (out.length > MAX_PORTS) throw new Error(`Check at most ${MAX_PORTS} ports at a time`);
  }
  return out;
}

/** A host from `host`, `host:port`, `[v6]:port` or a URL; the port, if the text carried one. */
export function splitHost(tok: string): { host: string; port?: number } {
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(tok);
  if (url) {
    const inner = splitHost(url[2].replace(/^[^@]*@/, ""));
    return { host: inner.host, port: inner.port ?? SCHEMES[url[1].toLowerCase()] };
  }
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(tok);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : undefined };
  const hp = /^([^:]+):(\d+)$/.exec(tok);
  if (hp) return { host: hp[1], port: Number(hp[2]) };
  return { host: tok };
}

/** `example.com 22 80 443`, `example.com:443` or a URL. With no port, the common ones are tried. */
export function parsePortCheck(input: string): { host: string; ports: number[]; common: boolean } {
  const [first, ...rest] = input.trim().split(/\s+/);
  if (!first) throw new Error("Enter a host name or address, then the ports to try");
  const { host, port } = splitHost(first);
  const ports = parsePorts([...(port ? [String(port)] : []), ...rest].join(" "));
  return ports.length ? { host, ports, common: false } : { host, ports: COMMON_PORTS, common: true };
}

/** `example.com 443 [count]`, `example.com:443` or a URL. */
export function parsePing(input: string): { host: string; port: number; count: number } {
  const [first, ...rest] = input.trim().split(/\s+/).filter(Boolean);
  if (!first) throw new Error("Enter a host name or address and a port");
  const { host, port: inline } = splitHost(first);
  const nums = rest.map((r) => (/^\d+$/.test(r) ? Number(r) : NaN));
  if (nums.some(Number.isNaN) || nums.length > (inline ? 1 : 2)) throw new Error("Use: host port [count]");
  const port = inline ?? nums.shift();
  if (!port || port > 65535) throw new Error("Enter a port from 1 to 65535");
  const count = nums[0] ?? 4;
  if (count < 1 || count > 20) throw new Error("Ping 1 to 20 times");
  return { host, port, count };
}

/** `aa:bb:cc:dd:ee:ff` and, optionally, the network's broadcast address. */
export function parseWake(input: string): { mac: string; broadcast: string } {
  const [mac, broadcast = "", extra] = input.trim().split(/\s+/);
  if (!mac || extra !== undefined) throw new Error("Enter a MAC address, and optionally a broadcast address like 192.168.1.255");
  return { mac, broadcast };
}

const dot = (ms: number) => `${ms.toFixed(1)} ms`;

export function formatPorts(host: string, address: string, results: PortResult[], common = false): string {
  const open = results.filter((r) => r.open).length;
  const head = `${host}${address !== host ? ` (${address})` : ""}`;
  const rows = results.map((r) => `  ${String(r.port).padEnd(6)}${(r.open ? "open" : "closed").padEnd(8)}${(r.open && r.ms !== null ? dot(r.ms) : r.note).padEnd(12)}${SERVICES[r.port] ?? ""}`.trimEnd());
  return [head, "", ...rows, "", `${open} of ${results.length} open${common ? " (the usual suspects; name ports to check others)" : ""}`, ...(open === 0 && results.every((r) => r.note === "timed out") ? ["Everything timed out: the host may be down or a firewall is dropping the traffic."] : [])].join("\n");
}

export function formatPing(host: string, port: number, address: string, results: PortResult[]): string {
  const times = results.filter((r) => r.open && r.ms !== null).map((r) => r.ms as number);
  const lines = results.map((r, i) => (r.open ? `  ${i + 1}  connected  time=${dot(r.ms ?? 0)}` : `  ${i + 1}  ${r.note}`));
  const lost = results.length - times.length;
  const summary = times.length
    ? `min ${dot(Math.min(...times))}, avg ${dot(times.reduce((a, b) => a + b, 0) / times.length)}, max ${dot(Math.max(...times))}`
    : "no reply";
  return [`${host}${address !== host ? ` (${address})` : ""} port ${port}`, "", ...lines, "", `${results.length} tried, ${times.length} connected, ${Math.round((lost / results.length) * 100)}% failed`, summary].join("\n");
}
