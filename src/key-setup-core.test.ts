import { describe, expect, it } from "vitest";
import type { KeyInfo } from "./api";
import { chooseKey, planSetup, setUpKeySignIn, type Steps } from "./key-setup-core";

const key = (name: string): KeyInfo => ({ id: `id-${name}`, name, algorithm: "ssh-ed25519", fingerprint: `SHA256:fp-${name}`, encrypted: false });
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPortiqueTestKeyDataOnlyNotARealKeyAAAAAAAAAAAAAAAAAA";

/** Steps that record what they were asked, and fail where told to. */
function fake(fail: Partial<Record<keyof Steps, string>> = {}, over: Partial<Steps> = {}) {
  const calls: string[] = [];
  const step = <T>(name: keyof Steps, args: unknown[], value: T): Promise<T> => {
    calls.push(`${name} ${args.join(",")}`.trim());
    return fail[name] ? Promise.reject(new Error(fail[name])) : Promise.resolve(value);
  };
  const steps: Steps = {
    makeKey: (name) => step("makeKey", [name], key("core-switch")),
    publicKey: (id) => step("publicKey", [id], PUB),
    install: (pub, name) => step("install", [pub, name], { file: "/home/a/.ssh/authorized_keys", result: "added", count: 2 }),
    check: (id) => step("check", [id], undefined),
    switchProfile: (id) => step("switchProfile", [id], "switched"),
    ...over,
  };
  return { steps, calls };
}

describe("choosing the key", () => {
  it("makes a new key named after the profile when the box is empty", () => {
    expect(chooseKey([key("laptop")], "  ", "core-switch")).toEqual({ make: "core-switch" });
    expect(chooseKey([], "", "  core-switch  ")).toEqual({ make: "core-switch" });
    expect(chooseKey([], "", "x".repeat(100))).toEqual({ make: "x".repeat(64) });
    expect(chooseKey([], "", "   ")).toEqual({ make: "server key" });
  });

  it("uses a key the vault has when a name is typed", () => {
    expect(chooseKey([key("laptop"), key("deploy")], "dep", "core-switch")).toEqual({ use: key("deploy") });
    expect(() => chooseKey([key("laptop")], "nope", "core-switch")).toThrow('No key called "nope"');
  });

  it("won't make a second key with a name in use, and says how to use that one", () => {
    expect(() => chooseKey([key("Core-Switch")], "", "core-switch")).toThrow('already has a key called "core-switch". Type its name');
  });
});

describe("the plan", () => {
  it("lists the four steps, saying the profile only changes after the check", () => {
    const plan = planSetup({ make: "core-switch" }, "core-switch");
    expect(plan).toContain('Make a new Ed25519 key called "core-switch"');
    expect(plan).toContain("authorized_keys");
    expect(plan).toContain("mode 700 and 600");
    expect(plan).toContain("with the key alone");
    expect(plan).toMatch(/4\. Only then change the profile "core-switch"/);
    expect(plan).toContain("If step 3 fails the profile is left as it is");
  });

  it("names the key and its fingerprint when one is reused", () => {
    expect(planSetup({ use: key("laptop") }, "p")).toContain('Use the key "laptop" (ssh-ed25519, SHA256:fp-laptop)');
  });
});

describe("setting it up", () => {
  it("makes, installs, checks and only then switches, and reports every step", async () => {
    const { steps, calls } = fake();
    const out = await setUpKeySignIn(steps, { make: "core-switch" }, "core-switch");
    expect(calls).toEqual(["makeKey core-switch", "publicKey id-core-switch", `install ${PUB},core-switch`, "check id-core-switch", "switchProfile id-core-switch"]);
    expect(out).toContain("Key sign-in is set up for core-switch.");
    expect(out).toContain('Made the key "core-switch"');
    expect(out).toContain("(2 lines there now)");
    expect(out).toContain("the server accepted it");
    expect(out).toContain('Changed "core-switch" to sign in with the key.');
    expect(out).toContain("saved password is still in the vault");
  });

  it("uses an existing key without making one", async () => {
    const { steps, calls } = fake();
    await setUpKeySignIn(steps, { use: key("laptop") }, "p");
    expect(calls[0]).toBe("publicKey id-laptop");
    expect(calls.some((c) => c.startsWith("makeKey"))).toBe(false);
  });

  it("reports a key the server already had", async () => {
    const { steps } = fake({}, { install: () => Promise.resolve({ file: "/h/.ssh/authorized_keys", result: "already" as const, count: 1 }) });
    expect(await setUpKeySignIn(steps, { use: key("laptop") }, "p")).toContain("The server already had the key");
  });

  it("does not touch the server or the profile when the key can't be made", async () => {
    const { steps, calls } = fake({ makeKey: "there is already a key called x" });
    await expect(setUpKeySignIn(steps, { make: "x" }, "p")).rejects.toThrow("Couldn't make the key: there is already a key called x");
    expect(calls).toEqual(["makeKey x"]);
  });

  it("leaves the profile alone, and says the key was made, when the install fails", async () => {
    const { steps, calls } = fake({ install: "Couldn't prepare /h/.ssh/authorized_keys" });
    const err = await setUpKeySignIn(steps, { make: "core-switch" }, "core-switch").catch((e: Error) => e.message);
    expect(err).toContain("Couldn't put the key on the server: Couldn't prepare");
    expect(err).toContain('Made the key "core-switch"');
    expect(err).toContain('type "core-switch" to use the key you have');
    expect(calls).not.toContain("check id-core-switch");
    expect(calls.some((c) => c.startsWith("switchProfile"))).toBe(false);
  });

  it("leaves the profile alone when the server doesn't accept the key", async () => {
    const { steps, calls } = fake({ check: "the server did not accept the key" });
    const err = await setUpKeySignIn(steps, { make: "core-switch" }, "core-switch").catch((e: Error) => e.message);
    expect(err).toContain("The key is on the server, but signing in with it didn't work: the server did not accept the key");
    expect(err).toContain("Added the key to");
    expect(err).toContain("The profile hasn't been changed and still signs in as before");
    expect(err).toContain('type "core-switch" to use the key you have');
    expect(calls.some((c) => c.startsWith("switchProfile"))).toBe(false);
  });

  it("says so when the key works but the profile couldn't be saved", async () => {
    const { steps } = fake({ switchProfile: "disk full" });
    const err = await setUpKeySignIn(steps, { make: "k" }, "p").catch((e: Error) => e.message);
    expect(err).toContain("The key works, but the profile couldn't be changed: disk full");
    expect(err).toContain("Signed in with the key alone");
  });

  it("explains an unsaved connection and an already-set profile", async () => {
    const unsaved = fake({}, { switchProfile: () => Promise.resolve("unsaved" as const) });
    const out = await setUpKeySignIn(unsaved.steps, { use: key("laptop") }, "quick host");
    expect(out).toContain("The key works for quick host.");
    expect(out).toContain("isn't a saved profile");
    expect(out).not.toContain("saved password is still");
    const already = fake({}, { switchProfile: () => Promise.resolve("already" as const) });
    expect(await setUpKeySignIn(already.steps, { use: key("laptop") }, "p")).toContain('"p" already signs in with this key.');
  });
});
