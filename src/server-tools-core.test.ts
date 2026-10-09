import { describe, expect, it } from "vitest";
import {
  FACTS_UNIX, FACTS_WINDOWS, PROCESSES_WINDOWS, bytes, clean, diskUseUnix, diskUseWindows, duration, formatFactsUnix, formatFactsWindows, formatProcessesUnix,
  formatProcessesWindows, formatUsage, formatUsageWindows, osFromUname, parseDf, parseDu, parseListen, parsePs, powershell, psq, sections, shq, table, windowsFromVer,
} from "./server-tools-core";

/** What FACTS_UNIX printed on a Debian 12 machine (the host name changed), with one failed service. */
const DEBIAN = `@@host
devbox
@@os
Debian GNU/Linux 12 (bookworm)
Linux 6.1.0-44-amd64 x86_64
@@uptime
356691.38
@@load
0.46 0.57 0.43
@@cpu
8
model name\t: Intel(R) Xeon(R) CPU E5-2695 v2 @ 2.40GHz
@@mem
MemTotal:       164838456 kB
MemAvailable:   156257368 kB
SwapTotal:             0 kB
SwapFree:              0 kB
@@disk
Filesystem     1024-blocks     Used Available Capacity Mounted on
udev              82392720        0  82392720       0% /dev
tmpfs             16483848     3020  16480828       1% /run
/dev/sda1        154494032 48981988  98588568      34% /
tmpfs             82419228        0  82419228       0% /dev/shm
/dev/sdb1        153706960 89287424  56538884      62% /opt/dev
tmpfs             16483844        4  16483840       1% /run/user/1000
@@ports
LISTEN 0      128                        0.0.0.0:22    0.0.0.0:*
LISTEN 0      128                      127.0.0.1:2299  0.0.0.0:*
LISTEN 0      50                            [::]:445      [::]:*
LISTEN 0      4096                             *:9080        *:*
LISTEN 0      4096                  127.0.0.53%lo:53    0.0.0.0:*
@@failed
vsftpd.service
@@users
2
@@me
adam
`;

describe("quoting", () => {
  it("quotes for sh and for PowerShell", () => {
    expect(shq("/var/log")).toBe("'/var/log'");
    expect(shq("it's here; rm -rf /")).toBe(`'it'\\''s here; rm -rf /'`);
    expect(psq("C:\\Program Files\\x")).toBe("'C:\\Program Files\\x'");
    expect(psq("it's")).toBe("'it''s'");
  });

  it("encodes a PowerShell script as UTF-16 base64 that fits a Windows command line", () => {
    expect(powershell("echo é")).toBe("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ZQBjAGgAbwAgAOkA");
    for (const script of [FACTS_WINDOWS, PROCESSES_WINDOWS, diskUseWindows("C:\\Users\\" + "x".repeat(200))]) expect(powershell(script).length).toBeLessThan(7000);
    expect(() => powershell("x".repeat(6000))).toThrow("too long");
  });

  it("keeps a path out of the shell's reach", () => {
    expect(diskUseUnix("/tmp/a'; reboot; '")).toContain(`-- '/tmp/a'\\''; reboot; '\\'''`);
  });
});

describe("reading output", () => {
  it("strips escape sequences and control characters a server could print", () => {
    expect(clean("\x1b[31mred\x1b[0m\r\nbell\x07 ok\x1b]0;title\x07")).toBe("red\nbell ok]0;title");
  });

  it("splits sections and formats sizes and times", () => {
    expect(sections("junk\n@@a\n1\n2\n\n@@b\n@@c\nx\n")).toEqual({ a: ["1", "2"], b: [], c: ["x"] });
    expect([0, 1023, 1536, 1048576 * 5, 1e12].map(bytes)).toEqual(["0 B", "1023 B", "1.5 KB", "5.0 MB", "931 GB"]);
    expect([90, 3600 * 5 + 120, 86400 * 12 + 3600 * 3].map(duration)).toEqual(["1 minute", "5 hours, 2 minutes", "12 days, 3 hours"]);
    expect(table([["a", "bbb", "c"], ["dddd", "e", "f"]])).toEqual(["a     bbb  c", "dddd  e    f"]);
  });

  it("reads listening addresses", () => {
    expect(parseListen("0.0.0.0:22")).toEqual({ port: 22, open: true });
    expect(parseListen("[::]:445")).toEqual({ port: 445, open: true });
    expect(parseListen("*:9080")).toEqual({ port: 9080, open: true });
    expect(parseListen("10.1.2.3:80")).toEqual({ port: 80, open: true });
    expect(parseListen("127.0.0.53%lo:53")).toEqual({ port: 53, open: false });
    expect(parseListen("[::1]:631")).toEqual({ port: 631, open: false });
    expect(parseListen("::1:631")).toEqual({ port: 631, open: false });
    expect(parseListen("nonsense")).toBeNull();
  });

  it("keeps only real file systems from df", () => {
    expect(parseDf(DEBIAN.split("@@disk\n")[1].split("@@ports")[0].trim().split("\n")).map((d) => d.mount)).toEqual(["/", "/opt/dev"]);
    expect(parseDf(["Filesystem 1024-blocks Used Available Capacity Mounted on", "nas:/export 100 50 50 50% /mnt/my share"])[0].mount).toBe("/mnt/my share");
  });
});

describe("server facts", () => {
  it("summarises a Linux host", () => {
    const out = formatFactsUnix(DEBIAN);
    expect(out).toContain("devbox: Debian GNU/Linux 12 (bookworm)");
    expect(out).toContain("Linux 6.1.0-44-amd64 x86_64, 8 CPUs, Intel(R) Xeon(R) CPU E5-2695 v2 @ 2.40GHz");
    expect(out).toContain("Up        4 days, 3 hours");
    expect(out).toContain("Load      0.46 0.57 0.43 (8 CPUs)");
    expect(out).toContain("Memory    8.2 GB of 157 GB in use (5%), no swap");
    expect(out).toMatch(/\/ +32% of 147 GB +101 GB free/);
    expect(out).toMatch(/\/opt\/dev +58% of 147 GB/);
    expect(out).not.toMatch(/tmpfs|udev/);
    expect(out).toContain("from the network   22 ssh, 445 smb, 9080");
    expect(out).toContain("this machine only  53 dns, 2299");
    expect(out).toContain("Service vsftpd.service has failed");
    expect(out).not.toContain("Nothing looks wrong");
  });

  it("warns about a full disk, full memory and heavy load, and says so when all is well", () => {
    const bad = DEBIAN.replace("34% /", "95% /").replace("48981988  98588568", "146000000   8000000").replace("156257368", "10000000").replace("0.46 0.57 0.43", "40.00 30.00 20.00").replace("vsftpd.service", "");
    const out = formatFactsUnix(bad);
    expect(out).toContain("/ is 95% full");
    expect(out).toContain("Memory is 94% in use");
    expect(out).toContain("The load (40) is high for 8 CPUs");
    expect(formatFactsUnix(DEBIAN.replace("vsftpd.service", ""))).toContain("Nothing looks wrong");
  });

  it("copes with a bare-bones host", () => {
    const out = formatFactsUnix("@@host\nbox\n@@os\nFreeBSD 14.0-RELEASE amd64\n@@load\n 3:04PM  up 2 days, load averages: 0.10, 0.20, 0.30\n@@disk\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/ada0p2 1000 100 900 10% /\n");
    expect(out).toContain("box: FreeBSD");
    expect(out).toContain("Load      0.10, 0.20, 0.30");
    expect(out).toContain("none found");
  });

  it("summarises a Windows host, including PowerShell's one-item lists", () => {
    const json = JSON.stringify({
      host: "WIN1", os: "Microsoft Windows Server 2022 Standard", ver: "10.0.20348", arch: "64-bit", cpu: "Intel(R) Xeon(R)  Gold", cores: 4, up: 90000,
      memTotal: 8388608, memFree: 524288, me: "admin",
      disks: { name: "C:", size: 107374182400, free: 5368709120 },
      ports: [{ port: 3389, addr: "0.0.0.0" }, { port: 5985, addr: "::" }, { port: 135, addr: "127.0.0.1" }],
      stopped: "Spooler",
    });
    const out = formatFactsWindows(`#< CLIXML\n${json}`);
    expect(out).toContain("WIN1: Microsoft Windows Server 2022 Standard");
    expect(out).toContain("10.0.20348 64-bit, 4 CPUs, Intel(R) Xeon(R) Gold");
    expect(out).toContain("Up        1 day, 1 hour");
    expect(out).toContain("Memory    7.5 GB of 8.0 GB in use (94%)");
    expect(out).toMatch(/C: +95% of 100 GB/);
    expect(out).toContain("from the network   3389 rdp, 5985");
    expect(out).toContain("this machine only  135");
    expect(out).toContain("C: is 95% full");
    expect(out).toContain("Service Spooler is set to start automatically but isn't running");
    expect(() => formatFactsWindows("")).toThrow("nothing");
    expect(() => formatFactsWindows("Access denied")).toThrow("wasn't readable");
  });
});

describe("processes", () => {
  const PS = `    1 root      0.0  0.1 12-03:04:05 systemd
  812 www-data 41.5  2.0       05:12 nginx: worker
  813 postgres  3.2 30.5    1-02:03 postgres
  999 adam    299.0  0.0       00:00 ps
 1001 adam      0.1  0.4       00:10 sshd: adam@pts/0
garbage line`;

  it("reads ps and ranks by CPU and by memory, leaving out the ps that listed them", () => {
    expect(parsePs(PS)).toHaveLength(5);
    expect(parsePs(PS)[1]).toEqual({ pid: 812, user: "www-data", cpu: 41.5, mem: 2, time: "05:12", name: "nginx: worker" });
    const out = formatProcessesUnix(PS, 2);
    expect(out).toContain("4 processes");
    const [cpu, mem] = out.split("Hungriest (memory)");
    expect(cpu).toMatch(/nginx: worker[\s\S]*postgres/);
    expect(cpu).not.toMatch(/ ps$/m);
    expect(mem).toMatch(/postgres[\s\S]*nginx: worker/);
    expect(() => formatProcessesUnix("ps: unrecognized option")).toThrow("nothing readable");
  });

  it("ranks Windows processes by CPU time and by memory", () => {
    const out = formatProcessesWindows(JSON.stringify([{ id: 4, name: "System", cpu: 120, mem: 100000 }, { id: 800, name: "sqlservr", cpu: 36000, mem: 4e9 }, { id: 9, name: "idle", cpu: null, mem: 1 }]), 2);
    expect(out).toContain("3 processes");
    expect(out).toMatch(/800 +10 hours, 0 minutes +sqlservr/);
    expect(out).toMatch(/800 +3\.7 GB +sqlservr/);
  });
});

describe("disk use", () => {
  const DU = "9437184\t/var\n6291456\t/var/lib\n2097152\t/var/log\n1024\t/var/tmp\n";

  it("reads du and shares", () => {
    expect(parseDu(DU)).toHaveLength(4);
    const out = formatUsage("/var", parseDu(DU));
    expect(out).toContain("/var: 9.0 GB in all");
    expect(out).toMatch(/6\.0 GB +67% +lib/);
    expect(out).toMatch(/2\.0 GB +22% +log/);
    expect(out).not.toMatch(/^\s+9\.0 GB/m);
    expect(formatUsage("/", parseDu("100\t/usr\n300\t/\n")).split("\n")[0]).toContain("/: 300 KB");
    expect(() => formatUsage("/nope", [])).toThrow("Nothing found");
  });

  it("totals Windows folders itself", () => {
    const out = formatUsageWindows("C:\\Data", JSON.stringify({ name: "only", size: 2048 }));
    expect(out).toContain("C:\\Data: 2.0 KB in all");
    expect(formatUsageWindows("C:\\", JSON.stringify([{ name: "a", size: 3000 }, { name: "b", size: null }]))).toMatch(/2\.9 KB +100% +a/);
  });
});

describe("telling systems apart", () => {
  it("recognises Linux, other Unixes and Windows", () => {
    expect(osFromUname("Linux\n")).toBe("linux");
    expect(osFromUname("Darwin\n")).toBe("unix");
    expect(osFromUname("'uname' is not recognized as an internal or external command")).toBeNull();
    expect(osFromUname("")).toBeNull();
    expect(windowsFromVer("\r\nMicrosoft Windows [Version 10.0.20348.2113]\r\n")).toBe(true);
    expect(windowsFromVer("bash: cmd: command not found")).toBe(false);
  });

  it("has a facts script that stays portable", () => {
    expect(FACTS_UNIX).not.toMatch(/\[\[|<\(|\bfunction\b/); // no bash-only syntax: it runs under sh
    expect(FACTS_UNIX.split("\n").filter((l) => l.includes("@@")).length).toBeGreaterThanOrEqual(11);
  });
});
