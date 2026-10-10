import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "./api";
import { activityLine, controllerBadge, endpointNote, isTerminalReply, MODE_CHOICES, modeMenuLabel, questionCopy } from "./agent-core";

const q = (kind: AgentQuestion["kind"], text: string, over: Partial<AgentQuestion> = {}): AgentQuestion =>
  ({ id: "1", kind, client: "an-agent", profile: "web1", session: "s", text, password: false, confirm: true, ...over });

describe("questions that ask for the master password", () => {
  it("are plain questions when no password is wanted", () => {
    expect(questionCopy(q("command", "ls")).needsPassword).toBe(false);
  });

  it("with only a password to enter, offer just Deny and Allow", () => {
    const c = questionCopy(q("command", "uptime", { password: true, confirm: false }));
    expect(c.needsPassword).toBe(true);
    expect(c.title).toBe("Unlock this terminal for an agent?");
    expect(c.buttons.map((b) => [b.label, b.decision])).toEqual([["Deny", "deny"], ["Allow", "once"]]);
    expect(c.note).toMatch(/until the vault locks/);
    expect(c.code).toBe("uptime");
  });

  it("with a question and a password together, keep every answer and say the password is needed once", () => {
    const c = questionCopy(q("command", "uptime", { password: true, confirm: true }));
    expect(c.needsPassword).toBe(true);
    expect(c.buttons.map((b) => b.decision)).toEqual(["deny", "once", "session"]);
    expect(c.note).toMatch(/needed once for this session/);
    expect(c.title).toBe("Run this command?");
  });

  it("still explain the symbols in typed input", () => {
    expect(questionCopy(q("input", "q⏎", { password: true, confirm: false })).note).toContain("⏎ is Enter");
  });

  it("keep Deny first and the only safe button", () => {
    const [first, ...rest] = questionCopy(q("command", "x", { password: true, confirm: false })).buttons;
    expect(first).toMatchObject({ decision: "deny", safe: true });
    expect(rest.every((b) => !b.safe)).toBe(true);
  });
});

describe("questionCopy", () => {
  it("shows a command exactly as given and names who asks and where", () => {
    const c = questionCopy(q("command", "rm -rf /tmp/build && ls"));
    expect(c.code).toBe("rm -rf /tmp/build && ls");
    expect(c.lead).toBe("an-agent wants to run this in web1:");
    expect(c.title).toBe("Run this command?");
  });

  it("always lists the refusal first, and marks it as the safe one", () => {
    for (const kind of ["open", "command", "input"] as const) {
      const [first, ...rest] = questionCopy(q(kind, "x")).buttons;
      expect(first).toMatchObject({ decision: "deny", safe: true });
      expect(rest.every((b) => !b.safe && b.decision !== "deny")).toBe(true);
      expect(rest.map((b) => b.decision)).toEqual(["once", "session"]);
    }
  });

  it("explains what each answer to an open means", () => {
    const labels = questionCopy(q("open", "web1 (10.0.0.5:22)")).buttons.map((b) => b.label);
    expect(labels[1]).toMatch(/ask me for each step/i);
    expect(labels[2]).toMatch(/don't ask again/i);
  });

  it("explains the symbols in typed input", () => {
    const c = questionCopy(q("input", "ls⏎"));
    expect(c.note).toContain("⏎");
    expect(c.title).toBe("Let an agent type this?");
  });

  it("falls back to a plain name when the agent gave none", () => {
    expect(questionCopy({ ...q("command", "ls"), client: "" }).lead).toBe("An agent wants to run this in web1:");
  });
});

describe("long commands", () => {
  it("say how long they are, so a hidden tail is not a surprise", () => {
    const short = questionCopy(q("command", "ls"));
    expect(short.note).toBe("");
    const long = questionCopy(q("command", `echo ${"a".repeat(2000)}`));
    expect(long.note).toContain("2,005 characters");
    expect(long.note).toContain("scroll");
    expect(questionCopy(q("input", "x".repeat(700))).note).toContain("⏎ is Enter");
  });
});

describe("isTerminalReply", () => {
  it("knows the terminal's own answers", () => {
    for (const r of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;40R", "\x1b[?12;40R", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b[8;24;80t", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1bP>|xterm\x1b\\"]) {
      expect(isTerminalReply(r), JSON.stringify(r)).toBe(true);
    }
  });
  it("treats everything a person does as input", () => {
    for (const k of ["a", "\r", "ls -l\r", "\x03", "\x1b", "\x1b[A", "\x1b[3~", "\x1b[200~pasted\x1b[201~", "日本語", "\x1b[<0;10;5M", "text\x1b[I"]) {
      expect(isTerminalReply(k), JSON.stringify(k)).toBe(false);
    }
  });
});

describe("modes", () => {
  it("lists off, ask and allow, safest first", () => {
    expect(MODE_CHOICES.map((m) => m.mode)).toEqual(["off", "ask", "allow"]);
  });
  it("says the current access in the menu", () => {
    expect(modeMenuLabel("off")).toBe("Agent access…");
    expect(modeMenuLabel("ask")).toContain("asks first");
    expect(modeMenuLabel("allow")).toContain("allowed");
  });
});

describe("controllerBadge", () => {
  it("tells whose terminal it is", () => {
    expect(controllerBadge("agent", "a").text).toBe("agent");
    expect(controllerBadge("user", "a").text).toBe("you");
    expect(controllerBadge("user", "").tip).toContain("the agent is paused");
  });
});

describe("activityLine", () => {
  const at = new Date(2026, 9, 10, 14, 5, 9).getTime();
  it("reads as a sentence", () => {
    const line = activityLine({ at, client: "a", profile: "web1", session: "s", action: "run", text: "uptime", outcome: "exit 0" }, new Date(at));
    expect(line).toMatch(/a ran on web1: uptime \(exit 0\)$/);
  });
  it("words the other actions plainly", () => {
    const line = (action: string, text = "", outcome = "") => activityLine({ at, client: "Zed", profile: "web1", session: "s", action, text, outcome }, new Date(at)).replace(/^\S+\s+\S*\s*/, "");
    expect(activityLine({ at, client: "Zed", profile: "web1", session: "s", action: "open", text: "web1 (h:22)", outcome: "opened" }, new Date(at))).toMatch(/Zed opened a terminal on web1$/);
    expect(line("took-control")).toContain("You took over web1; Zed is paused");
    expect(line("handed-back")).toContain("You handed web1 back to Zed");
    expect(line("refused", "run: reboot", "the user declined")).toContain("Zed was refused on web1: run: reboot");
    expect(line("input", "q⏎")).toContain("Zed typed on web1: q⏎");
  });
  it("keeps a long or multi-line command to one line", () => {
    const line = activityLine({ at, client: "a", profile: "p", session: "s", action: "run", text: `a\n\n${"b".repeat(400)}`, outcome: "" }, new Date(at));
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(260);
  });
  it("names an action it does not know as it is", () => {
    expect(activityLine({ at, client: "", profile: "p", session: "s", action: "frobnicate", text: "", outcome: "" }, new Date(at))).toContain("agent frobnicate on p");
  });
});

describe("endpointNote", () => {
  it("is plain about being off", () => {
    expect(endpointNote(false, null)).toMatch(/no agent can reach/i);
    expect(endpointNote(true, "http://127.0.0.1:5/mcp")).toContain("this computer only");
    expect(endpointNote(true, null)).toBe("Starting…");
  });
});
