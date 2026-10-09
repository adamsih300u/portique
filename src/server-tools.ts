import { api, type ExecOut } from "./api";
import {
  FACTS_UNIX, FACTS_WINDOWS, PROCESSES_UNIX, PROCESSES_WINDOWS, clean, diskUseUnix, diskUseWindows, formatFactsUnix, formatFactsWindows, formatProcessesUnix,
  formatProcessesWindows, formatUsage, formatUsageWindows, osFromUname, parseDu, powershell, windowsFromVer, type Os,
} from "./server-tools-core";
import type { Tool } from "./toolbox";

/** The server of one open SSH terminal. `session` is its current session id, or null once it has gone. */
export interface Host {
  name: string;
  session(): string | null;
}

/** What each open session runs, found once: a command that tells Windows from the rest costs a round trip. */
const systems = new Map<string, Os>();

/** What a command printed, or why it failed. A failure that still printed something is the command's own answer. */
function printed(r: ExecOut): string {
  if (r.code && !r.stdout.trim()) throw new Error(clean(r.stderr).trim().slice(0, 600) || `The command failed (exit status ${r.code})`);
  return r.stdout + (r.truncated ? "\n(the server printed more than Portique keeps; the end is cut off)" : "");
}

async function system(sid: string): Promise<Os> {
  const known = systems.get(sid);
  if (known) return known;
  const unix = await api.sshExec(sid, "uname -s", undefined, 10);
  let os: Os | null = unix.code === 0 ? osFromUname(unix.stdout) : null;
  // Windows' OpenSSH answers with cmd.exe or PowerShell; `cmd /c ver` works in both and fails everywhere else.
  if (!os && windowsFromVer((await api.sshExec(sid, "cmd /c ver", undefined, 10)).stdout)) os = "windows";
  if (!os) throw new Error("Couldn't tell what this server runs, so Portique doesn't know which commands to use");
  systems.set(sid, os);
  return os;
}

/** Runs a script under `sh` (Linux, macOS, BSD) or PowerShell (Windows), whichever the server has. */
async function onServer<T>(host: Host, secs: number, pick: (os: Os) => { script: string; read: (out: string) => T }): Promise<T> {
  const sid = host.session();
  if (!sid) throw new Error(`${host.name} isn't connected`);
  const os = await system(sid);
  const { script, read } = pick(os);
  const r = os === "windows" ? await api.sshExec(sid, powershell(script), undefined, secs) : await api.sshExec(sid, "sh", script, secs);
  return read(printed(r));
}

/** The palette's server tools for one open SSH terminal. They run on that server over its own connection. */
export function serverTools(host: Host): Tool[] {
  const heading = (t: string) => `${t}: ${host.name}`;
  return [
    {
      id: "server-facts", heading: heading("Server facts"), title: "Server facts", hint: "system, memory, disks, open ports, failed services", keywords: "server host info status health overview uptime load memory disk ports services failed",
      again: "Refresh",
      run: () => onServer(host, 45, (os) => (os === "windows" ? { script: FACTS_WINDOWS, read: formatFactsWindows } : { script: FACTS_UNIX, read: formatFactsUnix })),
    },
    {
      id: "server-processes", heading: heading("Top processes"), title: "Top processes", hint: "the busiest and the hungriest", keywords: "server host ps top cpu memory ram load busy slow",
      again: "Refresh",
      run: () => onServer(host, 45, (os) => (os === "windows" ? { script: PROCESSES_WINDOWS, read: (t) => formatProcessesWindows(t) } : { script: PROCESSES_UNIX, read: (t) => formatProcessesUnix(t) })),
    },
    {
      id: "server-disk", heading: heading("Disk usage"), title: "Disk usage…", hint: "what is using the space in a folder", keywords: "server host du space full biggest large folders directory df",
      input: { label: "Folder", hint: "empty for the top of the disk. Looks one level down, on one file system, and can take a minute." },
      blank: true,
      run: (text) => {
        const path = text.trim();
        return onServer(host, 100, (os) => {
          const p = path || (os === "windows" ? "C:\\" : "/");
          return os === "windows" ? { script: diskUseWindows(p), read: (t) => formatUsageWindows(p, t) } : { script: diskUseUnix(p), read: (t) => formatUsage(p, parseDu(t)) };
        });
      },
    },
  ];
}
