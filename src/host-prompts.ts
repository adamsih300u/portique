import type { Profile } from "./api";
import { api } from "./api";
import { isQuick } from "./quick-connect";
import { h, modal, promptSecret } from "./ui";

export interface HostKeyInfo {
  sid: string;
  host: string;
  algorithm: string;
  fingerprint: string;
  knownOtherType: boolean;
}

/** Asks whether to trust an unknown host key, and tells the backend the answer. */
export async function confirmHostKey(i: HostKeyInfo) {
  const body = h("div", {},
    i.knownOtherType
      ? h("p", { class: "warn" }, `Portique already knows a different kind of key for ${i.host}. That can happen when a server is reinstalled or reconfigured, but it can also mean someone is intercepting the connection. Check with whoever runs the server before you accept.`)
      : h("p", {}, `This is the first time Portique connects to ${i.host}. Every server identifies itself with a key. Portique remembers it from now on and warns you if it ever changes.`),
    h("p", {}, h("strong", {}, i.algorithm), " fingerprint (SHA-256):"),
    h("p", { class: "mono" }, i.fingerprint),
    h("p", { class: "muted" }, "If you can, compare it with the server's own: run ssh-keygen -lf on its host key file (for example /etc/ssh/ssh_host_ed25519_key.pub). If you trust the network you are on, accepting is normal."));
  let accept = false;
  await modal("New server", body, [
    { label: "Cancel" },
    { label: "Trust and connect", primary: true, action: () => { accept = true; } },
  ], false, false);
  await api.confirmHost(i.sid, accept);
}

/** Asks for the login password (offering to save it) or key passphrase. Null if cancelled. */
export async function askLoginSecret(p: Profile, passphrase: boolean): Promise<string | null> {
  const label = passphrase ? "Key passphrase" : `Password for ${p.username || "user"}@${p.host}`;
  const r = await promptSecret(p.name, label, !passphrase && !isQuick(p));
  if (!r) return null;
  if (r.save) await api.setPassword(p.id, r.value).catch(() => {});
  return r.value;
}
