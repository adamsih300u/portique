import { api } from "./api";
import {
  base64Decode, base64Encode, convertTime, decodeJwt, explainCron, formatJson, formatPing, formatPorts, generatePassword, generateToken, generateUuid, hashText,
  hexDecode, hexEncode, parsePing, parsePortCheck, parseWake, splitHost, subnet, urlDecode, urlEncode, type Generated,
} from "./toolbox-core";
import { field, h, modal, type ModalButton } from "./ui";

export interface Tool {
  id: string;
  title: string;
  /** The dialog's title, when it should say more than the palette row does (which server, say). */
  heading?: string;
  /** One line shown beside the title in the palette. */
  hint: string;
  /** Extra words that find it. */
  keywords: string;
  /** Asks for text first. Without it the tool runs as soon as it opens. */
  input?: { label: string; hint?: string; multiline?: boolean };
  /** Works out the answer as you type (the tool is quick and does not touch the network). */
  live?: boolean;
  /** Has an answer for empty input (a default length, the current time). Otherwise an empty box shows nothing. */
  blank?: boolean;
  /** Clears the clipboard 30 seconds after copying. */
  secret?: boolean;
  /** Label of the button that runs it again (generators). */
  again?: string;
  /** Runs at once when the dialog opens, though it asks for input (an optional filter). */
  auto?: boolean;
  /** Something to find out when the dialog opens, before a plan can be shown. A failure is shown in the dialog. */
  prepare?(): Promise<void>;
  /**
   * For a tool that changes something. The dialog shows `plan` as you type, nothing runs until the person presses the
   * button named `label` (Enter in the box only moves to it), and `run` is what the button does.
   */
  action?: {
    label: string;
    /** What will happen, in words and the exact command. Throws for an input that isn't valid yet. */
    plan(input: string): string;
    /** Offers "Type it in the terminal": types the command for the person to run themselves, and closes the dialog. */
    terminal?(input: string): void;
    /** Close the dialog once it has run. */
    closes?: boolean;
  };
  run(input: string): string | Generated | Promise<string | Generated>;
}

const firstHost = (s: string) => {
  const host = splitHost(s.trim().split(/\s+/)[0] ?? "").host;
  if (!host) throw new Error("Enter a host name or address");
  return host;
};

export const TOOLS: Tool[] = [
  // Network checks, run from this computer.
  {
    id: "port-check", title: "Port check…", hint: "is a TCP port open on a host?", keywords: "tcp open closed firewall connect scan reachable",
    input: { label: "Host and ports", hint: "like  example.com 22 80 8000-8010  or a URL. Leave the ports out to try the usual ones." },
    run: async (text) => {
      const { host, ports, common } = parsePortCheck(text);
      const r = await api.toolPorts(host, ports);
      return formatPorts(host, r.address, r.results, common);
    },
  },
  {
    id: "tcp-ping", title: "TCP ping…", hint: "time connections to a port", keywords: "latency rtt ping connect time reachable",
    input: { label: "Host, port and how many times", hint: "like  example.com 443  or  example.com 22 10  (4 times unless you say). Takes about a second per try." },
    run: async (text) => {
      const { host, port, count } = parsePing(text);
      const r = await api.toolTcpPing(host, port, count);
      return formatPing(host, port, r.address, r.results);
    },
  },
  {
    id: "dns-lookup", title: "DNS lookup…", hint: "the addresses a name resolves to", keywords: "resolve name address ip a aaaa nslookup dig host",
    input: { label: "Host name", hint: "as this computer's resolver sees it, so a VPN or hosts-file entry is included" },
    run: async (text) => {
      const host = firstHost(text);
      const ips = await api.toolDns(host);
      return [host, "", ...ips.map((ip) => `  ${ip.padEnd(40)}${ip.includes(":") ? "IPv6" : "IPv4"}`.trimEnd())].join("\n");
    },
  },
  {
    id: "wake", title: "Wake-on-LAN…", hint: "send a magic packet to a machine", keywords: "wol wake power on boot mac broadcast",
    input: { label: "MAC address and, if you like, the broadcast address", hint: "like  aa:bb:cc:dd:ee:ff  or  aa:bb:cc:dd:ee:ff 192.168.1.255. It only wakes machines on this network that have Wake-on-LAN switched on." },
    run: async (text) => {
      const { mac, broadcast } = parseWake(text);
      const sent = await api.toolWake(mac, broadcast);
      return `Sent a wake packet for ${sent} to ${broadcast || "255.255.255.255"} (UDP port 9).\nIt can't tell whether the machine woke; try a port check on it in a minute.`;
    },
  },
  {
    id: "subnet", title: "Subnet calculator…", hint: "network, mask, range and host count", keywords: "cidr ip netmask prefix broadcast wildcard range ipv4",
    input: { label: "Address and prefix", hint: "like  192.168.1.10/24  or  10.0.0.5 255.255.0.0" },
    live: true,
    run: (text) => subnet(text),
  },

  // Generators.
  {
    id: "password", title: "Generate a password", hint: "random, from this computer's secure source", keywords: "random secret strong generator passphrase",
    input: { label: "Length", hint: "8 to 128, 20 if empty. Add the word  simple  to leave out symbols." },
    live: true, blank: true, secret: true, again: "Another",
    run: (text) => generatePassword(text),
  },
  {
    id: "token", title: "Generate a random token", hint: "256 bits as hex and base64", keywords: "random secret key api hex generator",
    secret: true, again: "Another",
    run: () => generateToken(),
  },
  {
    id: "uuid", title: "Generate a UUID", hint: "a random version 4 id", keywords: "guid unique id generator",
    again: "Another",
    run: () => generateUuid(),
  },

  // Converters. They take the text you type or paste.
  { id: "base64-encode", title: "Base64 encode…", hint: "text to base64", keywords: "convert b64", input: { label: "Text", multiline: true }, live: true, run: base64Encode },
  { id: "base64-decode", title: "Base64 decode…", hint: "base64 (or the URL-safe kind) to text", keywords: "convert b64", input: { label: "Base64", multiline: true }, live: true, run: base64Decode },
  { id: "url-encode", title: "URL encode…", hint: "percent-encode text", keywords: "convert percent escape query", input: { label: "Text", multiline: true }, live: true, run: urlEncode },
  { id: "url-decode", title: "URL decode…", hint: "percent-encoded text to text", keywords: "convert percent unescape query", input: { label: "Encoded text", multiline: true }, live: true, run: urlDecode },
  { id: "hex-encode", title: "Hex encode…", hint: "text to hexadecimal", keywords: "convert bytes", input: { label: "Text", multiline: true }, live: true, run: hexEncode },
  { id: "hex-decode", title: "Hex decode…", hint: "hexadecimal to text", keywords: "convert bytes", input: { label: "Hex", multiline: true }, live: true, run: hexDecode },
  { id: "hash", title: "Hash text…", hint: "SHA-1, SHA-256, SHA-384 and SHA-512", keywords: "checksum digest sha sha1 sha256 sha512", input: { label: "Text", multiline: true }, live: true, run: hashText },
  { id: "jwt", title: "Decode a JWT…", hint: "read a token's header, payload and times", keywords: "json web token bearer claims expiry", input: { label: "Token", multiline: true }, live: true, run: (t) => decodeJwt(t) },
  { id: "time", title: "Time converter…", hint: "Unix time and dates, both ways", keywords: "timestamp epoch date unix utc iso now", input: { label: "Unix time or a date", hint: "leave it empty for now" }, live: true, blank: true, run: (t) => convertTime(t) },
  { id: "json-format", title: "Format JSON…", hint: "indent and check JSON", keywords: "pretty print validate beautify", input: { label: "JSON", multiline: true }, live: true, run: (t) => formatJson(t) },
  { id: "json-minify", title: "Minify JSON…", hint: "remove the spaces from JSON", keywords: "compact validate", input: { label: "JSON", multiline: true }, live: true, run: (t) => formatJson(t, true) },
  { id: "cron", title: "Explain a cron schedule…", hint: "in words, with the next five runs", keywords: "crontab schedule job minute hour", input: { label: "Cron expression", hint: "five fields, like  */15 9-17 * * mon-fri,  or a name like  @daily" }, live: true, run: (t) => explainCron(t) },
];

const CLEAR_AFTER_MS = 30_000;

/** The dialog every tool uses: an input if it wants one, the answer below it, and a Copy button. */
export async function openTool(tool: Tool) {
  const asked = tool.input;
  const input = asked
    ? asked.multiline
      ? h("textarea", { rows: 4, spellcheck: false, autocomplete: "off", "aria-label": asked.label })
      : h("input", { spellcheck: false, autocomplete: "off", "aria-label": asked.label })
    : null;
  const out = h("pre", { class: "tool-out", "aria-live": "polite" });
  const status = h("div", { class: "tool-status" });
  let result: Generated | null = null;
  let turn = 0;

  const show = (text: string, kind: "" | "wait" | "error" = "") => {
    out.textContent = text;
    out.className = `tool-out${kind ? ` ${kind}` : ""}`;
  };

  async function exec() {
    const mine = ++turn;
    status.textContent = "";
    const text = input?.value ?? "";
    if (asked && !tool.blank && !text.trim()) {
      result = null;
      return show("");
    }
    if (!tool.live) show("Working…", "wait");
    try {
      const r = await tool.run(text);
      if (mine !== turn) return;
      result = typeof r === "string" ? { text: r } : r;
      show(result.text);
    } catch (e) {
      if (mine !== turn) return;
      result = null;
      show(String((e as Error).message ?? e), "error");
    }
  }

  async function copy(): Promise<false> {
    if (!result) return false;
    const text = result.copy ?? result.text;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = tool.secret ? "Copied. The clipboard is cleared in 30 seconds." : "Copied.";
      if (tool.secret)
        setTimeout(() => {
          // Only clear what we put there; if it can't be read, leave it alone.
          navigator.clipboard.readText().then((now) => { if (now === text) void navigator.clipboard.writeText("").catch(() => {}); }).catch(() => {});
        }, CLEAR_AFTER_MS);
    } catch {
      status.textContent = "Couldn't reach the clipboard; select the text and copy it.";
    }
    return false;
  }

  const act = tool.action;
  /** Shows what the button would do, or why it can't yet. Returns whether the input is acceptable. */
  function plan(): boolean {
    turn++; // an old answer must not replace the plan
    result = null;
    status.textContent = "";
    const text = input?.value ?? "";
    if (!text.trim()) return show(""), false;
    try {
      show(act!.plan(text));
      return true;
    } catch (e) {
      show(String((e as Error).message ?? e), "error");
      return false;
    }
  }

  input?.addEventListener("input", () => (act ? plan() : tool.live && void exec()));
  input?.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Enter" || (asked?.multiline && !ke.ctrlKey)) return;
    ke.preventDefault();
    if (act) document.querySelector<HTMLElement>(".overlay .modal-buttons .primary")?.focus(); // the person presses it on purpose
    else if (tool.live) void copy();
    else void exec();
  });

  const body = h("div", {}, input ? field(asked!.label, input, asked!.hint) : null, out, status);
  const buttons: ModalButton[] = act
    ? [
        { label: "Close" },
        ...(act.terminal ? [{ label: "Type it in the terminal", action: () => (plan() ? act.terminal!(input!.value) : false) }] : []),
        {
          label: act.label,
          primary: true,
          action: async () => {
            if (!plan()) return false;
            await exec();
            return act.closes && result ? undefined : false;
          },
        },
      ]
    : [
        { label: "Close" },
        ...(tool.input && !tool.live ? [{ label: "Copy result", action: copy }, { label: "Run", primary: true, action: () => (void exec(), false as const) }] : []),
        ...(tool.again ? [{ label: tool.again, action: () => (void exec(), false as const) }] : []),
        ...(tool.live || !tool.input ? [{ label: "Copy", primary: true, action: copy }] : []),
      ];
  const shown = modal(tool.heading ?? tool.title.replace(/…$/, ""), body, buttons, true);
  // The modal focuses its first field itself. With none, focus the main button so Esc and Enter work.
  if (!input) document.querySelector<HTMLElement>(".overlay .modal-buttons .primary")?.focus();
  if (tool.prepare) {
    show("Checking the server…", "wait");
    tool.prepare().then(() => { if (act) plan(); else void exec(); }, (e) => show(String((e as Error).message ?? e), "error"));
  } else if (!asked || tool.live || tool.auto) void exec();
  await shown;
  turn++; // a lookup still running when the dialog closes has nobody to show its answer to
}
