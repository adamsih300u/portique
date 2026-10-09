/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KeyInfo } from "./api";
import { formatInstallKey, installKeyUnix, keyComment, pickKey, planInstallKey } from "./server-keys-core";

const key = (name: string, id = name): KeyInfo => ({ id, name, algorithm: "ssh-ed25519", fingerprint: `SHA256:fp-${name}`, encrypted: false });
const KEYS = [key("laptop"), key("work laptop"), key("deploy")];
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPortiqueTestKeyDataOnlyNotARealKeyAAAAAAAAAAAAAAAAAA";

describe("choosing a key", () => {
  it("takes a name, or a start or part of one when that is unambiguous", () => {
    expect(pickKey(KEYS, "laptop").id).toBe("laptop"); // exact beats "work laptop"
    expect(pickKey(KEYS, " DEPLOY ").id).toBe("deploy");
    expect(pickKey(KEYS, "dep").id).toBe("deploy");
    expect(pickKey(KEYS, "work").id).toBe("work laptop");
    expect(pickKey(KEYS, "ploy").id).toBe("deploy");
  });

  it("says what the choices are when it can't decide", () => {
    expect(pickKey(KEYS, "lap").id).toBe("laptop"); // a prefix that fits one key wins over a part of another name
    expect(() => pickKey([key("deploy-a"), key("deploy-b")], "deploy")).toThrow("More than one key matches: deploy-a, deploy-b");
    expect(() => pickKey(KEYS, "nope")).toThrow('No key called "nope". In the vault: laptop, work laptop, deploy');
    expect(() => pickKey(KEYS, "")).toThrow("In the vault: laptop");
    expect(() => pickKey([], "x")).toThrow("no keys yet");
  });

  it("describes what will happen", () => {
    const plan = planInstallKey(key("laptop"));
    expect(plan).toContain('public key of "laptop" (ssh-ed25519, SHA256:fp-laptop)');
    expect(plan).toContain("authorized_keys");
    expect(plan).toContain("private key stays in the vault");
  });

  it("makes a comment that is safe in a file and a shell", () => {
    expect(keyComment("work laptop")).toBe("portique:work-laptop");
    expect(keyComment("it's; rm -rf /")).toBe("portique:it-s-rm--rf");
    expect(keyComment("***")).toBe("portique:key");
    expect(keyComment("x".repeat(100))).toBe(`portique:${"x".repeat(40)}`);
  });
});

describe("the key script", () => {
  it("refuses anything that isn't a public key", () => {
    for (const bad of ["", "ssh-ed25519", "ssh-ed25519 AAAA; rm -rf /", "ssh-ed25519 AAAA'x", "ssh-ed25519 AAAA\nssh-rsa BBBB", "-----BEGIN OPENSSH PRIVATE KEY-----", "ssh-dss AAAA", `${PUB} comment`])
      expect(() => installKeyUnix(bad, "k"), bad).toThrow("isn't a public key");
  });

  const home = () => mkdtempSync(join(tmpdir(), "portique-home-"));
  const run = (script: string, h: string) => execFileSync("/bin/sh", [], { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: h } });
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

  describe.skipIf(process.platform === "win32")("under sh with a temporary home folder", () => {
    it("creates the folder and file with tight modes, adds the key once, and says so", () => {
      const h = home();
      const script = installKeyUnix(PUB, "work laptop");
      const first = formatInstallKey(run(script, h), "work laptop");
      expect(first).toMatch(/^Added "work laptop" to .*\.ssh\/authorized_keys \(1 key there now\)\./);
      expect(first).toContain("Keep the saved password");
      expect(mode(join(h, ".ssh"))).toBe("700");
      expect(mode(join(h, ".ssh/authorized_keys"))).toBe("600");
      expect(readFileSync(join(h, ".ssh/authorized_keys"), "utf8")).toBe(`${PUB} portique:work-laptop\n`);
      const second = formatInstallKey(run(script, h), "work laptop");
      expect(second).toContain("is already in");
      expect(readFileSync(join(h, ".ssh/authorized_keys"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    });

    it("keeps other keys as they are, even when the file doesn't end with a newline", () => {
      const h = home();
      mkdirSync(join(h, ".ssh"), { mode: 0o755 });
      writeFileSync(join(h, ".ssh/authorized_keys"), "ssh-rsa OTHERKEY mine@host\n# a comment\nssh-ed25519 ANOTHER noeol", { mode: 0o644 });
      const out = formatInstallKey(run(installKeyUnix(PUB, "laptop"), h), "laptop");
      expect(out).toContain("(4 keys there now)"); // counts non-empty lines, comments included
      expect(readFileSync(join(h, ".ssh/authorized_keys"), "utf8")).toBe(`ssh-rsa OTHERKEY mine@host\n# a comment\nssh-ed25519 ANOTHER noeol\n${PUB} portique:laptop\n`);
      expect(mode(join(h, ".ssh"))).toBe("700"); // tightened
      expect(mode(join(h, ".ssh/authorized_keys"))).toBe("600");
    });

    it("recognises the key under another comment, and doesn't add it twice", () => {
      const h = home();
      mkdirSync(join(h, ".ssh"));
      writeFileSync(join(h, ".ssh/authorized_keys"), `${PUB} adam@elsewhere\n`);
      expect(formatInstallKey(run(installKeyUnix(PUB, "laptop"), h), "laptop")).toContain("already in");
      expect(readFileSync(join(h, ".ssh/authorized_keys"), "utf8")).toBe(`${PUB} adam@elsewhere\n`);
    });

    it("explains an account with no home folder or a folder it can't write", () => {
      expect(() => formatInstallKey(execFileSync("/bin/sh", [], { input: installKeyUnix(PUB, "k"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } }), "k")).toThrow("no home folder");
      const h = home();
      writeFileSync(join(h, ".ssh"), "a file where the folder should be");
      expect(() => formatInstallKey(run(installKeyUnix(PUB, "k"), h), "k")).toThrow("Couldn't prepare");
      expect(existsSync(join(h, ".ssh/authorized_keys"))).toBe(false);
    });

    it("never lets the comment become code", () => {
      const h = home();
      run(installKeyUnix(PUB, "x'; touch pwned; '"), h);
      expect(existsSync(join(h, "pwned"))).toBe(false);
      expect(readFileSync(join(h, ".ssh/authorized_keys"), "utf8")).toBe(`${PUB} portique:x-touch-pwned\n`);
    });
  });

  it("reads a failed write", () => {
    expect(() => formatInstallKey("@@file\n/h/.ssh/authorized_keys\n@@result\nfailed\n", "k")).toThrow("Couldn't add the key");
  });
});
