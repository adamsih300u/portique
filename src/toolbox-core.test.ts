import { describe, expect, it } from "vitest";
import {
  base64Decode, base64Encode, convertTime, cronNext, decodeJwt, describeCron, formatJson, formatPing, formatPorts, generatePassword, generateToken, generateUuid,
  hashText, hexDecode, hexEncode, parseCron, parsePing, parsePortCheck, parsePorts, parseWake, relative, splitHost, subnet, urlDecode, urlEncode,
} from "./toolbox-core";

describe("generators", () => {
  it("makes a password of the length asked, with every kind of character", () => {
    for (let i = 0; i < 50; i++) {
      const g = generatePassword("12");
      expect(g.copy).toHaveLength(12);
      expect(g.copy).toMatch(/[a-z]/);
      expect(g.copy).toMatch(/[A-Z]/);
      expect(g.copy).toMatch(/\d/);
      expect(g.copy).toMatch(/[^A-Za-z0-9]/);
    }
    expect(generatePassword("").copy).toHaveLength(20);
    expect(generatePassword("30 simple").copy).toMatch(/^[A-Za-z0-9]{30}$/);
    expect(() => generatePassword("4")).toThrow();
    expect(() => generatePassword("500")).toThrow();
  });

  it("makes different tokens and ids each time", () => {
    expect(generateToken().copy).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken().copy).not.toBe(generateToken().copy);
    expect(generateUuid().copy).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("encodings", () => {
  it("round-trips base64, including non-ASCII and URL-safe input", () => {
    expect(base64Encode("héllo, wörld ✓")).toBe("aMOpbGxvLCB3w7ZybGQg4pyT");
    expect(base64Decode("aMOpbGxvLCB3w7ZybGQg4pyT")).toBe("héllo, wörld ✓");
    expect(base64Decode("aGk_Pz8-")).toBe("hi???>"); // url-safe alphabet, no padding
    expect(base64Decode("aGVs\nbG8")).toBe("hello");
    expect(() => base64Decode("not base64!")).toThrow("base64");
    expect(() => base64Decode("a")).toThrow();
  });

  it("round-trips URL and hex encodings", () => {
    expect(urlEncode("a b&c=d/é")).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect(urlDecode("a%20b+c")).toBe("a b c");
    expect(() => urlDecode("%E0%A4%A")).toThrow();
    expect(hexEncode("Hi é")).toBe("486920c3a9");
    expect(hexDecode("48 69 20 c3:a9")).toBe("Hi é");
    expect(hexDecode("0x48,0x69")).toBe("Hi");
    expect(() => hexDecode("4")).toThrow("even");
    expect(() => hexDecode("zz")).toThrow();
  });
});

describe("hashes, JSON and tokens", () => {
  it("hashes text", async () => {
    const out = await hashText("abc");
    expect(out).toContain("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(out).toContain("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("formats, minifies and rejects JSON", () => {
    expect(formatJson('{"a":[1,2],"b":{"c":null}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}');
    expect(formatJson('{ "a": 1,\n "b": 2 }', true)).toBe('{"a":1,"b":2}');
    expect(() => formatJson("{a:1}")).toThrow("valid JSON");
  });

  it("reads a token's parts and times", () => {
    const part = (o: object) => base64Encode(JSON.stringify(o)).replace(/=+$/, "");
    const now = Date.UTC(2026, 0, 1);
    const jwt = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "adam", exp: now / 1000 - 3600 })}.sig`;
    const out = decodeJwt(`Bearer ${jwt}`, now);
    expect(out).toContain('"sub": "adam"');
    expect(out).toContain("1 hour ago");
    expect(out).toContain("Expired");
    expect(out).toContain("not checked");
    expect(() => decodeJwt("abc")).toThrow("parts");
    expect(() => decodeJwt("a.b")).toThrow("JSON");
  });
});

describe("time", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);

  it("describes the distance from now", () => {
    expect(relative(now - 30_000, now)).toBe("30 seconds ago");
    expect(relative(now + 3 * 3600_000, now)).toBe("in 3 hours");
    expect(relative(now - 86400_000, now)).toBe("1 day ago");
    expect(relative(now, now)).toBe("now");
  });

  it("reads seconds, milliseconds and dates", () => {
    const secs = convertTime("1760000000", now);
    expect(secs).toContain("2025-10-09T08:53:20.000Z");
    expect(convertTime("1760000000000", now)).toContain("2025-10-09T08:53:20.000Z");
    expect(convertTime("2026-10-09T12:00:00Z", now)).toContain("Unix        1791547200 seconds");
    expect(convertTime("", now)).toContain("Relative    now");
    expect(() => convertTime("next tuesday-ish", now)).toThrow();
  });
});

describe("cron", () => {
  const at = (...a: [number, number, number, number, number]) => new Date(a[0], a[1], a[2], a[3], a[4]);
  const text = (e: string) => describeCron(parseCron(e));

  it("describes common schedules", () => {
    expect(text("30 9 * * *")).toBe("At 09:30, every day.");
    expect(text("*/15 * * * *")).toBe("Every 15 minutes, every day.");
    expect(text("0 0 1 * *")).toBe("At 00:00, on day 1 of the month.");
    expect(text("0 8 * * mon-fri")).toBe("At 08:00, on Monday, Tuesday, Wednesday, Thursday and Friday.");
    expect(text("@hourly")).toBe("At minute 0 of every hour, every day.");
    expect(text("0 0 1 jan *")).toBe("At 00:00, on day 1 of the month, in January.");
  });

  it("rejects what is not an expression", () => {
    for (const e of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1/x * * * *"]) expect(() => parseCron(e), e).toThrow();
  });

  it("finds the next runs", () => {
    const from = at(2026, 9, 9, 12, 0); // Friday 9 Oct 2026
    const next = (e: string, n = 3) => cronNext(parseCron(e), from, n).map((d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`);
    expect(next("*/20 * * * *")).toEqual(["10/9 12:20", "10/9 12:40", "10/9 13:00"]);
    expect(next("30 9 * * *")).toEqual(["10/10 9:30", "10/11 9:30", "10/12 9:30"]);
    expect(next("0 8 * * mon-fri")).toEqual(["10/12 8:00", "10/13 8:00", "10/14 8:00"]); // skips the weekend
    expect(next("0 0 29 2 *", 1)).toEqual(["2/29 0:00"]); // 2028
    expect(next("0 0 31 * *", 2)).toEqual(["10/31 0:00", "12/31 0:00"]); // months without a 31st are skipped
  });

  it("matches either day field when both are restricted", () => {
    const from = at(2026, 9, 9, 12, 0);
    const days = cronNext(parseCron("0 0 13 * fri"), from, 3).map((d) => d.getDate());
    expect(days).toEqual([13, 16, 23]); // the 13th, and every Friday
  });
});

describe("subnet", () => {
  it("works out a /24", () => {
    const out = subnet("192.168.1.10/24");
    expect(out).toContain("Network      192.168.1.0/24");
    expect(out).toContain("Netmask      255.255.255.0");
    expect(out).toContain("Wildcard     0.0.0.255");
    expect(out).toContain("Broadcast    192.168.1.255");
    expect(out).toContain("192.168.1.1 – 192.168.1.254");
    expect(out).toContain("Hosts        254");
    expect(out).toContain("private");
  });

  it("handles masks, small and large prefixes", () => {
    expect(subnet("10.20.30.40 255.255.0.0")).toContain("Network      10.20.0.0/16");
    expect(subnet("8.8.8.8/32")).toContain("Hosts        1");
    expect(subnet("10.0.0.0/31")).toContain("Hosts        2");
    expect(subnet("172.16.5.4/12")).toContain("Network      172.16.0.0/12");
    expect(subnet("1.2.3.4/0")).toContain("Netmask      0.0.0.0");
    expect(subnet("100.64.1.1/10")).toContain("CGNAT");
  });

  it("rejects bad input", () => {
    for (const s of ["", "10.0.0.1", "10.0.0.256/24", "10.0.0.1/33", "10.0.0.1 255.0.255.0", "::1/64"]) expect(() => subnet(s), s).toThrow();
  });
});

describe("network input", () => {
  it("reads ports and ranges", () => {
    expect(parsePorts("22, 80  8000-8002")).toEqual([22, 80, 8000, 8001, 8002]);
    expect(parsePorts("80 80")).toEqual([80]);
    expect(parsePorts("")).toEqual([]);
    for (const s of ["0", "65536", "9-1", "http", "1-100"]) expect(() => parsePorts(s), s).toThrow();
  });

  it("splits hosts from ports and URLs", () => {
    expect(splitHost("example.com")).toEqual({ host: "example.com" });
    expect(splitHost("example.com:8443")).toEqual({ host: "example.com", port: 8443 });
    expect(splitHost("[::1]:22")).toEqual({ host: "::1", port: 22 });
    expect(splitHost("2001:db8::1")).toEqual({ host: "2001:db8::1" });
    expect(splitHost("https://user@example.com/path?q=1")).toEqual({ host: "example.com", port: 443 });
    expect(splitHost("ssh://10.0.0.1:2222")).toEqual({ host: "10.0.0.1", port: 2222 });
  });

  it("reads the port check", () => {
    expect(parsePortCheck("nas 22 443")).toEqual({ host: "nas", ports: [22, 443], common: false });
    expect(parsePortCheck("nas:5432")).toEqual({ host: "nas", ports: [5432], common: false });
    expect(parsePortCheck("https://nas")).toMatchObject({ ports: [443] });
    expect(parsePortCheck("nas")).toMatchObject({ common: true });
    expect(() => parsePortCheck("  ")).toThrow();
  });

  it("reads the ping", () => {
    expect(parsePing("nas 22")).toEqual({ host: "nas", port: 22, count: 4 });
    expect(parsePing("nas 22 10")).toEqual({ host: "nas", port: 22, count: 10 });
    expect(parsePing("nas:22 3")).toEqual({ host: "nas", port: 22, count: 3 });
    for (const s of ["", "nas", "nas 0", "nas 70000", "nas 22 0", "nas 22 99", "nas 22 x", "nas:22 3 4"]) expect(() => parsePing(s), s).toThrow();
  });

  it("reads the wake request", () => {
    expect(parseWake("aa:bb:cc:dd:ee:ff")).toEqual({ mac: "aa:bb:cc:dd:ee:ff", broadcast: "" });
    expect(parseWake("aa:bb:cc:dd:ee:ff 192.168.1.255")).toMatchObject({ broadcast: "192.168.1.255" });
    expect(() => parseWake("")).toThrow();
    expect(() => parseWake("a b c")).toThrow();
  });

  it("formats the results", () => {
    const r = [
      { port: 22, open: true, ms: 12.34, note: "" },
      { port: 81, open: false, ms: null, note: "refused" },
    ];
    const out = formatPorts("nas", "10.0.0.5", r);
    expect(out).toContain("nas (10.0.0.5)");
    expect(out).toMatch(/22\s+open\s+12\.3 ms\s+ssh/);
    expect(out).toMatch(/81\s+closed\s+refused/);
    expect(out).toContain("1 of 2 open");
    expect(formatPorts("10.0.0.5", "10.0.0.5", [{ port: 80, open: false, ms: null, note: "timed out" }])).toContain("firewall");

    const ping = formatPing("nas", 22, "10.0.0.5", [r[0], { port: 22, open: false, ms: null, note: "timed out" }, { port: 22, open: true, ms: 7.66, note: "" }]);
    expect(ping).toContain("3 tried, 2 connected, 33% failed");
    expect(ping).toContain("min 7.7 ms, avg 10.0 ms, max 12.3 ms");
    expect(formatPing("h", 1, "h", [{ port: 1, open: false, ms: null, note: "refused" }])).toContain("no reply");
  });
});
