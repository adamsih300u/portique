import { newProfile, type Profile } from "./api";

export interface QuickTarget {
  protocol: "ssh" | "telnet";
  /** Empty when the text had no `user@`. */
  user: string;
  host: string;
  port: number;
  /** The text is plainly an address (an IP, a dotted name, or has a scheme, user or port), not a bare word that might be a search. */
  clear: boolean;
}

const DEFAULT_PORT = { ssh: 22, telnet: 23 } as const;
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?";
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.?$`);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loose IPv6 check: hex groups, at most one `::`, and eight groups unless it is compressed. */
function isIpv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || s.includes(":::") || (s.match(/::/g) ?? []).length > 1) return false;
  const groups = s.split(":").filter((g) => g !== "");
  if (groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g) && !IPV4.test(g))) return false;
  return s.includes("::") ? groups.length <= 7 : groups.length === 8;
}

const validPort = (s: string) => /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;

/** Reads what was typed into the palette as `[ssh://|telnet://][user@]host[:port]` (an IPv6 address goes in brackets when it has a port); null if it isn't one. */
export function parseQuickTarget(text: string): QuickTarget | null {
  let rest = text.trim();
  if (!rest || /\s/.test(rest)) return null;
  let protocol: QuickTarget["protocol"] = "ssh";
  let scheme = false;
  const m = /^(ssh|telnet):\/\//i.exec(rest);
  if (m) {
    protocol = m[1].toLowerCase() as QuickTarget["protocol"];
    scheme = true;
    rest = rest.slice(m[0].length);
  }
  rest = rest.replace(/\/$/, "");
  let user = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!user || /[:/\\]/.test(user)) return null;
  }
  let host = rest;
  let port = "";
  let bracketed = false;
  const b = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (b) {
    host = b[1];
    port = b[2] ?? "";
    bracketed = true;
    if (!isIpv6(host)) return null;
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    [host, port] = rest.split(":");
    if (!validPort(port)) return null;
  } else if (rest.includes(":")) {
    if (!isIpv6(rest)) return null; // a bare IPv6 address has no port
  }
  if (b && port && !validPort(port)) return null;

  const isV6 = bracketed || host.includes(":");
  const v4 = IPV4.exec(host);
  if (v4) {
    if (v4.slice(1).some((o) => +o > 255)) return null;
  } else if (!isV6) {
    if (!NAME.test(host) || /^\d+$/.test(host) || host.length > 253) return null;
  }
  const clear = scheme || !!user || !!port || isV6 || !!v4 || host.includes(".");
  return { protocol, user, host, port: port ? +port : DEFAULT_PORT[protocol], clear };
}

/** The tab name: the host as typed, with the port when it isn't the usual one. */
export function quickLabel(t: QuickTarget): string {
  const host = t.host.includes(":") ? `[${t.host}]` : t.host;
  return t.port === DEFAULT_PORT[t.protocol] ? t.host : `${host}:${t.port}`;
}

/** A profile for the target, not yet registered with the backend. */
export function quickProfileFor(t: QuickTarget, user: string): Profile {
  return { ...newProfile(), protocol: t.protocol, name: quickLabel(t), host: t.host, port: t.port, username: user };
}

/** Quick-connect profiles live in memory only, so there is nothing to save a password under. */
export const isQuick = (p: Profile) => p.id.startsWith("quick:");
