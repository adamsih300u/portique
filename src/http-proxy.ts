import { api, Channel, type Profile } from "./api";
import { askLoginSecret, confirmHostKey } from "./host-prompts";
import { ensureUnlocked } from "./vault-ui";

/** An SSH login kept open to send API requests through (a local SOCKS5 port that dials from the server). */
interface Live {
  sid: string;
  port: number;
}

const live = new Map<string, Promise<Live>>();

/**
 * The local proxy port for requests that should travel through this SSH profile. The first call logs in
 * (with the usual host-key, password and passphrase prompts); later calls reuse the open login, and a
 * dropped one is replaced on the next call.
 */
export async function proxyPort(p: Profile): Promise<number> {
  let pending = live.get(p.id);
  if (!pending) {
    pending = open(p);
    live.set(p.id, pending);
    pending.catch(() => { if (live.get(p.id) === pending) live.delete(p.id); });
  }
  return (await pending).port;
}

/** Forgets (and closes) the login, so the next request logs in afresh. */
export async function dropProxy(profileId: string) {
  const pending = live.get(profileId);
  live.delete(profileId);
  const l = await pending?.catch(() => null);
  if (l) void api.close(l.sid).catch(() => {});
}

function open(p: Profile, password?: string, passphrase?: string): Promise<Live> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let sid = "";
    const fail = (message: string) => {
      live.delete(p.id);
      if (!ready) reject(new Error(message));
    };
    const retry = (pw?: string, pp?: string) => open(p, pw, pp).then(resolve, reject);

    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      if (bytes[0] === 0) return;
      const { state, message } = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      switch (state) {
        case "proxy":
          ready = true;
          resolve({ sid, port: JSON.parse(message).port });
          break;
        case "vault-locked":
          void ensureUnlocked().then(() => retry(password, passphrase));
          break;
        case "confirm-host":
          void confirmHostKey(JSON.parse(message));
          break;
        case "need-password":
        case "need-passphrase":
          void askLoginSecret(p, state === "need-passphrase").then((secret) =>
            secret === null ? fail("Cancelled.") : state === "need-passphrase" ? retry(undefined, secret) : retry(secret, passphrase));
          break;
        case "lost":
          fail(`The connection to ${p.name} was lost.`);
          break;
        case "closed":
          fail(`The connection to ${p.name} was closed.`);
          break;
        case "error":
          fail(`Could not log in to ${p.name}: ${message}`);
          break;
      }
    };
    api.connectProxy(p.id, ch, password, passphrase).then((s) => { sid = s; }, (e) => fail(String(e)));
  });
}
