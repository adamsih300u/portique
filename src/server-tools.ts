import { onServer, type Host } from "./server-run";
import { operateTools } from "./server-operate";
import {
  FACTS_UNIX, FACTS_WINDOWS, PROCESSES_UNIX, PROCESSES_WINDOWS, diskUseUnix, diskUseWindows, formatFactsUnix, formatFactsWindows, formatProcessesUnix,
  formatProcessesWindows, formatUsage, formatUsageWindows, parseDu,
} from "./server-tools-core";
import type { Tool } from "./toolbox";

export type { Host } from "./server-run";

/** Facts, processes and disk use. They only read. */
function inspectTools(host: Host): Tool[] {
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

/** The palette's server tools for one open SSH terminal. They run on that server over its own connection. */
export function serverTools(host: Host): Tool[] {
  return [...inspectTools(host), ...operateTools(host)];
}
