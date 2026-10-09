import { describe, expect, it } from "vitest";
import { clampWidth, parseState } from "./sidebar-layout";

describe("clampWidth", () => {
  it("never goes below the longest name", () => expect(clampWidth(100, 180, 1200)).toBe(180));
  it("never takes more than half the window", () => expect(clampWidth(900, 180, 1200)).toBe(600));
  it("lets the longest name win in a narrow window", () => expect(clampWidth(300, 400, 600)).toBe(400));
  it("keeps a width in range", () => expect(clampWidth(320, 180, 1200)).toBe(320));
});

describe("parseState", () => {
  it("reads a saved state", () => expect(parseState('{"collapsed":true,"width":300}')).toEqual({ collapsed: true, width: 300 }));
  it("falls back on junk", () => {
    expect(parseState(null)).toEqual({ collapsed: false, width: null });
    expect(parseState("not json")).toEqual({ collapsed: false, width: null });
    expect(parseState('{"collapsed":"yes","width":-5}')).toEqual({ collapsed: false, width: null });
  });
});
