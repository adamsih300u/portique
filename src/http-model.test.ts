import { describe, expect, it } from "vitest";
import {
  blankAuth,
  blankRequest,
  defaultApiSettings,
  fmtBytes,
  fmtMillis,
  fromCurl,
  looksLikeCurl,
  paramsFromUrl,
  parseQuery,
  prettyJson,
  mergeHeaders,
  resolveUrl,
  sanitizeApiSettings,
  sanitizeConn,
  sanitizeFile,
  sanitizeRequest,
  stripBase,
  splitUrl,
  toCurl,
  withQuery,
} from "./http-model";

describe("query string <-> params", () => {
  it("splits a URL around ? and keeps the fragment out of the query", () => {
    expect(splitUrl("https://x.test/a?b=1&c=2#top")).toEqual({ base: "https://x.test/a", query: "b=1&c=2", hash: "#top" });
    expect(splitUrl("https://x.test/a")).toEqual({ base: "https://x.test/a", query: null, hash: "" });
  });

  it("parses parameters without decoding them", () => {
    expect(parseQuery("/p?a=1&b&c=x%20y")).toEqual([
      { key: "a", value: "1", on: true },
      { key: "b", value: "", on: true },
      { key: "c", value: "x%20y", on: true },
    ]);
    expect(parseQuery("/p")).toEqual([]);
  });

  it("rewrites the query from enabled rows only", () => {
    const url = withQuery("/p?old=1#h", [
      { key: "a", value: "1", on: true },
      { key: "skip", value: "x", on: false },
    ]);
    expect(url).toBe("/p?a=1#h");
    expect(withQuery("/p?old=1", [])).toBe("/p");
  });

  it("keeps disabled rows when the URL is edited", () => {
    const prev = [{ key: "off", value: "1", on: false }];
    expect(paramsFromUrl("/p?a=1", prev)).toEqual([
      { key: "a", value: "1", on: true },
      { key: "off", value: "1", on: false },
    ]);
  });
});

describe("sanitizing saved data", () => {
  it("fills in missing request fields and rejects bad enum values", () => {
    const r = sanitizeRequest({ method: "NOPE" as never, bodyKind: "xml" as never, url: undefined });
    expect(r.method).toBe("GET");
    expect(r.bodyKind).toBe("none");
    expect(r.url).toBe("");
    expect(r.auth.kind).toBe("inherit");
  });

  it("normalises header rows", () => {
    const r = sanitizeRequest({ headers: [{ key: "A", value: "1" } as never, null as never] });
    expect(r.headers).toEqual([{ key: "A", value: "1", on: true }]);
  });

  it("survives garbage input", () => {
    expect(sanitizeConn(null)).toEqual({ requests: [], envs: [], activeEnv: "" });
    expect(sanitizeConn("nope")).toEqual({ requests: [], envs: [], activeEnv: "" });
  });

  it("keeps the secret flag only when it is exactly true", () => {
    const d = sanitizeConn({ envs: [{ name: "dev", vars: [{ key: "k", value: "v", secret: "yes" }, { key: "t", value: "v", secret: true }] }] });
    expect(d.envs[0]?.vars.map((v) => v.secret)).toEqual([false, true]);
  });

  it("applies connection defaults and never lets a connection inherit auth", () => {
    const s = sanitizeApiSettings({ baseUrl: " https://x.test ", timeout: -1, follow: undefined, auth: { kind: "inherit" } });
    expect(s.baseUrl).toBe("https://x.test");
    expect(s.timeout).toBe(30);
    expect(s.follow).toBe(true);
    expect(s.insecure).toBe(false);
    expect(s.auth.kind).toBe("none");
  });

  it("treats a pre-connections file as legacy data to migrate", () => {
    const { file, legacy } = sanitizeFile({ requests: [{ name: "old" }], envs: [] });
    expect(file.connections).toEqual({});
    expect(legacy?.requests[0]?.name).toBe("old");
    expect(sanitizeFile({ connections: {} }).legacy).toBeNull();
  });
});

describe("addresses and headers", () => {
  it("resolves a request address against the connection base", () => {
    expect(resolveUrl("https://x.test/v1/", "/users")).toBe("https://x.test/v1/users");
    expect(resolveUrl("https://x.test/v1", "?a=1")).toBe("https://x.test/v1?a=1");
    expect(resolveUrl("https://x.test/v1", "https://other.test/z")).toBe("https://other.test/z");
    expect(resolveUrl("https://x.test/v1", "{{host}}/z")).toBe("{{host}}/z");
    expect(resolveUrl("", "/users")).toBe("/users");
  });

  it("strips the base from a pasted full address", () => {
    expect(stripBase("https://x.test/v1", "https://x.test/v1/users?a=1")).toBe("/users?a=1");
    expect(stripBase("https://x.test/v1", "https://x.test/v10/users")).toBe("https://x.test/v10/users");
  });

  it("lets a request header override the connection's, ignoring case and disabled rows", () => {
    const merged = mergeHeaders(
      [{ key: "Accept", value: "a", on: true }, { key: "X-Off", value: "1", on: false }, { key: "X-Keep", value: "k", on: true }],
      [{ key: "accept", value: "b", on: true }],
    );
    expect(merged.map((h) => `${h.key}=${h.value}`)).toEqual(["X-Keep=k", "accept=b"]);
  });
});

describe("cURL", () => {
  it("round-trips a request through curl text", () => {
    const r = blankRequest();
    r.method = "POST";
    r.url = "https://x.test/api";
    r.headers = [{ key: "X-Id", value: "7", on: true }];
    r.bodyKind = "json";
    r.bodyText = `{"it's":"ok"}`;
    const back = fromCurl(toCurl(r));
    expect(back.method).toBe("POST");
    expect(back.url).toBe("https://x.test/api");
    expect(back.bodyText).toBe(`{"it's":"ok"}`);
    expect(back.headers.some((h) => h.key === "X-Id" && h.value === "7")).toBe(true);
  });

  it("folds in the connection's address, headers and sign-in", () => {
    const conn = { ...defaultApiSettings(), baseUrl: "https://x.test/v1", headers: [{ key: "X-Org", value: "7", on: true }], auth: blankAuth("bearer") };
    conn.auth.token = "{{token}}";
    const r = blankRequest();
    r.url = "/users";
    const curl = toCurl(r, conn);
    expect(curl).toContain("'https://x.test/v1/users'");
    expect(curl).toContain("'X-Org: 7'");
    expect(curl).toContain("Bearer {{token}}");
  });

  it("detects curl commands", () => {
    expect(looksLikeCurl("  curl https://x.test")).toBe(true);
    expect(looksLikeCurl("curl.exe https://x.test")).toBe(true);
    expect(looksLikeCurl("echo curl")).toBe(false);
  });

  it("throws a readable error when there is no URL", () => {
    expect(() => fromCurl("curl -X POST")).toThrow();
  });
});

describe("response formatting", () => {
  it("re-indents JSON without touching big numbers", () => {
    expect(prettyJson('{"a":12345678901234567890,"b":[],"c":{}}')).toBe('{\n  "a": 12345678901234567890,\n  "b": [],\n  "c": {}\n}');
  });

  it("returns null for non-JSON", () => {
    expect(prettyJson("<html>")).toBeNull();
    expect(prettyJson("")).toBeNull();
    expect(prettyJson("{broken")).toBeNull();
  });

  it("formats sizes and durations", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtMillis(250)).toBe("250 ms");
    expect(fmtMillis(1500)).toBe("1.50 s");
  });
});
