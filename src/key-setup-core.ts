// Setting up key sign-in to a server, start to finish: choose or make a key, put its public half on the server, prove the
// server accepts it, and only then change the profile. The steps are here with what they need passed in, so the order
// and what happens when a step fails can be tested without a window or a server.

import type { KeyInfo } from "./api";
import { pickKey, type Installed } from "./server-keys-core";

/** The key to use: one the vault has, or a new one to make. */
export type Choice = { use: KeyInfo } | { make: string };

/** Blank input makes a new key named after the profile; anything else names a key the vault already has. */
export function chooseKey(keys: KeyInfo[], input: string, profileName: string): Choice {
  if (input.trim()) return { use: pickKey(keys, input) };
  const name = profileName.trim().slice(0, 64) || "server key";
  if (keys.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`The vault already has a key called "${name}". Type its name to use it, or rename that key first.`);
  }
  return { make: name };
}

/** Why there is nothing to set up, when the profile already signs in with a key from the vault; otherwise null. */
export function alreadyKeyed(authMethod: string, keyId: string | null, keys: KeyInfo[]): string | null {
  if (authMethod !== "key") return null;
  const k = keys.find((x) => x.id === keyId);
  return `This profile already signs in with ${k ? `the key "${k.name}"` : "a key"}, so there is nothing to set up. To let another key in, use "Install a key on this host…".`;
}

/** What will happen, in order, before the person presses the button. */
export function planSetup(c: Choice, profileName: string): string {
  const first = "use" in c
    ? `Use the key "${c.use.name}" (${c.use.algorithm}, ${c.use.fingerprint}) from the vault.`
    : `Make a new Ed25519 key called "${c.make}" in the vault. Its private half never leaves the vault.`;
  return [
    "Will set up key sign-in to this server, in four steps:",
    `  1. ${first}`,
    "  2. Add its public half to ~/.ssh/authorized_keys on the server, unless it is already there. It creates ~/.ssh and the file if they are missing, sets them to mode 700 and 600, appends one line and changes nothing else.",
    "  3. Sign in once more, with the key alone, to prove the server accepts it.",
    `  4. Only then change the profile "${profileName}" to sign in with that key.`,
    "",
    "If step 3 fails the profile is left as it is. The saved password stays in the vault as a fallback.",
  ].join("\n");
}

/** What the steps need from the world. Each one throws, in plain words, if it can't be done. */
export interface Steps {
  makeKey(name: string): Promise<KeyInfo>;
  /** The public half only. */
  publicKey(id: string): Promise<string>;
  install(publicKey: string, name: string): Promise<Installed>;
  /** Signs in with the key alone. Rejects with why the server said no. */
  check(keyId: string): Promise<void>;
  /** Points the profile at the key. "unsaved" when the connection isn't a saved profile, so there is nothing to change. */
  switchProfile(keyId: string): Promise<"switched" | "already" | "unsaved">;
}

const reason = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error: /, "");

/** Runs the steps in order. A failure says what had already been done, so nothing is left a mystery. */
export async function setUpKeySignIn(steps: Steps, c: Choice, profileName: string): Promise<string> {
  const done: string[] = [];
  const stop = (what: string, e: unknown, hint = ""): never => {
    throw new Error([`${what}: ${reason(e)}`, ...(done.length ? ["", "Done so far:", ...done.map((d) => `  ${d}`)] : []), ...(hint ? ["", hint] : [])].join("\n"));
  };

  let key: KeyInfo;
  if ("use" in c) {
    key = c.use;
    done.push(`Using the key "${key.name}" from the vault.`);
  } else {
    try {
      key = await steps.makeKey(c.make);
    } catch (e) {
      return stop("Couldn't make the key", e);
    }
    done.push(`Made the key "${key.name}" (${key.algorithm}, ${key.fingerprint}) in the vault.`);
  }

  let pub: string;
  try {
    pub = await steps.publicKey(key.id);
  } catch (e) {
    return stop("Couldn't read the key's public half", e);
  }

  let placed: Installed;
  try {
    placed = await steps.install(pub, key.name);
  } catch (e) {
    return stop("Couldn't put the key on the server", e, `The profile hasn't been changed. Run this again and type "${key.name}" to use the key you have.`);
  }
  done.push(placed.result === "already" ? `The server already had the key (${placed.file}).` : `Added the key to ${placed.file}${placed.count > 0 ? ` (${placed.count} line${placed.count === 1 ? "" : "s"} there now)` : ""}.`);

  try {
    await steps.check(key.id);
  } catch (e) {
    return stop(
      "The key is on the server, but signing in with it didn't work",
      e,
      `The profile hasn't been changed and still signs in as before. Servers refuse a key that is on file when sshd has public-key sign-in off, when the home folder or ~/.ssh can be written by other accounts, or when a security policy blocks the file. The terminal here is still connected, so you can look. Once it is fixed, run this again and type "${key.name}" to use the key you have.`,
    );
  }
  done.push("Signed in with the key alone, and the server accepted it.");

  let switched: Awaited<ReturnType<Steps["switchProfile"]>>;
  try {
    switched = await steps.switchProfile(key.id);
  } catch (e) {
    return stop("The key works, but the profile couldn't be changed", e, `Edit the profile yourself: set the sign-in to a private key and choose "${key.name}".`);
  }
  done.push(
    switched === "switched" ? `Changed "${profileName}" to sign in with the key.`
      : switched === "already" ? `"${profileName}" already signs in with this key.`
      : `"${profileName}" isn't a saved profile, so nothing was changed. Save it, then choose the private key "${key.name}" in its editor.`,
  );

  return [
    switched === "unsaved" ? `The key works for ${profileName}.` : `Key sign-in is set up for ${profileName}.`,
    "",
    ...done.map((d) => `  ${d}`),
    ...(switched === "switched" ? ["", "The saved password is still in the vault and is no longer used. Remove it in the profile once you have connected with the key."] : []),
  ].join("\n");
}
