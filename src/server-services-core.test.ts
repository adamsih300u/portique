/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTAINERS_UNIX, SERVICES_UNIX, containerActionUnix, containerLogUnix, containerName, containerPlanUnix, followCommand, formatContainerAction, formatContainerLog,
  formatContainers, formatLog, formatServiceAction, formatServiceActionWindows, formatServices, formatServicesWindows, parseContainers, parseServices, serviceActionUnix,
  serviceActionWindows, serviceLogUnix, servicePlanUnix, servicePlanWindows, shortPorts, unitName, windowsServiceName,
} from "./server-services-core";

// ---------------------------------------------------------------- scripts run under a real sh with fake programs

const posix = process.platform !== "win32";

/** A folder of fake programs. The script under test sees only these (and the shell's own built-ins). */
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), "portique-fake-"));
  const put = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  for (const tool of ["head", "cat", "tr"]) symlinkSync(`/usr/bin/${tool}`, join(dir, tool));
  put("id", 'echo "${FAKE_UID:-1000}"');
  put("sudo", `if [ "$1" = -n ] && [ "$2" = true ]; then [ "$FAKE_SUDO" = ok ]; exit $?; fi
if [ "$1" = -n ]; then shift; echo "sudo $*" >> "$FAKE_LOG"; exec "$@"; fi
exit 9`);
  put("systemctl", `echo "systemctl $*" >> "$FAKE_LOG"
case "$1" in
  status) echo "● $2 - Fake unit"; echo "     Active: active (running)"; exit 0;;
  start|stop|restart|reload) if [ -n "$FAKE_FAIL" ]; then echo "$FAKE_FAIL" >&2; exit 1; fi; exit 0;;
esac`);
  put("docker", `echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  info) [ -z "$FAKE_DENIED" ] || { echo "permission denied while trying to connect" >&2; exit 1; }; exit 0;;
  ps) echo 'web|nginx:1.27|Up 3 days|0.0.0.0:80->80/tcp, [::]:80->80/tcp'; echo 'old|busybox|Exited (0) 2 weeks ago|';;
  restart|start|stop) if [ -n "$FAKE_FAIL" ]; then echo "$FAKE_FAIL" >&2; exit 1; fi;;
  logs) echo "line one"; echo "line two";;
esac`);
  return dir;
}

/** The calls in a log that change something (not the read-only status check), and whether sudo wrapped them. */
const changes = (log: string[]) => log.filter((l) => !l.startsWith("sudo") && !/ (status|info|ps) /.test(`${l} `));
const sudoed = (log: string[]) => log.some((l) => l.startsWith("sudo"));

function sh(script: string, dir: string, env: Record<string, string> = {}) {
  const log = join(dir, "log");
  writeFileSync(log, "");
  const out = execFileSync("/bin/sh", [], { input: script, encoding: "utf8", env: { PATH: dir, FAKE_LOG: log, ...env } });
  return { out, log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

describe.skipIf(!posix)("the scripts, run under sh with fake programs", () => {
  it("restarts a service through sudo -n when this account isn't root, and reports the result", () => {
    const dir = fakes();
    const { out, log } = sh(serviceActionUnix("restart", "nginx"), dir, { FAKE_SUDO: "ok" });
    expect(log[0]).toBe("sudo systemctl restart nginx");
    expect(changes(log)).toEqual(["systemctl restart nginx"]);
    const text = formatServiceAction("restart", "nginx", out);
    expect(text).toContain("Restarted nginx (through sudo -n).");
    expect(text).toContain("Active: active (running)");
  });

  it("runs straight as root, with no sudo", () => {
    const dir = fakes();
    const { out, log } = sh(serviceActionUnix("stop", "ssh"), dir, { FAKE_UID: "0", FAKE_SUDO: "deny" });
    expect(sudoed(log)).toBe(false);
    expect(changes(log)).toEqual(["systemctl stop ssh"]);
    expect(formatServiceAction("stop", "ssh", out)).toContain("Stopped ssh.");
  });

  it("says plainly that a password is needed, and never tries one", () => {
    const dir = fakes();
    const { out, log } = sh(serviceActionUnix("restart", "nginx"), dir, { FAKE_SUDO: "deny", FAKE_FAIL: "Failed to restart nginx.service: Interactive authentication required." });
    expect(sudoed(log)).toBe(false); // sudo -n was refused, so the command ran as the plain account and failed there
    expect(changes(log)).toEqual(["systemctl restart nginx"]);
    expect(() => formatServiceAction("restart", "nginx", out)).toThrow(/Couldn't restart nginx[\s\S]*Interactive authentication required[\s\S]*never types a password/);
  });

  it("reports a failure that is not about rights as it is", () => {
    const dir = fakes();
    const { out } = sh(serviceActionUnix("start", "nope"), dir, { FAKE_UID: "0", FAKE_FAIL: "Failed to start nope.service: Unit nope.service not found." });
    expect(() => formatServiceAction("start", "nope", out)).toThrow(/not found/);
    expect(() => formatServiceAction("start", "nope", out)).not.toThrow(/never types a password/);
  });

  it("chooses sudo -n for docker only when the plain account is refused", () => {
    const dir = fakes();
    let r = sh(CONTAINERS_UNIX, dir, { FAKE_SUDO: "ok" });
    expect(r.log.some((l) => l.startsWith("sudo"))).toBe(false);
    r = sh(CONTAINERS_UNIX, dir, { FAKE_SUDO: "ok", FAKE_DENIED: "1" });
    expect(r.log).toContain("sudo docker ps -a --format {{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}");
    expect(formatContainers(r.out, "devbox")).toContain("through sudo -n");
  });

  it("lists containers, restarts one and reads its log", () => {
    const dir = fakes();
    const list = formatContainers(sh(CONTAINERS_UNIX, dir).out, "devbox");
    expect(list).toContain("2 containers on devbox (docker): 1 running, 1 stopped");
    expect(list).toMatch(/Running\n {2}web +nginx:1\.27 +Up 3 days +80->80\/tcp\n/);
    expect(list).toMatch(/Stopped\n {2}old +busybox +Exited \(0\) 2 weeks ago/);
    const act = sh(containerActionUnix("restart", "web"), dir);
    expect(act.log[0]).toBe("docker info");
    expect(act.log).toContain("docker restart web");
    expect(formatContainerAction("restart", "web", act.out)).toContain("Restarted web.");
    expect(formatContainerLog(sh(containerLogUnix("web"), dir).out, "web")).toBe("line one\nline two");
  });

  it("explains a container engine that the account can't use", () => {
    expect(() => formatContainers("@@engine\ndocker\n@@sudo\nnone\n@@list\npermission denied while trying to connect to the docker API", "h")).toThrow(/can't use docker[\s\S]*no passwordless sudo/);
  });

  it("finds no engine on a server without docker or podman", () => {
    const empty = mkdtempSync(join(tmpdir(), "portique-empty-"));
    const out = execFileSync("/bin/sh", [], { input: CONTAINERS_UNIX, encoding: "utf8", env: { PATH: empty } });
    expect(() => formatContainers(out, "h")).toThrow("Neither docker nor podman");
  });

  it("never lets a name become shell code", () => {
    const dir = fakes();
    for (const bad of ["x; touch pwned", "$(touch pwned)", "`touch pwned`", "a b", "-rf", "x'y", "x\ny", "x|y", "../etc", ""]) {
      expect(() => serviceActionUnix("restart", bad), bad).toThrow();
      expect(() => containerActionUnix("restart", bad), bad).toThrow();
      expect(() => serviceLogUnix(bad), bad).toThrow();
    }
    // A valid name is quoted in the script, so even an odd but allowed one stays one word.
    const { log } = sh(serviceActionUnix("restart", "my.app@1:x_y-z"), dir, { FAKE_UID: "0" });
    expect(changes(log)).toEqual(["systemctl restart my.app@1:x_y-z"]);
  });
});

// ---------------------------------------------------------------- names, plans and readers

describe("names", () => {
  it("accepts what systemd, docker and Windows accept", () => {
    expect(unitName(" nginx.service ")).toBe("nginx.service");
    expect(unitName("getty@tty1")).toBe("getty@tty1");
    expect(containerName("my_app-1.2")).toBe("my_app-1.2");
    expect(containerName("3f4a9c1d2e0b")).toBe("3f4a9c1d2e0b");
    expect(windowsServiceName("Print Spooler")).toBe("Print Spooler");
    expect(() => windowsServiceName("x'; Stop-Computer; '")).toThrow();
    expect(() => windowsServiceName("")).toThrow("Enter");
  });

  it("states what will run before it runs", () => {
    expect(servicePlanUnix("restart", "nginx")).toContain("systemctl restart nginx");
    expect(servicePlanUnix("restart", "nginx")).toContain("sudo -n");
    expect(servicePlanUnix("stop", "nginx")).toContain("cut off");
    expect(servicePlanUnix("start", "nginx")).not.toContain("cut off");
    expect(containerPlanUnix("stop", "web")).toContain("docker stop web");
    expect(servicePlanWindows("restart", "Spooler")).toContain("Restart-Service -Name 'Spooler'");
    expect(() => servicePlanUnix("restart", "a b")).toThrow();
  });

  it("builds the command to follow a log in the terminal", () => {
    expect(followCommand("/var/log/syslog")).toBe("tail -n 100 -f -- '/var/log/syslog'");
    expect(followCommand("/var/log/it's.log")).toBe(`tail -n 100 -f -- '/var/log/it'\\''s.log'`);
    expect(followCommand("nginx")).toBe("journalctl -u 'nginx' -n 100 -f");
    expect(() => followCommand("")).toThrow();
    expect(() => followCommand("x; rm -rf /")).toThrow();
    expect(() => followCommand("/tmp/a\nb")).toThrow();
  });
});

describe("reading services", () => {
  const LIST = `@@list
apparmor.service                     loaded    active   exited  Load AppArmor profiles
cron.service                         loaded    active   running Regular background program processing daemon
auditd.service                       not-found inactive dead    auditd.service
apt-daily.service                    loaded    inactive dead    Daily apt download activities
vsftpd.service                       loaded    failed   failed  LSB: Very Secure Ftp Daemon
ssh.service                          loaded    active   running OpenBSD Secure Shell server
`;

  it("reads systemctl's table and leaves out units that don't exist", () => {
    expect(parseServices(LIST).map((s) => s.unit)).toEqual(["apparmor.service", "cron.service", "apt-daily.service", "vsftpd.service", "ssh.service"]);
    expect(parseServices("● x.service loaded failed failed X\n")[0]).toMatchObject({ unit: "x.service", active: "failed" });
  });

  it("summarises, with failures first", () => {
    const out = formatServices(LIST, "devbox");
    expect(out).toContain("5 services on devbox: 2 running, 1 failed, 2 stopped or finished");
    expect(out).toMatch(/Failed\n {2}failed +vsftpd +LSB: Very Secure Ftp Daemon/);
    expect(out).toMatch(/Running \(2\)\n {2}running +cron[\s\S]*ssh/);
    expect(out).not.toContain("auditd");
  });

  it("filters by name or description, stopped ones included", () => {
    const out = formatServices(LIST, "devbox", "apt");
    expect(out).toContain('1 of 5 services on devbox match "apt"');
    expect(out).toMatch(/stopped +apt-daily +Daily apt download/);
    expect(formatServices(LIST, "devbox", "SECURE")).toMatch(/ssh/);
    expect(() => formatServices(LIST, "devbox", "zzz")).toThrow('No service matches "zzz"');
    expect(() => formatServices("@@nosystemd\n", "h")).toThrow("doesn't use systemd");
    expect(() => formatServices("@@list\nFailed to connect to bus", "h")).toThrow("listed no services");
  });

  it("reads Windows services, including a single one", () => {
    const json = JSON.stringify([{ name: "Spooler", display: "Print Spooler", status: "Running" }, { name: "Fax", display: "Fax", status: "Stopped" }, { name: "W32Time", display: "Windows Time", status: "Running" }]);
    expect(formatServicesWindows(json, "WIN1")).toMatch(/3 services on WIN1: 2 running, 1 stopped[\s\S]*running +Spooler +Print Spooler/);
    expect(formatServicesWindows(json, "WIN1", "fax")).toMatch(/stopped +Fax/);
    expect(formatServicesWindows(JSON.stringify({ name: "A", display: "A svc", status: "Running" }), "W")).toContain("1 services on W");
    expect(() => formatServicesWindows("", "W")).toThrow("nothing");
  });

  it("reads Windows service actions", () => {
    expect(serviceActionWindows("restart", "Spooler")).toContain("Restart-Service -Name $n");
    expect(serviceActionWindows("restart", "Print Spooler")).toContain("$n='Print Spooler'");
    expect(formatServiceActionWindows("restart", "Spooler", '{"rc":0,"out":"","status":"Running"}')).toBe("Restarted Spooler. It is now running.");
    expect(() => formatServiceActionWindows("stop", "Spooler", '{"rc":1,"out":"Cannot open Spooler service: Access is denied","status":"Running"}')).toThrow(/Access is denied[\s\S]*administrator/);
  });
});

describe("reading containers and logs", () => {
  it("shortens port lists", () => {
    expect(shortPorts("0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp")).toBe("80->80/tcp, 443->443/tcp");
    expect(shortPorts(":::8080->8080/tcp")).toBe("8080->8080/tcp");
    expect(shortPorts("")).toBe("");
    expect(shortPorts("5432/tcp")).toBe("5432/tcp");
  });

  it("reads container lines and ignores noise", () => {
    expect(parseContainers(["a|img|Up 1 hour|0.0.0.0:1->1/tcp", "WARNING: something", "b|img2|Exited (1) 2 days ago|"])).toHaveLength(2);
  });

  it("says when there are none", () => {
    expect(formatContainers("@@engine\npodman\n@@sudo\nnone\n@@list\n", "h")).toBe("No containers on h (podman).");
  });

  it("reads a failed container action and a missing container's log", () => {
    expect(() => formatContainerAction("stop", "web", "@@rc\n1\n@@out\nError response from daemon: No such container: web\n@@sudo\nnone\n")).toThrow(/No such container/);
    expect(() => formatContainerAction("stop", "web", "@@rc\n1\n@@out\npermission denied\n@@sudo\nnone\n")).toThrow(/never types a password/);
    expect(() => formatContainerLog("@@engine\ndocker\n@@sudo\nnone\n@@log\nError response from daemon: No such container: web\n", "web")).toThrow("no container called web");
    expect(formatContainerLog("@@engine\ndocker\n@@sudo\nnone\n@@log\n", "web")).toBe("web has printed nothing.");
  });

  it("drops journalctl's permission hint and says what it means", () => {
    const hint = "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n";
    expect(() => formatLog(`@@log\n${hint}-- No entries --\n`, "ssh")).toThrow(/No journal entries for ssh[\s\S]*systemd-journal or adm group/);
    const out = formatLog(`@@log\n${hint}Oct 09 sshd[1]: Accepted\nOct 09 sshd[1]: Closed\n`, "ssh");
    expect(out).toMatch(/^Oct 09 sshd\[1\]: Accepted\nOct 09 sshd\[1\]: Closed\n\n\(This account can't see the whole/);
    expect(formatLog("@@log\nOct 09 x: y\n", "x")).toBe("Oct 09 x: y");
    expect(() => formatLog("@@nojournal\n", "x")).toThrow("no journalctl");
  });

  it("has services and containers scripts that stay portable and read-only", () => {
    for (const s of [SERVICES_UNIX, CONTAINERS_UNIX]) {
      expect(s).not.toMatch(/\[\[|<\(|\bfunction\b/);
      expect(s).not.toMatch(/\b(restart|stop|start|rm|kill)\b/);
    }
  });
});
