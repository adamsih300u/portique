import { describe, expect, it } from "vitest";
import { parseQuickTarget, quickLabel } from "./quick-connect";

const p = (s: string) => parseQuickTarget(s);

describe("parseQuickTarget", () => {
  it("reads addresses and names", () => {
    expect(p("10.0.0.5")).toEqual({ protocol: "ssh", user: "", host: "10.0.0.5", port: 22, clear: true });
    expect(p("admin@db1.example.com:2222")).toEqual({ protocol: "ssh", user: "admin", host: "db1.example.com", port: 2222, clear: true });
    expect(p("telnet://switch.lan")).toMatchObject({ protocol: "telnet", host: "switch.lan", port: 23 });
    expect(p("[fe80::1]:2200")).toMatchObject({ host: "fe80::1", port: 2200, clear: true });
    expect(p("2001:db8::7")).toMatchObject({ host: "2001:db8::7", port: 22 });
  });

  it("marks a bare word as unclear so it is offered last", () => {
    expect(p("nas")).toMatchObject({ host: "nas", clear: false });
    expect(p("nas:2222")).toMatchObject({ clear: true });
  });

  it("rejects what is not a host", () => {
    for (const s of ["", "two words", "300.1.1.1", "123", "host:0", "host:70000", "host:", "@host", "a@b@", "-bad.com", "host/path", "[::1", "a:b:c"])
      expect(p(s), s).toBeNull();
  });

  it("labels a tab with the host, adding an unusual port", () => {
    expect(quickLabel(p("10.0.0.5")!)).toBe("10.0.0.5");
    expect(quickLabel(p("web:2222")!)).toBe("web:2222");
    expect(quickLabel(p("[::1]:2222")!)).toBe("[::1]:2222");
    expect(quickLabel(p("telnet://sw:23")!)).toBe("sw");
  });
});
