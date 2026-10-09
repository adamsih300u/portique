/** Checking a response, and picking values out of it. Pure functions, so they are easy to test. */

import type { Capture, Check } from "./http-model";

export interface ResponseView {
  status: number;
  headers: [string, string][];
  body: string;
}

/**
 * Parses JSON, keeping integers too large for a JavaScript number as exact digit strings
 * (so an id such as 12345678901234567890 is never silently rounded).
 */
export function parseJson(text: string): unknown {
  // One pass over the text: strings are skipped whole, and each number token is looked at on its own
  // (so digits after a decimal point or in an exponent are never mistaken for an integer).
  const safe = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (tok) =>
    /^-?\d{16,}$/.test(tok) && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok);
  return JSON.parse(safe);
}

/** Steps of a field path: `a.b[0]["c d"]`, optionally starting with `$`. */
function steps(path: string): (string | number)[] | null {
  const out: (string | number)[] = [];
  const p = path.trim().replace(/^\$\.?/, "");
  const re = /\.?([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/gy;
  let at = 0;
  while (at < p.length) {
    re.lastIndex = at;
    const m = re.exec(p);
    if (!m) return null;
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[4]).replace(/\\(.)/g, "$1"));
    at = re.lastIndex;
  }
  return out;
}

/** The value at `path` in parsed JSON; `found` is false if any step is missing. */
export function jsonField(data: unknown, path: string): { found: boolean; value: unknown } {
  const st = steps(path);
  if (!st) return { found: false, value: undefined };
  let cur: unknown = data;
  for (const s of st) {
    if (cur === null || typeof cur !== "object" || !(s in cur)) return { found: false, value: undefined };
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return { found: true, value: cur };
}

/** How a value is written out: text as it is, everything else as compact JSON. */
export function show(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

const header = (res: ResponseView, name: string) => res.headers.find(([k]) => k.toLowerCase() === name.trim().toLowerCase())?.[1];

function tryJson(res: ResponseView): unknown {
  try {
    return parseJson(res.body);
  } catch {
    return undefined;
  }
}

export interface CheckResult {
  pass: boolean;
  /** "Status is 200" */
  label: string;
  /** What was actually found, when it differs. */
  detail: string;
}

const OPS: Record<Check["op"], string> = { is: "is", isnt: "is not", contains: "contains", exists: "exists", lt: "is less than", gt: "is more than" };

export const checkSubject = (c: Pick<Check, "source" | "path">) =>
  c.source === "status" ? "Status" : c.source === "body" ? "Body" : c.source === "header" ? `Header ${c.path.trim() || "?"}` : `Field ${c.path.trim() || "?"}`;

export function describeCheck(c: Check): string {
  return `${checkSubject(c)} ${OPS[c.op]}${c.op === "exists" ? "" : ` ${c.value}`}`;
}

export function runChecks(checks: Check[], res: ResponseView): CheckResult[] {
  let json: unknown;
  let parsed = false;
  return checks.filter((c) => c.on).map((c) => {
    const label = describeCheck(c);
    let found = true;
    let actual: unknown;
    if (c.source === "status") actual = res.status;
    else if (c.source === "body") actual = res.body;
    else if (c.source === "header") {
      actual = header(res, c.path);
      found = actual !== undefined;
    } else {
      if (!parsed) { json = tryJson(res); parsed = true; }
      if (json === undefined) return { pass: false, label, detail: "The response isn't JSON" };
      const f = jsonField(json, c.path);
      found = f.found;
      actual = f.value;
    }
    if (c.op === "exists") return { pass: found, label, detail: found ? "" : "Not found" };
    if (!found) return { pass: false, label, detail: "Not found" };
    const text = show(actual);
    const want = c.value;
    let pass: boolean;
    switch (c.op) {
      case "is": pass = text === want || (want.trim() !== "" && Number(text) === Number(want) && !Number.isNaN(Number(want))); break;
      case "isnt": pass = !(text === want || (want.trim() !== "" && Number(text) === Number(want) && !Number.isNaN(Number(want)))); break;
      case "contains": pass = text.includes(want); break;
      case "lt": pass = Number(text) < Number(want); break;
      default: pass = Number(text) > Number(want);
    }
    const shown = text.length > 80 ? text.slice(0, 77) + "…" : text;
    return { pass, label, detail: pass ? "" : c.source === "body" ? "Not matching" : `Got ${shown === "" ? "nothing" : shown}` };
  });
}

export interface Captured {
  name: string;
  secret: boolean;
  /** null if the value wasn't there. */
  value: string | null;
  why: string;
}

export function runCaptures(captures: Capture[], res: ResponseView): Captured[] {
  let json: unknown;
  let parsed = false;
  return captures.filter((c) => c.on && c.name.trim()).map((c) => {
    const base = { name: c.name.trim(), secret: c.secret };
    if (c.source === "header") {
      const v = header(res, c.path);
      return v === undefined ? { ...base, value: null, why: `No header ${c.path.trim()}` } : { ...base, value: v, why: "" };
    }
    if (!parsed) { json = tryJson(res); parsed = true; }
    if (json === undefined) return { ...base, value: null, why: "The response isn't JSON" };
    const f = jsonField(json, c.path);
    return f.found ? { ...base, value: show(f.value), why: "" } : { ...base, value: null, why: `No field ${c.path.trim()}` };
  });
}
