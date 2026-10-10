// Running a script on the server of an open SSH terminal, whatever the server runs.

import { api, type ExecOut } from "./api";
import { clean, osFromUname, powershell, windowsFromVer, type Os } from "./server-tools-core";

/** The server of one open SSH terminal. `session` is its current session id, or null once it has gone. */
export interface Host {
  name: string;
  session(): string | null;
  /** Types text into the host's terminal for the person to see; `run` also presses Enter. */
  type(text: string, run: boolean): void;
}

/** What each open session runs, found once: a command that tells Windows from the rest costs a round trip. */
const systems = new Map<string, Os>();

/** What a command printed, or why it failed. A failure that still printed something is the command's own answer. */
function printed(r: ExecOut): string {
  if (r.code && !r.stdout.trim()) throw new Error(clean(r.stderr).trim().slice(0, 600) || `The command failed (exit status ${r.code})`);
  return r.stdout + (r.truncated ? "\n(the server printed more than Portique keeps; the end is cut off)" : "");
}

async function system(sid: string): Promise<Os> {
  const found = systems.get(sid);
  if (found) return found;
  const unix = await api.sshExec(sid, "uname -s", undefined, 10);
  let os: Os | null = unix.code === 0 ? osFromUname(unix.stdout) : null;
  // Windows' OpenSSH answers with cmd.exe or PowerShell; `cmd /c ver` works in both and fails everywhere else.
  if (!os && windowsFromVer((await api.sshExec(sid, "cmd /c ver", undefined, 10)).stdout)) os = "windows";
  if (!os) throw new Error("Couldn't tell what this server runs, so Portique doesn't know which commands to use");
  systems.set(sid, os);
  return os;
}

/** Runs a script under `sh` (Linux, macOS, BSD) or PowerShell (Windows), whichever the server has. */
export async function onServer<T>(host: Host, secs: number, pick: (os: Os) => { script: string; read: (out: string) => T }): Promise<T> {
  const sid = host.session();
  if (!sid) throw new Error(`${host.name} isn't connected`);
  const os = await system(sid);
  const { script, read } = pick(os);
  const r = os === "windows" ? await api.sshExec(sid, powershell(script), undefined, secs) : await api.sshExec(sid, "sh", script, secs);
  return read(printed(r));
}

export const fail = (message: string): never => {
  throw new Error(message);
};

/** What the server runs, if it has been found out; a plan can only name the right commands once it is. */
export function known(host: Host): Os {
  const sid = host.session();
  return (sid && systems.get(sid)) || fail("Checking what the server runs…");
}

/** Finds out what the server runs when a dialog opens, so a palette that is merely opened never touches the server. */
export const prepare = (host: Host) => async () => {
  const sid = host.session();
  if (!sid) fail(`${host.name} isn't connected`);
  else await system(sid);
};
