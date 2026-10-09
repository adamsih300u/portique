import type { Profile } from "./api";
import { ApiSettings, AuthKind, sanitizeApiSettings } from "./http-model";
import { pairsTable } from "./http-request";
import { field, h } from "./ui";

const AUTH_OPTIONS: [AuthKind, string][] = [
  ["none", "None"],
  ["bearer", "Bearer token"],
  ["basic", "Username and password"],
  ["header", "API key in a header"],
  ["oauth2", "OAuth 2.0 (client credentials)"],
];

const COMMON_HEADERS = ["Accept", "Accept-Language", "User-Agent", "X-API-Key", "X-Api-Version", "X-Requested-With"];

/**
 * The settings of an API connection, as a form for the profile editor: where it points, how it signs in,
 * which headers every request carries, and how requests are sent. `ssh` are the SSH profiles requests can be sent from.
 */
export function apiConnectionForm(current: unknown, ssh: Profile[]) {
  const s: ApiSettings = sanitizeApiSettings(structuredClone(current));
  const note = (...c: (Node | string)[]) => h("p", { class: "muted" }, ...c);

  const base = h("input", { value: s.baseUrl, placeholder: "https://api.example.com/v1", spellcheck: false, autocomplete: "off" });
  base.addEventListener("input", () => { s.baseUrl = base.value.trim(); });

  const from = h("select", {}, h("option", { value: "" }, "This computer"),
    ...ssh.map((p) => h("option", { value: p.id, selected: p.id === s.via }, `${p.name} (${p.host})`)));
  if (s.via && !ssh.some((p) => p.id === s.via)) from.append(h("option", { value: s.via, selected: true }, "(an SSH host that no longer exists)"));
  from.value = s.via;
  from.addEventListener("change", () => { s.via = from.value; });

  // sign-in
  const kind = h("select", {}, ...AUTH_OPTIONS.map(([v, l]) => h("option", { value: v, selected: v === s.auth.kind }, l)));
  const fields = h("div", { class: "api-conn-fields" });
  const drawAuth = () => {
    const a = s.auth;
    const mk = (label: string, key: "token" | "user" | "pass" | "name" | "value" | "tokenUrl" | "clientId" | "clientSecret" | "scope", secret = false, ph = "") => {
      const i = h("input", { value: a[key], type: secret ? "password" : "text", spellcheck: false, autocomplete: "off", placeholder: ph });
      i.addEventListener("input", () => { a[key] = i.value; });
      return field(label, i);
    };
    const parts: Node[] = ({
      inherit: () => [],
      none: () => [],
      bearer: () => [mk("Token", "token", false, "{{token}}")],
      basic: () => [mk("Username", "user"), mk("Password", "pass", true)],
      header: () => [mk("Header name", "name", false, "X-API-Key"), mk("Value", "value", false, "{{apiKey}}")],
      oauth2: () => [mk("Token URL", "tokenUrl", false, "https://login.example.com/oauth/token"), mk("Client ID", "clientId", false, "{{clientId}}"), mk("Client secret", "clientSecret", true, "{{clientSecret}}"), mk("Scope (optional)", "scope")],
    }[a.kind] as () => Node[])();
    fields.replaceChildren(...parts, ...(parts.length ? [note("Tip: keep secrets in an environment and enter them here as ", h("code", {}, "{{name}}"), ". They then stay in the vault, out of this file.")] : []));
  };
  kind.addEventListener("change", () => { s.auth.kind = kind.value as AuthKind; drawAuth(); });
  drawAuth();

  // headers sent with every request
  const names = h("datalist", { id: "api-conn-header-names" }, ...COMMON_HEADERS.map((n) => h("option", { value: n })));
  const headers = pairsTable(s.headers, () => {}, { key: "Header", value: "value", names: "api-conn-header-names" });

  // options
  const follow = h("input", { type: "checkbox", checked: s.follow });
  const insecure = h("input", { type: "checkbox", checked: s.insecure });
  const timeout = h("input", { type: "number", min: "1", max: "3600", value: String(s.timeout), class: "api-num" });
  follow.addEventListener("change", () => { s.follow = follow.checked; });
  insecure.addEventListener("change", () => { s.insecure = insecure.checked; });
  timeout.addEventListener("input", () => { s.timeout = Math.max(1, Number(timeout.value) || 30); });

  const el = h("div", { class: "api-conn" },
    field("Base address", base, "Requests are written relative to this, such as /users/42. It may contain {{variables}}."),
    field("Send from", from, "Choose an SSH host to send every request from there. It also looks up the address, so private services only that server can reach work."),
    h("h3", {}, "Sign in"),
    field("Method", kind), fields,
    h("h3", {}, "Headers"),
    names, headers.el, note("Sent with every request on this connection. A request can replace one by adding a header of the same name."),
    h("details", { class: "fwd-section", open: !s.follow || s.insecure || s.timeout !== 30 },
      h("summary", {}, "Options"),
      h("label", { class: "check" }, follow, " Follow redirects"),
      h("label", { class: "check" }, insecure, " Allow self-signed certificates"),
      note("Only for servers you trust, such as a test machine. The connection is still encrypted, but the server's identity isn't checked."),
      field("Give up after (seconds)", timeout)));

  return {
    el,
    /** The settings as edited. */
    read: (): ApiSettings => ({ ...structuredClone(s), baseUrl: s.baseUrl.trim(), headers: s.headers.filter((p) => p.key.trim() || p.value.trim()) }),
    /** A problem to tell the user about, or null. */
    problem: (): string | null => (s.auth.kind === "oauth2" && !s.auth.tokenUrl.trim() ? "Enter the token URL for OAuth 2.0 sign-in" : null),
  };
}
