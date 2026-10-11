import { describe, expect, it } from "vitest";
import { fillPlaceholders, placeholders, sanitizeCommands } from "./saved-commands";

describe("sanitizeCommands", () => {
  it("keeps usable commands and fills in what is missing", () => {
    const out = sanitizeCommands([{ id: "a", name: " Logs ", text: "tail -f /var/log/syslog", mode: "paste" }, { text: "uptime" }]);
    expect(out[0]).toEqual({ id: "a", name: "Logs", text: "tail -f /var/log/syslog", mode: "paste" });
    expect(out[1]).toMatchObject({ name: "uptime", mode: "run" });
    expect(out[1].id).toBeTruthy();
  });

  it("drops the unusable", () => {
    expect(sanitizeCommands(null)).toEqual([]);
    expect(sanitizeCommands("x")).toEqual([]);
    expect(sanitizeCommands([null, 3, { text: "  " }, { name: "n" }])).toEqual([]);
  });
});

describe("placeholders", () => {
  it("lists each name once, in order, and fills them", () => {
    const t = "ping -c {{count}} {{host}} && echo {{ host }} {{count}}";
    expect(placeholders(t)).toEqual(["count", "host"]);
    expect(fillPlaceholders(t, { count: "3", host: "a.lan" })).toBe("ping -c 3 a.lan && echo a.lan 3");
  });

  it("leaves unknown names and shell braces alone", () => {
    expect(fillPlaceholders("echo {{x}} ${HOME} {a}", {})).toBe("echo {{x}} ${HOME} {a}");
    expect(placeholders("echo ${HOME} {{1bad}}")).toEqual([]);
  });
});
