import { describe, expect, it } from "vitest";
import { encodeSecrets } from "./secret-ipc";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("encodeSecrets", () => {
  // The same bytes are pinned in src-tauri/src/ipc.rs, so a change to either side fails a test.
  it("writes a 4-byte little-endian length before each UTF-8 secret", () => {
    expect(hex(encodeSecrets(["ab", "é", ""]))).toBe("02000000" + "6162" + "02000000" + "c3a9" + "00000000");
  });

  it("encodes nothing as no bytes", () => {
    expect(encodeSecrets([]).length).toBe(0);
  });

  it("measures length in bytes, not characters", () => {
    const body = encodeSecrets(["日本語"]);
    expect(new DataView(body.buffer).getUint32(0, true)).toBe(9);
    expect(body.length).toBe(13);
  });
});
