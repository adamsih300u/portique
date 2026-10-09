/** Reading saved requests in from files: our own export, collection files (v2.x), OpenAPI/Swagger JSON, and curl commands. */

import { blankRequest, type ConnData, type Environment, fromCurl, type HttpRequest, looksLikeCurl, type Method, METHODS, type Pair, parseQuery, sanitizeRequest, withQuery } from "./http-model";

export const EXPORT_FORMAT = "portique-requests";

export interface Imported {
  requests: HttpRequest[];
  /** Environments the import wants (merged by name into existing ones). */
  envs: Environment[];
  /** Things that couldn't be brought across, in words. */
  skipped: string[];
  /** What kind of file it was: "export", "collection", "openapi" or "curl". */
  kind: string;
  /** The folder the requests went into. */
  folder: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" / ");

// ---------------------------------------------------------------- export

/** Everything worth keeping, as a file. Secret values are never in it (they live in the vault). */
export function exportData(data: ConnData): string {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    requests: data.requests,
    envs: data.envs.map((e) => ({ ...e, vars: e.vars.map((v) => ({ key: v.key, value: v.secret ? "" : v.value, secret: v.secret })) })),
  }, null, 2);
}

// ---------------------------------------------------------------- entry point

/** Works out what a file is and reads it. Throws a readable error if it is none of the known kinds. */
export function parseImport(text: string, fileName = ""): Imported {
  // eslint-disable-next-line no-irregular-whitespace -- strips a byte-order mark
  const t = text.replace(/^﻿/, "").trim();
  if (!t) throw new Error("The file is empty.");
  if (t.startsWith("{") || t.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch (e) {
      throw new Error(`The file isn't valid JSON (${(e as Error).message}).`);
    }
    if (isObj(json)) {
      if (json.format === EXPORT_FORMAT) return fromExport(json);
      if (isObj(json.info) && Array.isArray(json.item)) return fromCollection(json);
      if (typeof json.openapi === "string" || json.swagger === "2.0") return fromOpenApi(json);
    }
    throw new Error("This JSON isn't a file Portique knows: expected an export from here, a collection file (v2), or an OpenAPI/Swagger description.");
  }
  if (looksLikeCurl(t)) return fromCurlList(t, fileName);
  if (/^(openapi|swagger)\s*:/m.test(t)) throw new Error("This is a YAML API description, which can't be read yet. Convert it to JSON first (for example with an online converter) and import that.");
  throw new Error("This file isn't one Portique knows: expected JSON (an export, a collection or an OpenAPI description) or curl commands.");
}

// ---------------------------------------------------------------- our own export

function fromExport(j: Record<string, any>): Imported {
  const requests = (Array.isArray(j.requests) ? j.requests : []).map((r: any) => ({ ...sanitizeRequest(r), id: crypto.randomUUID() }));
  const envs: Environment[] = (Array.isArray(j.envs) ? j.envs : []).filter((e: any) => e && typeof e.name === "string").map((e: any) => ({
    id: crypto.randomUUID(),
    name: e.name,
    vars: (Array.isArray(e.vars) ? e.vars : []).map((v: any) => ({ key: str(v.key), value: v.secret ? "" : str(v.value), secret: v.secret === true })),
  }));
  const secrets = envs.reduce((n, e) => n + e.vars.filter((v) => v.secret).length, 0);
  return { requests, envs, kind: "export", folder: "", skipped: secrets ? [`${secrets} secret value${secrets === 1 ? "" : "s"} (they are never exported; enter them again under Environments)`] : [] };
}

// ---------------------------------------------------------------- collection files (v2.x)

function kv(list: unknown): Pair[] {
  return (Array.isArray(list) ? list : []).filter(isObj).map((p) => ({ key: str(p.key), value: str(p.value), on: p.disabled !== true }));
}

function fromCollection(j: Record<string, any>): Imported {
  const root = str(j.info.name) || "Imported collection";
  const requests: HttpRequest[] = [];
  const skipped: string[] = [];
  const note = (s: string) => { if (!skipped.includes(s)) skipped.push(s); };

  const walk = (items: any[], folder: string) => {
    for (const it of items) {
      if (!isObj(it)) continue;
      if (Array.isArray(it.item)) { walk(it.item, join(folder, str(it.name))); continue; }
      const q = it.request;
      if (!isObj(q)) continue;
      const r = blankRequest();
      r.name = str(it.name) || "Request";
      r.group = folder;
      const m = str(q.method).toUpperCase();
      r.method = (METHODS as readonly string[]).includes(m) ? (m as Method) : "GET";
      r.url = isObj(q.url) ? str(q.url.raw) : str(q.url);
      r.headers = kv(q.header);
      const b = q.body;
      if (isObj(b)) {
        if (b.mode === "raw") {
          r.bodyText = str(b.raw);
          const lang = b.options?.raw?.language;
          r.bodyKind = lang === "json" || (!lang && /^\s*[{[]/.test(r.bodyText)) ? "json" : "text";
          if (lang === "json") r.headers = r.headers.filter((h) => h.key.toLowerCase() !== "content-type" || !/json/i.test(h.value));
        } else if (b.mode === "urlencoded") {
          r.bodyKind = "form";
          r.form = kv(b.urlencoded);
        } else if (b.mode === "formdata" || b.mode === "file") note("file and multipart bodies");
        else if (b.mode === "graphql") note("GraphQL bodies");
      }
      const a = q.auth ?? it.auth;
      if (isObj(a)) {
        const get = (k: string) => str((Array.isArray(a[a.type]) ? a[a.type] : []).find((x: any) => x?.key === k)?.value);
        if (a.type === "bearer") r.auth = { ...r.auth, kind: "bearer", token: get("token") };
        else if (a.type === "basic") r.auth = { ...r.auth, kind: "basic", user: get("username"), pass: get("password") };
        else if (a.type === "apikey" && (get("in") || "header") === "header") r.auth = { ...r.auth, kind: "header", name: get("key"), value: get("value") };
        else if (a.type && a.type !== "noauth") note(`${a.type} sign-in (set up under Auth)`);
      }
      r.params = parseQuery(r.url);
      requests.push(r);
    }
  };
  walk(j.item, root);

  const vars = (Array.isArray(j.variable) ? j.variable : []).filter((v: any) => isObj(v) && v.key).map((v: any) => ({ key: str(v.key), value: str(v.value), secret: false }));
  const envs: Environment[] = vars.length ? [{ id: crypto.randomUUID(), name: root, vars }] : [];
  return { requests, envs, skipped, kind: "collection", folder: root };
}

// ---------------------------------------------------------------- OpenAPI / Swagger

function pathParams(path: string): string {
  return path.replace(/\{([^}]+)\}/g, "{{$1}}");
}

function sampleOf(schema: any, depth = 0): unknown {
  if (!isObj(schema) || depth > 4) return null;
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case "object": return Object.fromEntries(Object.entries(isObj(schema.properties) ? schema.properties : {}).map(([k, v]) => [k, sampleOf(v, depth + 1)]));
    case "array": return [sampleOf(schema.items, depth + 1)];
    case "integer": case "number": return 0;
    case "boolean": return false;
    case "string": return "";
    default: return isObj(schema.properties) ? sampleOf({ ...schema, type: "object" }, depth) : null;
  }
}

function fromOpenApi(j: Record<string, any>): Imported {
  const title = str(j.info?.title) || "API";
  const swagger2 = j.swagger === "2.0";
  const base = swagger2
    ? `${(Array.isArray(j.schemes) && j.schemes[0]) || "https"}://${str(j.host) || "localhost"}${str(j.basePath).replace(/\/$/, "")}`
    : str(Array.isArray(j.servers) && isObj(j.servers[0]) ? j.servers[0].url : "").replace(/\/$/, "") || "https://localhost";
  const schemes = isObj(j.components?.securitySchemes) ? j.components.securitySchemes : isObj(j.securityDefinitions) ? j.securityDefinitions : {};
  const requests: HttpRequest[] = [];
  const skipped: string[] = [];
  const vars = new Map<string, string>([["baseUrl", base]]);

  for (const [path, item] of Object.entries(isObj(j.paths) ? j.paths : {})) {
    if (!isObj(item)) continue;
    for (const [verb, op] of Object.entries(item)) {
      const method = verb.toUpperCase();
      if (!(METHODS as readonly string[]).includes(method) || !isObj(op)) continue;
      const r = blankRequest();
      r.method = method as Method;
      r.name = str(op.summary) || str(op.operationId) || `${method} ${path}`;
      r.group = join(title, Array.isArray(op.tags) ? str(op.tags[0]) : "");
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])].filter(isObj);
      const query: Pair[] = [];
      for (const p of params) {
        const sample = str(p.example ?? p.default ?? p.schema?.example ?? p.schema?.default ?? p.x_example ?? "");
        if (p.in === "path") vars.set(str(p.name), vars.get(str(p.name)) ?? sample);
        else if (p.in === "query") query.push({ key: str(p.name), value: sample, on: p.required === true });
        else if (p.in === "header") r.headers.push({ key: str(p.name), value: sample, on: p.required === true });
      }
      r.url = withQuery(`{{baseUrl}}${pathParams(path)}`, query);
      r.params = query;

      const content = isObj(op.requestBody) ? op.requestBody.content : undefined;
      const jsonType = isObj(content) ? Object.keys(content).find((k) => /json/i.test(k)) : undefined;
      if (jsonType) {
        const media = content[jsonType];
        const example = media.example ?? (isObj(media.examples) ? Object.values<any>(media.examples)[0]?.value : undefined) ?? sampleOf(media.schema);
        r.bodyKind = "json";
        r.bodyText = JSON.stringify(example ?? {}, null, 2);
      } else if (isObj(content)) {
        skipped.push("non-JSON request bodies");
      } else if (swagger2) {
        const body = params.find((p) => p.in === "body");
        if (body) { r.bodyKind = "json"; r.bodyText = JSON.stringify(sampleOf(body.schema) ?? {}, null, 2); }
      }

      const sec = Array.isArray(op.security) ? op.security : Array.isArray(j.security) ? j.security : [];
      const used = sec.flatMap((s: any) => (isObj(s) ? Object.keys(s) : [])).map((n: string) => schemes[n]).find(isObj);
      if (used) {
        if (used.type === "http" && /bearer/i.test(str(used.scheme))) { r.auth = { ...r.auth, kind: "bearer", token: "{{token}}" }; vars.set("token", vars.get("token") ?? ""); }
        else if (used.type === "http" && /basic/i.test(str(used.scheme))) r.auth = { ...r.auth, kind: "basic", user: "{{username}}", pass: "{{password}}" };
        else if (used.type === "apiKey" && used.in === "header") { r.auth = { ...r.auth, kind: "header", name: str(used.name), value: "{{apiKey}}" }; vars.set("apiKey", vars.get("apiKey") ?? ""); }
        else if (used.type === "oauth2" || used.type === "openIdConnect") skipped.push("OAuth sign-in settings (set up under Auth)");
      }
      requests.push(r);
    }
  }
  if (!requests.length) throw new Error("This API description has no operations to import.");
  const env: Environment = { id: crypto.randomUUID(), name: title, vars: [...vars].map(([key, value]) => ({ key, value, secret: key === "token" || key === "apiKey" || key === "password" })) };
  return { requests, envs: [env], skipped: [...new Set(skipped)], kind: "openapi", folder: title };
}

// ---------------------------------------------------------------- a list of curl commands

function fromCurlList(text: string, fileName: string): Imported {
  const parts = text.split(/^(?=\s*curl(?:\.exe)?\s)/im).map((s) => s.trim()).filter(Boolean);
  const requests: HttpRequest[] = [];
  const skipped: string[] = [];
  for (const p of parts) {
    try {
      const r = fromCurl(p);
      r.name = `${r.method} ${r.url.replace(/^[a-z]+:\/\//i, "").replace(/\?.*$/, "")}`.slice(0, 60);
      requests.push(r);
    } catch (e) {
      skipped.push(`a command that couldn't be read (${(e as Error).message})`);
    }
  }
  if (!requests.length) throw new Error("No curl commands could be read from the file.");
  const folder = fileName.replace(/\.[^.]*$/, "") || "Imported";
  for (const r of requests) r.group = folder;
  return { requests, envs: [], skipped, kind: "curl", folder };
}
