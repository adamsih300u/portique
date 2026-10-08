import type { Profile } from "./api";
import { api } from "./api";
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
    h("p", {}, `The authenticity of ${i.host} can't be established. Verify this fingerprint against the server (for example with ssh-keygen -lf on the host) before accepting.`),
    h("p", {}, h("strong", {}, i.algorithm)),
    h("p", { class: "mono" }, i.fingerprint),
    i.knownOtherType ? h("p", { class: "warn" }, "Warning: Portique already knows a different key type for this host. This can be a legitimate reconfiguration, or an attack.") : null);
  let accept = false;
  await modal("Unknown host key", body, [
    { label: "Reject" },
    { label: "Accept and remember", primary: true, action: () => { accept = true; } },
  ], false, false);
  await api.confirmHost(i.sid, accept);
}

/** Asks for the login password (offering to save it) or key passphrase. Null if cancelled. */
export async function askLoginSecret(p: Profile, passphrase: boolean): Promise<string | null> {
  const label = passphrase ? "Key passphrase" : `Password for ${p.username || "user"}@${p.host}`;
  const r = await promptSecret(p.name, label, !passphrase);
  if (!r) return null;
  if (r.save) await api.setPassword(p.id, r.value).catch(() => {});
  return r.value;
}
