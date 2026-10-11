// Services, containers and logs on a server: the scripts to send, and how to read what comes back.
// Listing and reading change nothing. A start, stop or restart is only ever built from a name checked here
// and quoted with `shq`, and the dialog shows the exact command before the person confirms it.

import { clean, list, psq, sections, shq, table } from "./server-tools-core";

// ---------------------------------------------------------------- names

/** A systemd unit name: letters, digits and `. _ - @ :` (an escaped name with a backslash is not offered here). */
export function unitName(s: string): string {
  const n = s.trim();
  if (!n) throw new Error("Enter a service name, like nginx or ssh");
  if (!/^[A-Za-z0-9@._:-]{1,200}$/.test(n) || n.startsWith("-")) throw new Error("A service name has letters, digits and . _ - @ : only");
  return n;
}

/** A container name or id: what docker and podman accept. */
export function containerName(s: string): string {
  const n = s.trim();
  if (!n) throw new Error("Enter a container name or id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(n)) throw new Error("A container name has letters, digits and . _ - only");
  return n;
}

/** A Windows service name (its short name, not the display name). */
export function windowsServiceName(s: string): string {
  const n = s.trim();
  if (!n) throw new Error("Enter a service name, like Spooler");
  if (!/^[A-Za-z0-9 _.$#()-]{1,256}$/.test(n)) throw new Error("A Windows service name has letters, digits, spaces and . _ - $ # ( ) only");
  return n;
}

export type Verb = "start" | "stop" | "restart" | "reload";

// ---------------------------------------------------------------- sudo

/**
 * Picks `$S`, the prefix for commands that need root: nothing when this account is root, `sudo -n` when it may use sudo
 * without a password, and nothing otherwise (the command then fails and says why). `-n` means sudo never asks for a
 * password, so nothing here can read one.
 */
export const PRIV = `if [ "$(id -u)" = 0 ]; then S=; elif sudo -n true 2>/dev/null; then S='sudo -n'; else S=; fi
`;

/** Said when a command was refused for want of a password or of rights. */
export const NEEDS_PASSWORD = /a password is required|a terminal is required|not in the sudoers|may not run sudo|Interactive authentication required|Access denied|permission denied|Permission denied/;

const NO_SUDO = "This account isn't root and has no passwordless sudo, and Portique never types a password. Use the terminal button to run it yourself.";

// ---------------------------------------------------------------- services (Linux with systemd)

export const SERVICES_UNIX = `export LC_ALL=C
command -v systemctl >/dev/null 2>&1 || { echo '@@nosystemd'; exit 0; }
echo '@@list'; systemctl list-units --type=service --all --no-legend --plain --no-pager 2>&1
`;

export interface Svc {
  unit: string;
  active: string;
  sub: string;
  description: string;
}

export function parseServices(text: string): Svc[] {
  const out: Svc[] = [];
  for (const line of clean(text).split("\n")) {
    const m = /^\s*[●*]?\s*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m && m[2] === "loaded") out.push({ unit: m[1], active: m[3], sub: m[4], description: m[5].trim() });
  }
  return out;
}

const state = (s: Svc) => (s.active === "failed" ? "failed" : s.sub === "running" ? "running" : s.active === "active" ? s.sub : "stopped");

export function formatServices(text: string, host: string, filter = ""): string {
  if (clean(text).includes("@@nosystemd")) throw new Error("This server doesn't use systemd, so there is no service list to show");
  const all = parseServices(text);
  if (!all.length) throw new Error(`The server listed no services:\n${clean(text).trim().slice(0, 300)}`);
  const f = filter.trim().toLowerCase();
  const rows = (xs: Svc[]) => table(xs.map((s) => [state(s), s.unit.replace(/\.service$/, ""), s.description])).map((l) => `  ${l}`);
  if (f) {
    const hits = all.filter((s) => `${s.unit} ${s.description}`.toLowerCase().includes(f));
    if (!hits.length) throw new Error(`No service matches "${filter.trim()}" (${all.length} are loaded on ${host})`);
    const order = ["failed", "running", "stopped"];
    hits.sort((a, b) => order.indexOf(state(a)) - order.indexOf(state(b)) || a.unit.localeCompare(b.unit));
    return [`${hits.length} of ${all.length} services on ${host} match "${filter.trim()}"`, "", ...rows(hits)].join("\n");
  }
  const failed = all.filter((s) => state(s) === "failed");
  const running = all.filter((s) => state(s) === "running");
  const other = all.length - failed.length - running.length;
  return [
    `${all.length} services on ${host}: ${running.length} running, ${failed.length} failed, ${other} stopped or finished`,
    ...(failed.length ? ["", "Failed", ...rows(failed)] : ["", "None have failed."]),
    "",
    `Running (${running.length})`,
    ...rows(running),
    "",
    "Type part of a name or description to look for stopped services too.",
  ].join("\n");
}

/** Start, stop, restart or reload one service. Prints `@@rc` (the exit status), `@@out`, `@@status`, and `@@sudo`. */
export function serviceActionUnix(verb: Verb, unit: string): string {
  const u = shq(unitName(unit));
  return `export LC_ALL=C
${PRIV}out=$($S systemctl ${verb} ${u} 2>&1); rc=$?
echo '@@rc'; echo "$rc"
echo '@@out'; echo "$out"
echo '@@sudo'; echo "\${S:-none}"
echo '@@status'; systemctl status ${u} --no-pager -n 6 2>&1 | head -n 14
`;
}

/** What the person is told will happen, before they confirm. */
export function servicePlanUnix(verb: Verb, unit: string): string {
  const u = unitName(unit);
  return `Will run on the server, as root:\n  systemctl ${verb} ${u}\n\nIf this account isn't root it uses sudo -n, which never asks for a password. If that isn't allowed it runs as this account, and the server will most likely refuse; you can type the command in the terminal instead.${verb === "stop" ? "\n\nStopping a service can cut off whatever depends on it." : ""}`;
}

const PAST: Record<Verb, string> = { start: "Started", stop: "Stopped", restart: "Restarted", reload: "Reloaded" };

/** Reads the output of `serviceActionUnix`; throws, with a reason, when the command failed. */
export function formatServiceAction(verb: Verb, unit: string, text: string): string {
  const s = sections(text);
  const rc = Number(s.rc?.[0]);
  const said = (s.out ?? []).join("\n").trim();
  const status = (s.status ?? []).join("\n");
  const how = s.sudo?.[0] === "sudo -n" ? " (through sudo -n)" : "";
  if (rc === 0) return [`${PAST[verb]} ${unit}${how}.`, "", status].join("\n").trim();
  const why = NEEDS_PASSWORD.test(said) ? NO_SUDO : "";
  throw new Error([`Couldn't ${verb} ${unit}${how} (exit status ${Number.isNaN(rc) ? "unknown" : rc}).`, said, why].filter(Boolean).join("\n\n"));
}

/** The recent journal of one unit. Read-only; entries from other users may be hidden from a plain account. */
export function serviceLogUnix(unit: string, lines = 200): string {
  const u = shq(unitName(unit));
  return `export LC_ALL=C
command -v journalctl >/dev/null 2>&1 || { echo '@@nojournal'; exit 0; }
echo '@@log'; journalctl -u ${u} -n ${lines} --no-pager 2>&1
`;
}

export function formatLog(text: string, what: string): string {
  const t = clean(text);
  if (t.includes("@@nojournal")) throw new Error("This server has no journalctl, so there's no journal to read here");
  const lines = t.replace(/^@@log\n/, "").trimEnd().split("\n");
  // journalctl opens with a hint, over two or three lines, when this account can't see everyone's messages.
  const limited = lines.some((l) => /^Hint: You are currently not seeing messages/.test(l));
  const body = lines.filter((l) => !/^Hint: |^\s+(Users in groups|Pass -q)/.test(l)).join("\n").trim();
  const advice = "This account can't see the whole system journal: add it to the systemd-journal or adm group.";
  if (!body || /^-- No entries --$/m.test(body)) throw new Error(`No journal entries for ${what}.${limited ? `\n\n${advice}` : ""}`);
  return limited ? `${body}\n\n(${advice})` : body;
}

// ---------------------------------------------------------------- containers (docker or podman)

/** Chooses `$D` (docker, else podman) and `$S` (sudo -n only if this account can't reach the engine and may use sudo). */
const ENGINE = `D=docker; command -v docker >/dev/null 2>&1 || D=podman
command -v "$D" >/dev/null 2>&1 || { echo '@@none'; exit 0; }
if "$D" info >/dev/null 2>&1; then S=; elif [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then S='sudo -n'; else S=; fi
echo '@@engine'; echo "$D"
echo '@@sudo'; echo "\${S:-none}"
`;

export const CONTAINERS_UNIX = `export LC_ALL=C
${ENGINE}echo '@@list'; $S "$D" ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1
`;

export interface Ctr {
  name: string;
  image: string;
  status: string;
  ports: string;
}

/** "0.0.0.0:80->80/tcp, [::]:80->80/tcp" as "80->80/tcp". */
export function shortPorts(p: string): string {
  const seen = new Set<string>();
  for (const part of p.split(",")) {
    const s = part.trim().replace(/^(0\.0\.0\.0|\[::\]|:::?):?/, "");
    if (s) seen.add(s);
  }
  return [...seen].join(", ");
}

export function parseContainers(listLines: string[]): Ctr[] {
  return listLines.flatMap((l) => {
    const [name, image, status, ports] = l.split("|");
    return name && status !== undefined && l.split("|").length >= 4 ? [{ name, image, status, ports: shortPorts(ports ?? "") }] : [];
  });
}

export function formatContainers(text: string, host: string): string {
  if (clean(text).includes("@@none")) throw new Error("Neither docker nor podman is installed on this server");
  const s = sections(text);
  const engine = s.engine?.[0] ?? "docker";
  const lines = s.list ?? [];
  if (lines.some((l) => NEEDS_PASSWORD.test(l)))
    throw new Error(`This account can't use ${engine} (it isn't in the ${engine} group, and has no passwordless sudo).\n\n${lines.join("\n")}`);
  const all = parseContainers(lines);
  if (!all.length) return lines.some((l) => l.trim()) ? lines.join("\n") : `No containers on ${host} (${engine}).`;
  const up = all.filter((c) => /^Up/.test(c.status));
  const down = all.filter((c) => !/^Up/.test(c.status));
  const rows = (xs: Ctr[]) => table(xs.map((c) => [c.name, c.image, c.status, c.ports])).map((l) => `  ${l}`);
  return [
    `${all.length} containers on ${host} (${engine}${s.sudo?.[0] === "sudo -n" ? ", through sudo -n" : ""}): ${up.length} running, ${down.length} stopped`,
    ...(up.length ? ["", "Running", ...rows(up)] : []),
    ...(down.length ? ["", "Stopped", ...rows(down)] : []),
  ].join("\n");
}

export type CtrVerb = "start" | "stop" | "restart";

export function containerActionUnix(verb: CtrVerb, name: string): string {
  const n = shq(containerName(name));
  return `export LC_ALL=C
${ENGINE}out=$($S "$D" ${verb} ${n} 2>&1); rc=$?
echo '@@rc'; echo "$rc"
echo '@@out'; echo "$out"
echo '@@state'; $S "$D" ps -a --filter name=${n} --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1
`;
}

export function containerPlanUnix(verb: CtrVerb, name: string): string {
  const n = containerName(name);
  return `Will run on the server:\n  docker ${verb} ${n}\n\n(podman if that is what the server has). If this account can't reach the engine and may use sudo, it uses sudo -n, which never asks for a password.${verb === "stop" ? "\n\nStopping a container stops what it serves." : ""}`;
}

export function formatContainerAction(verb: CtrVerb, name: string, text: string): string {
  if (clean(text).includes("@@none")) throw new Error("Neither docker nor podman is installed on this server");
  const s = sections(text);
  const rc = Number(s.rc?.[0]);
  const said = (s.out ?? []).join("\n").trim();
  const how = s.sudo?.[0] === "sudo -n" ? " (through sudo -n)" : "";
  if (rc === 0) {
    const now = parseContainers(s.state ?? [])[0];
    return [`${PAST[verb]} ${name}${how}.`, now ? `Now: ${now.status}` : ""].filter(Boolean).join("\n");
  }
  const why = NEEDS_PASSWORD.test(said) ? NO_SUDO : "";
  throw new Error([`Couldn't ${verb} ${name}${how} (exit status ${Number.isNaN(rc) ? "unknown" : rc}).`, said, why].filter(Boolean).join("\n\n"));
}

export function containerLogUnix(name: string, lines = 200): string {
  const n = shq(containerName(name));
  return `export LC_ALL=C
${ENGINE}echo '@@log'; $S "$D" logs --tail ${lines} ${n} 2>&1
`;
}

export function formatContainerLog(text: string, name: string): string {
  if (clean(text).includes("@@none")) throw new Error("Neither docker nor podman is installed on this server");
  const s = sections(text);
  const body = (s.log ?? []).join("\n").trimEnd();
  if (NEEDS_PASSWORD.test(body) && body.length < 400) throw new Error(`This account can't use ${s.engine?.[0] ?? "docker"}: ${body}`);
  if (/^Error.*No such container/m.test(body)) throw new Error(`There's no container called ${name}`);
  return body || `${name} has printed nothing.`;
}

// ---------------------------------------------------------------- following a log in the terminal

/** What to type into the shell to follow a file (a path) or a unit's journal (a name). Quoted, but the person sees it before it runs. */
export function followCommand(target: string): string {
  const t = target.trim();
  if (!t) throw new Error("Enter a log file path (like /var/log/syslog) or a service name");
  if (/[\n\r\0]/.test(t)) throw new Error("That isn't a file or service name");
  return t.startsWith("/") ? `tail -n 100 -f -- ${shq(t)}` : `journalctl -u ${shq(unitName(t))} -n 100 -f`;
}

// ---------------------------------------------------------------- Windows services

export const SERVICES_WINDOWS = `$ProgressPreference='SilentlyContinue'
@(Get-Service|ForEach-Object{[pscustomobject]@{name=$_.Name;display=$_.DisplayName;status=[string]$_.Status}})|ConvertTo-Json -Compress`;

export function formatServicesWindows(text: string, host: string, filter = ""): string {
  const json = clean(text).trim();
  if (!json) throw new Error("The server printed nothing");
  let all: { name: string; display: string; status: string }[];
  try {
    all = list(JSON.parse(json.slice(json.search(/[[{]/))));
  } catch {
    throw new Error(`The server's answer wasn't readable:\n${json.slice(0, 300)}`);
  }
  const f = filter.trim().toLowerCase();
  const hits = f ? all.filter((s) => `${s.name} ${s.display}`.toLowerCase().includes(f)) : all.filter((s) => s.status === "Running");
  if (f && !hits.length) throw new Error(`No service matches "${filter.trim()}" (${all.length} on ${host})`);
  const stopped = all.filter((s) => s.status !== "Running").length;
  return [
    f ? `${hits.length} of ${all.length} services on ${host} match "${filter.trim()}"` : `${all.length} services on ${host}: ${hits.length} running, ${stopped} stopped`,
    "",
    ...table(hits.sort((a, b) => a.name.localeCompare(b.name)).map((s) => [s.status.toLowerCase(), s.name, s.display])).map((l) => `  ${l}`),
    ...(f ? [] : ["", "Type part of a name to look for stopped services too."]),
  ].join("\n");
}

export type WinVerb = "start" | "stop" | "restart";

export function serviceActionWindows(verb: WinVerb, name: string): string {
  const cmd = { start: "Start-Service", stop: "Stop-Service", restart: "Restart-Service" }[verb];
  return `$ProgressPreference='SilentlyContinue'
$n=${psq(windowsServiceName(name))}
try{${cmd} -Name $n -ErrorAction Stop;$rc=0;$out=''}catch{$rc=1;$out=$_.Exception.Message}
[pscustomobject]@{rc=$rc;out=$out;status=[string](Get-Service -Name $n -ErrorAction SilentlyContinue).Status}|ConvertTo-Json -Compress`;
}

export function servicePlanWindows(verb: WinVerb, name: string): string {
  return `Will run on the server, in PowerShell:\n  ${{ start: "Start-Service", stop: "Stop-Service", restart: "Restart-Service" }[verb]} -Name '${windowsServiceName(name)}'\n\nIt needs this account to be an administrator. Nothing is elevated for you.${verb === "stop" ? "\n\nStopping a service can cut off whatever depends on it." : ""}`;
}

export function formatServiceActionWindows(verb: WinVerb, name: string, text: string): string {
  const json = clean(text).trim();
  let r: { rc: number; out: string; status: string };
  try {
    r = JSON.parse(json.slice(json.search(/[[{]/)));
  } catch {
    throw new Error(`The server's answer wasn't readable:\n${json.slice(0, 300)}`);
  }
  if (r.rc === 0) return `${PAST[verb]} ${name}. It is now ${(r.status || "unknown").toLowerCase()}.`;
  throw new Error(`Couldn't ${verb} ${name}.\n\n${r.out}${/access|denied|privilege|permission/i.test(r.out) ? "\n\nThis account probably isn't an administrator on the server." : ""}`);
}
