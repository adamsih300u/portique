// What the "Server" palette tools send to a host and how they read the answer. No interface here, so it can be tested:
// the scripts are plain strings, and every reader takes the text a host printed.

import { SERVICES } from "./toolbox-core";

export type Os = "linux" | "unix" | "windows";

// ---------------------------------------------------------------- quoting

/** A word for a POSIX shell: single quotes, with any inside them closed, escaped and reopened. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A string for PowerShell: single quotes, doubled inside. */
export const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Windows' command line is limited to 8191 characters; the encoded script is a third bigger than the script. */
const MAX_ENCODED = 7000;

/** A command line that runs `script` in PowerShell from cmd.exe or from PowerShell itself, without quoting problems. */
export function powershell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes[i * 2] = c & 0xff;
    bytes[i * 2 + 1] = c >> 8;
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${btoa(bin)}`;
  if (cmd.length > MAX_ENCODED) throw new Error("That script is too long for a Windows command line");
  return cmd;
}

/** What a server's shell printed with terminal escape sequences and stray control characters removed. */
export function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "").replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// ---------------------------------------------------------------- reading what a host printed

/** `@@name` lines split a script's output into sections. */
export function sections(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string[] | null = null;
  for (const line of clean(text).split("\n")) {
    const m = /^@@(\w+)\s*$/.exec(line);
    if (m) cur = out[m[1]] = [];
    else if (cur) cur.push(line);
  }
  for (const k of Object.keys(out)) while (out[k].length && !out[k][out[k].length - 1].trim()) out[k].pop();
  return out;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  if (d) return `${n(d, "day")}, ${n(h, "hour")}`;
  if (h) return `${n(h, "hour")}, ${n(m, "minute")}`;
  return n(m, "minute");
}

/** Left-aligned columns, each as wide as its longest cell; the last column is not padded. */
export function table(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + gap))).join("").trimEnd());
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

interface Port {
  port: number;
  /** Reachable from other machines, as opposed to this one only. */
  open: boolean;
}

/** "22 ssh, 80 http" for each of two groups: ports open to the network, and ports for this machine only. */
function portLines(ports: Port[]): string[] {
  const label = (p: number) => (SERVICES[p] ? `${p} ${SERVICES[p]}` : String(p));
  const uniq = (open: boolean) => [...new Set(ports.filter((p) => p.open === open).map((p) => p.port))].sort((a, b) => a - b).map(label);
  const out: string[] = [];
  const net = uniq(true);
  const local = uniq(false).filter((l) => !net.includes(l));
  if (net.length) out.push(`  from the network   ${net.join(", ")}`);
  if (local.length) out.push(`  this machine only  ${local.join(", ")}`);
  if (!out.length) out.push("  none found");
  return out;
}

const WILDCARD = /^(\*|0\.0\.0\.0|\[?::\]?)$/;

/** The port and whether the address is open to the network, from `0.0.0.0:22`, `[::]:80`, `*:443`, `127.0.0.53%lo:53`. */
export function parseListen(local: string): Port | null {
  const i = local.lastIndexOf(":");
  const port = Number(local.slice(i + 1));
  if (i < 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const addr = local.slice(0, i).replace(/%.*$/, "");
  return { port, open: WILDCARD.test(addr) || !/^(127\.|\[?::1\]?$)/.test(addr) };
}

function warn(lines: string[], title: string, items: string[]) {
  if (items.length) lines.push("", title, ...items.map((i) => `  ${i}`));
}

// ---------------------------------------------------------------- server facts

/** Linux first; other Unixes print what they can. Written for `sh`, so it runs whatever the account's login shell is. */
export const FACTS_UNIX = `export LC_ALL=C
echo '@@host'; hostname 2>/dev/null
echo '@@os'; if [ -r /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; fi; uname -srm
echo '@@uptime'; cut -d' ' -f1 /proc/uptime 2>/dev/null
echo '@@load'; cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || uptime 2>/dev/null
echo '@@cpu'; grep -c '^processor' /proc/cpuinfo 2>/dev/null; grep -m1 -E 'model name|Hardware|Model' /proc/cpuinfo 2>/dev/null
echo '@@mem'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo '@@disk'; df -P -k 2>/dev/null
echo '@@ports'; ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null | tail -n +3
echo '@@failed'; systemctl --failed --no-legend --plain 2>/dev/null | cut -d' ' -f1
echo '@@users'; who 2>/dev/null | wc -l
echo '@@me'; id -un 2>/dev/null
`;

const PSEUDO_FS = /^(tmpfs|devtmpfs|udev|overlay|squashfs|efivarfs|devfs|none|shm|cgroup\w*|fuse\.\w+fs|map\s.*)$/;
const PSEUDO_MOUNT = /^\/(proc|sys|dev|run|snap)(\/|$)|^\/var\/lib\/(docker|containers|kubelet)\//;

export interface DiskUse {
  mount: string;
  size: number;
  used: number;
}

/** Real file systems from `df -P -k` output. */
export function parseDf(lines: string[]): DiskUse[] {
  const out: DiskUse[] = [];
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, size, used] = [f[0], Number(f[1]) * 1024, Number(f[2]) * 1024];
    const mount = f.slice(5).join(" ");
    if (!Number.isFinite(size) || size <= 0 || PSEUDO_FS.test(fs) || PSEUDO_MOUNT.test(mount) || out.some((d) => d.mount === mount)) continue;
    out.push({ mount, size, used });
  }
  return out;
}

const diskRows = (disks: DiskUse[]) => table(disks.map((d) => [d.mount, `${pct(d.used, d.size)}% of ${bytes(d.size)}`, `${bytes(d.size - d.used)} free`]), 3).map((l) => `  ${l}`);

export function formatFactsUnix(text: string): string {
  const s = sections(text);
  const one = (k: string) => (s[k]?.[0] ?? "").trim();
  const osLines = (s.os ?? []).filter(Boolean);
  const kernel = osLines[osLines.length - 1] ?? "";
  const distro = osLines.length > 1 ? osLines[0] : (kernel.split(" ")[0] ?? "");
  const cpuCount = Number(one("cpu")) || 0;
  const model = (s.cpu?.[1] ?? "").replace(/^[^:]*:\s*/, "").replace(/\s+/g, " ").trim();
  const out = [`${one("host") || "(unnamed host)"}: ${distro}`, `  ${kernel}${cpuCount ? `, ${cpuCount} CPU${cpuCount === 1 ? "" : "s"}` : ""}${model ? `, ${model}` : ""}`, ""];
  const problems: string[] = [];

  const up = Number(one("uptime"));
  const load = one("load").split(/\s+/).map(Number);
  const loadText = load.length >= 3 && load.every(Number.isFinite) ? `load ${load.join(" ")}` : (one("load") ? one("load").replace(/^.*load averages?:\s*/i, "load ") : "");
  out.push(`Up        ${up > 0 ? duration(up) : "unknown"}`);
  if (loadText) out.push(`Load      ${loadText.replace(/^load /, "")}${cpuCount ? ` (${cpuCount} CPU${cpuCount === 1 ? "" : "s"})` : ""}`);
  if (cpuCount && load[0] > cpuCount * 1.5) problems.push(`The load (${load[0]}) is high for ${cpuCount} CPU${cpuCount === 1 ? "" : "s"}`);

  const mem: Record<string, number> = {};
  for (const l of s.mem ?? []) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(l);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  if (mem.MemTotal) {
    const avail = mem.MemAvailable ?? 0;
    const used = mem.MemTotal - avail;
    out.push(`Memory    ${bytes(used)} of ${bytes(mem.MemTotal)} in use (${pct(used, mem.MemTotal)}%)${mem.SwapTotal ? `, swap ${bytes(mem.SwapTotal - (mem.SwapFree ?? 0))} of ${bytes(mem.SwapTotal)}` : ", no swap"}`);
    if (mem.MemAvailable !== undefined && pct(used, mem.MemTotal) >= 90) problems.push(`Memory is ${pct(used, mem.MemTotal)}% in use`);
  }
  if (one("users")) out.push(`Sessions  ${Number(one("users"))} signed in, you are ${one("me") || "?"}`);

  const disks = parseDf(s.disk ?? []);
  if (disks.length) out.push("", "Disks", ...diskRows(disks));
  for (const d of disks) if (pct(d.used, d.size) >= 90) problems.push(`${d.mount} is ${pct(d.used, d.size)}% full`);

  const ports = (s.ports ?? []).flatMap((l) => {
    const f = l.trim().split(/\s+/);
    // `ss` lines start with the state, `netstat` lines with the protocol; the local address is the fourth column in both.
    const p = /^(LISTEN|tcp)/i.test(f[0]) && f[3] ? parseListen(f[3]) : null;
    return p ? [p] : [];
  });
  out.push("", "Listening (TCP)", ...portLines(ports));

  const failed = (s.failed ?? []).filter(Boolean);
  for (const f of failed) problems.push(`Service ${f} has failed`);
  warn(out, "Needs a look", problems);
  if (!problems.length) out.push("", "Nothing looks wrong: disks under 90%, memory fine, no failed services.");
  return out.join("\n");
}

/** PowerShell, kept short: it travels on a command line. */
export const FACTS_WINDOWS = `$ProgressPreference='SilentlyContinue'
$o=Get-CimInstance Win32_OperatingSystem
$c=Get-CimInstance Win32_Processor|Select-Object -First 1
[pscustomobject]@{
host=$env:COMPUTERNAME;os=$o.Caption;ver=$o.Version;arch=$o.OSArchitecture;cpu=$c.Name;cores=[int]$env:NUMBER_OF_PROCESSORS
up=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds;memTotal=$o.TotalVisibleMemorySize;memFree=$o.FreePhysicalMemory;me=$env:USERNAME
disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object{[pscustomobject]@{name=$_.DeviceID;size=$_.Size;free=$_.FreeSpace}})
ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{port=$_.LocalPort;addr=$_.LocalAddress}})
stopped=@(Get-Service|Where-Object{$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'}|ForEach-Object{$_.Name})
}|ConvertTo-Json -Compress -Depth 4`;

/** PowerShell turns a one-item list into the item itself. */
export const list = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function json<T>(text: string): T {
  const t = clean(text).trim();
  if (!t) throw new Error("The server printed nothing");
  try {
    return JSON.parse(t.slice(t.search(/[[{]/))) as T;
  } catch {
    throw new Error(`The server's answer wasn't readable:\n${t.slice(0, 400)}`);
  }
}

interface WinFacts {
  host: string; os: string; ver: string; arch: string; cpu: string; cores: number; up: number; memTotal: number; memFree: number; me: string;
  disks: { name: string; size: number; free: number }[] | { name: string; size: number; free: number };
  ports: { port: number; addr: string }[] | { port: number; addr: string };
  stopped: string[] | string;
}

export function formatFactsWindows(text: string): string {
  const f = json<WinFacts>(text);
  const out = [`${f.host}: ${f.os}`, `  ${f.ver} ${f.arch}, ${f.cores} CPU${f.cores === 1 ? "" : "s"}, ${(f.cpu ?? "").replace(/\s+/g, " ").trim()}`, ""];
  const problems: string[] = [];
  out.push(`Up        ${duration(f.up)}`);
  const total = f.memTotal * 1024;
  const used = total - f.memFree * 1024;
  out.push(`Memory    ${bytes(used)} of ${bytes(total)} in use (${pct(used, total)}%)`);
  out.push(`Sessions  you are ${f.me}`);
  if (pct(used, total) >= 90) problems.push(`Memory is ${pct(used, total)}% in use`);
  const disks = list(f.disks).filter((d) => d.size > 0).map((d) => ({ mount: d.name, size: d.size, used: d.size - d.free }));
  if (disks.length) out.push("", "Disks", ...diskRows(disks));
  for (const d of disks) if (pct(d.used, d.size) >= 90) problems.push(`${d.mount} is ${pct(d.used, d.size)}% full`);
  const ports = list(f.ports).map((p) => parseListen(`${p.addr}:${p.port}`)).filter((p): p is Port => !!p);
  out.push("", "Listening (TCP)", ...portLines(ports));
  const stopped = list(f.stopped);
  for (const s of stopped.slice(0, 10)) problems.push(`Service ${s} is set to start automatically but isn't running`);
  if (stopped.length > 10) problems.push(`…and ${stopped.length - 10} more services`);
  warn(out, "Needs a look", problems);
  if (!problems.length) out.push("", "Nothing looks wrong: disks under 90%, memory fine, every automatic service running.");
  return out.join("\n");
}

// ---------------------------------------------------------------- top processes

export const PROCESSES_UNIX = `export LC_ALL=C
ps -eo pid=,user=,pcpu=,pmem=,etime=,comm= 2>&1
`;

export interface Proc {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  time: string;
  name: string;
}

export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of clean(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), time: m[5], name: m[6] });
  }
  return out;
}

const top = <T>(xs: T[], key: (x: T) => number, n: number) => [...xs].sort((a, b) => key(b) - key(a)).slice(0, n);

export function formatProcessesUnix(text: string, n = 10): string {
  // The `ps` that listed them is always among the busiest, and says nothing about the server.
  const all = parsePs(text);
  const ps = all.filter((p, i) => !(p.name === "ps" && i === all.findIndex((q) => q.name === "ps")));
  if (!ps.length) throw new Error(`The server's ps gave nothing readable:\n${clean(text).trim().slice(0, 300)}`);
  const rows = (list: Proc[]) => table([["PID", "USER", "CPU %", "MEM %", "RUNNING", "COMMAND"], ...list.map((p) => [String(p.pid), p.user.slice(0, 12), p.cpu.toFixed(1), p.mem.toFixed(1), p.time, p.name])]).map((l) => `  ${l}`);
  return [`${ps.length} processes`, "", "Busiest (CPU)", ...rows(top(ps, (p) => p.cpu, n)), "", "Hungriest (memory)", ...rows(top(ps, (p) => p.mem, n))].join("\n");
}

export const PROCESSES_WINDOWS = `$ProgressPreference='SilentlyContinue'
@(Get-Process|ForEach-Object{[pscustomobject]@{id=$_.Id;name=$_.ProcessName;cpu=[double]$_.CPU;mem=$_.WorkingSet64}})|ConvertTo-Json -Compress`;

export function formatProcessesWindows(text: string, n = 10): string {
  const ps = list(json<{ id: number; name: string; cpu: number; mem: number }[]>(text));
  const rows = (l: typeof ps, byCpu: boolean) =>
    table([["PID", byCpu ? "CPU TIME" : "MEMORY", "NAME"], ...l.map((p) => [String(p.id), byCpu ? duration(p.cpu || 0) : bytes(p.mem), p.name])]).map((x) => `  ${x}`);
  return [`${ps.length} processes`, "", "Most CPU time since they started", ...rows(top(ps, (p) => p.cpu || 0, n), true), "", "Most memory", ...rows(top(ps, (p) => p.mem || 0, n), false)].join("\n");
}

// ---------------------------------------------------------------- what is using the disk

/** The biggest entries one level below `path`, staying on that file system. */
export const diskUseUnix = (path: string) => `export LC_ALL=C
du -xk -d 1 -- ${shq(path)} 2>/dev/null | sort -rn | head -n 21
`;

export interface Usage {
  size: number;
  name: string;
}

export function parseDu(text: string): Usage[] {
  const out: Usage[] = [];
  for (const line of clean(text).split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) out.push({ size: Number(m[1]) * 1024, name: m[2] });
  }
  return out;
}

export function formatUsage(path: string, items: Usage[]): string {
  if (!items.length) throw new Error(`Nothing found at ${path}, or you may not read it`);
  const whole = items.find((i) => i.name === path || i.name === path.replace(/\/+$/, "")) ?? items[0];
  const rest = items.filter((i) => i !== whole);
  const rows = rest.map((i) => [bytes(i.size), `${pct(i.size, whole.size)}%`, i.name.startsWith(path) ? i.name.slice(path.replace(/\/+$/, "").length + 1) || i.name : i.name]);
  return [`${path}: ${bytes(whole.size)} in all (one file system; mounts inside it are not counted)`, "", ...table([["SIZE", "OF ALL", "WHAT"], ...rows]).map((l) => `  ${l}`)].join("\n");
}

export const diskUseWindows = (path: string) => `$ProgressPreference='SilentlyContinue'
$p=${psq(path)}
@(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue|ForEach-Object{$s=if($_.PSIsContainer){(Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue|Measure-Object Length -Sum).Sum}else{$_.Length};[pscustomobject]@{name=$_.Name;size=[double]$s}})|ConvertTo-Json -Compress`;

export function formatUsageWindows(path: string, text: string): string {
  const items = list(json<{ name: string; size: number }[]>(text)).map((i) => ({ name: i.name, size: i.size || 0 }));
  if (!items.length) throw new Error(`Nothing found at ${path}, or you may not read it`);
  const sorted = top(items, (i) => i.size, 20);
  const all = items.reduce((a, i) => a + i.size, 0);
  return [`${path}: ${bytes(all)} in all`, "", ...table([["SIZE", "OF ALL", "WHAT"], ...sorted.map((i) => [bytes(i.size), `${pct(i.size, all)}%`, i.name])]).map((l) => `  ${l}`)].join("\n");
}

// ---------------------------------------------------------------- telling the system apart

/** From the output of `uname -s`. */
export function osFromUname(out: string): Os | null {
  const name = clean(out).trim().split("\n")[0];
  if (!name || /\s/.test(name)) return null;
  return name === "Linux" ? "linux" : "unix";
}

/** From the output of `cmd /c ver`. */
export function windowsFromVer(out: string): boolean {
  return /windows/i.test(clean(out));
}
