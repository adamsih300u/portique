// Handing out the public half of a vault key: show it, copy it, save it as a file, or copy a command that installs it on
// a server Portique is not connected to. Only the public key is ever fetched; the private key stays in Rust.

import { api, type KeyInfo } from "./api";
import { installCommand, publicFileName, publicLine } from "./server-keys-core";
import { h, modal } from "./ui";

const plain = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error: /, "");

/** The public key as a line, ready for `authorized_keys` or a `.pub` file. */
async function line(k: KeyInfo): Promise<string> {
  return publicLine((await api.keyPublic(k.id)).key, k.name);
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Copies the public key; says so in the dialog's error line if the key can't be read (a passphrase the vault lacks). */
export async function copyPublicKey(k: KeyInfo): Promise<void> {
  await copy(await line(k));
}

/** Copies one command that adds the key to `~/.ssh/authorized_keys` on any Linux, macOS or BSD server. */
export async function copyInstallCommand(k: KeyInfo): Promise<void> {
  await copy(installCommand((await api.keyPublic(k.id)).key, k.name));
}

/** Asks where to save the `.pub` file and writes it. Resolves false if the person cancelled. */
export async function savePublicKey(k: KeyInfo): Promise<boolean> {
  const text = await line(k);
  const path = await api.chooseFileToSave(publicFileName(k.name), [{ name: "Public key", extensions: ["pub"] }]);
  if (!path) return false;
  await api.writeTextFile(path, text + "\n");
  return true;
}

/** Shows a key's public half, the fingerprint to check it by, and the three ways to take it away. */
export async function publicKeyDialog(k: KeyInfo): Promise<void> {
  const shown = await line(k);
  const note = h("div", { class: "muted" });
  const say = (text: string) => { note.textContent = text; };
  const body = h("div", {},
    h("p", { class: "muted" }, `The public half of "${k.name}". It is safe to share: a server that has it lets this key sign in, and nothing else.`),
    h("textarea", { rows: 3, readOnly: true, spellcheck: false, value: shown }),
    h("p", { class: "mono small" }, k.fingerprint),
    h("p", { class: "muted" }, "On a server Portique can't reach yet, paste the install command into a shell there, or add the key to ~/.ssh/authorized_keys yourself. Then edit the profile to sign in with this key."),
    note);
  const act = (label: string, run: () => Promise<string | null>) => ({
    label,
    action: async () => {
      const said = await run();
      if (said) say(said);
      return false;
    },
  });
  await modal("Public key", body, [
    act("Copy key", async () => (await copyPublicKey(k), "Copied the public key.")),
    act("Copy install command", async () => (await copyInstallCommand(k), "Copied. Paste it into a shell on the server and press Enter.")),
    act("Save as file…", async () => ((await savePublicKey(k)) ? "Saved." : null)),
    { label: "Close", primary: true },
  ], true);
}

/** What went wrong, in a form for `alert`. */
export const keyProblem = plain;
