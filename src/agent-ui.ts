import { listen } from "@tauri-apps/api/event";
import { activityLine, endpointNote, MODE_CHOICES, questionCopy } from "./agent-core";
import { api, type AgentAudit, type AgentConfigKind, type AgentDecision, type AgentMode, type AgentQuestion, type AgentStatus, type Profile, type Protocol } from "./api";
import { field, h, modal } from "./ui";

/** An agent opened a session; the app shows it in a tab. */
export interface AgentSessionEvent {
  session: string;
  profile: string;
  name: string;
  protocol: Protocol;
  client: string;
}

/** Grant buttons stay off for a moment, so a key pressed for the terminal behind the dialog cannot answer it. */
const SETTLE_MS = 700;

const queue: AgentQuestion[] = [];
let shown: { id: string; close: () => void } | null = null;

/** Listens for what agents do: questions to answer, and sessions to show. */
export function watchAgents(onSession: (e: AgentSessionEvent) => void) {
  void listen<AgentQuestion>("agent-approval", (e) => {
    queue.push(e.payload);
    present();
  });
  void listen<{ id: string }>("agent-approval-closed", (e) => {
    const at = queue.findIndex((q) => q.id === e.payload.id);
    if (at >= 0) queue.splice(at, 1);
    if (shown?.id === e.payload.id) shown.close();
  });
  void listen<AgentSessionEvent>("agent-session", (e) => onSession(e.payload));
}

/** Shows the next waiting question, one at a time. Escape and closing the dialog both answer no. */
function present() {
  if (shown || !queue.length) return;
  const q = queue.shift()!;
  const c = questionCopy(q);
  // A question that wants the master password gets a box for it; only a correct password can allow it.
  const pw = c.needsPassword
    ? h("input", { type: "password", class: "agent-password", autocomplete: "off", placeholder: "Master password", "aria-label": "Master password" })
    : null;
  const problem = h("p", { class: "warn agent-note" });
  const buttons = c.buttons.map((b) =>
    h("button", { class: b.safe ? "primary" : "", disabled: !b.safe, onclick: () => (b.safe || !pw ? answer(b.decision) : void allow(b.decision)) }, b.label));
  const overlay = h("div", { class: "overlay" },
    h("div", { class: "modal agent-ask", role: "alertdialog", "aria-modal": "true" },
      h("h2", {}, c.title),
      h("div", { class: "modal-body" },
        h("p", { class: "agent-lead" }, c.lead),
        h("pre", { class: "agent-text" }, c.code), // text from the agent: never markup
        c.note ? h("p", { class: "agent-note" }, c.note) : null,
        pw,
        problem),
      h("div", { class: "modal-buttons" }, ...buttons)));
  const settle = window.setTimeout(() => {
    buttons.forEach((b) => (b.disabled = false));
    pw?.focus(); // not before: keys meant for the terminal behind the dialog must not land in the box
  }, SETTLE_MS);
  let done = false;
  const close = () => {
    if (done) return; // the backend's "closed" can arrive just after our own answer
    done = true;
    clearTimeout(settle);
    if (pw) pw.value = "";
    overlay.remove();
    shown = null;
    present();
  };
  const answer = (decision: "deny" | "once" | "session") => {
    void api.agentAnswer(q.id, decision).catch(() => {});
    close();
  };
  /** Sends the password with the answer. A wrong one is shown here and the question stays open. */
  const allow = async (decision: AgentDecision) => {
    if (!pw?.value) {
      problem.textContent = "Enter your master password to allow it.";
      pw?.focus();
      return;
    }
    problem.textContent = "Checking…";
    buttons.forEach((b) => (b.disabled = true));
    try {
      await api.agentAnswerPassword(q.id, decision, pw.value);
      close();
    } catch (e) {
      problem.textContent = String(e);
      pw.value = "";
      buttons.forEach((b) => (b.disabled = false));
      pw.focus();
    }
  };
  pw?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !buttons[1].disabled) buttons[1].click();
  });
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && answer("deny"));
  shown = { id: q.id, close };
  document.body.append(overlay);
  buttons[0].focus();
}

/** Asks how far agents may go on a profile. Resolves with the choice, or null if cancelled. */
export async function agentAccessDialog(p: Profile, current: AgentMode, agentsOn: boolean): Promise<AgentMode | null> {
  const name = `agent-mode-${p.id}`;
  const radios = MODE_CHOICES.map((m) => ({ m, input: h("input", { type: "radio", name, value: m.mode, checked: m.mode === current }) }));
  const body = h("div", {},
    h("p", {}, `What may an AI agent do on ${p.name}?`),
    ...radios.map(({ m, input }) => h("label", { class: "check agent-choice" }, input, h("span", {}, h("strong", {}, m.label), h("small", {}, m.hint)))),
    h("p", { class: "agent-note" }, p.protocol === "local"
      ? "An agent gets a shell on this computer, with your account's rights."
      : "The agent uses the login Portique has saved; it never sees the password or key."),
    agentsOn ? null : h("p", { class: "warn" }, "Agent access is switched off in Settings, so this takes effect once you turn it on."));
  let chosen: AgentMode | null = null;
  await modal("Agent access", body, [
    { label: "Cancel" },
    {
      label: "Save",
      primary: true,
      action: async () => {
        const mode = radios.find((r) => r.input.checked)?.m.mode ?? "off";
        await api.agentSetMode(p.id, mode);
        chosen = mode;
      },
    },
  ]);
  return chosen;
}

/** The activity log of this run: what agents opened, ran and typed, and what the person refused. Kept in memory only. */
export async function agentActivityDialog() {
  const log: AgentAudit[] = await api.agentActivity().catch(() => []);
  const lines = log.slice().reverse().map((a) => activityLine(a));
  await modal("Agent activity", h("div", {},
    h("p", { class: "agent-note" }, "Newest first. This is kept in memory while Portique runs and is never written to disk."),
    h("pre", { class: "agent-log" }, lines.length ? lines.join("\n") : "Nothing yet.")), [{ label: "Close", primary: true }], true);
}

const CONFIG_KINDS: { kind: AgentConfigKind; label: string; hint: string }[] = [
  { kind: "stdio", label: "Command (JSON settings)", hint: "For agent programs that start MCP servers as a command. It holds no secret and keeps working after Portique restarts." },
  { kind: "command", label: "Command (one line)", hint: "The same command on one line, for programs that add a server from the command line." },
];

/** Shows the text to give an agent program, so it can be read before it is pasted anywhere. */
export async function agentConfigDialog(kind: AgentConfigKind = "stdio") {
  const pick = h("select", {}, ...CONFIG_KINDS.map((k) => h("option", { value: k.kind }, k.label)));
  pick.value = kind;
  const text = h("textarea", { readOnly: true, rows: 9, spellcheck: false, class: "agent-config" });
  const hint = h("small", {}, "");
  const status = h("small", { class: "agent-note" }, "");
  const load = async () => {
    status.textContent = "";
    hint.textContent = CONFIG_KINDS.find((k) => k.kind === pick.value)?.hint ?? "";
    try {
      text.value = await api.agentConfig(pick.value as AgentConfigKind);
    } catch (e) {
      text.value = "";
      status.textContent = String(e);
    }
  };
  pick.addEventListener("change", () => void load());
  await load();
  await modal("Connect an agent", h("div", {}, field("Form", pick, undefined), hint, text, status), [
    { label: "Close" },
    {
      label: "Copy",
      primary: true,
      action: async () => {
        await navigator.clipboard.writeText(text.value);
        status.textContent = "Copied.";
        return false;
      },
    },
  ], true);
}

/** The settings pane's block for agent access. `enabled()` is what the box says now; the pane applies it on Save. */
export function agentSection(status: AgentStatus | null, requirePassword: boolean) {
  const on = h("input", { type: "checkbox", checked: status?.enabled ?? false });
  const needPw = h("input", { type: "checkbox", checked: requirePassword });
  const note = h("small", { class: "agent-note" }, endpointNote(status?.enabled ?? false, status?.endpoint?.url ?? null));
  const buttons = h("div", { class: "agent-buttons" },
    h("button", { type: "button", onclick: () => void agentConfigDialog() }, "Connect an agent…"),
    h("button", { type: "button", onclick: () => void agentActivityDialog() }, "Activity…"));
  const sync = () => {
    buttons.hidden = !(status?.enabled && on.checked);
  };
  on.addEventListener("change", sync);
  sync();
  const el = h("div", {},
    h("h3", {}, "Agent access"),
    h("label", { class: "check" }, on, " Let AI agents use terminals (MCP)"),
    note,
    h("small", { class: "agent-note" }, "Agents can only use profiles you switch on (right-click a profile → Agent access), only in sessions they open themselves, and you watch each one in a tab."),
    h("label", { class: "check" }, needPw, " Ask for my password before an agent runs commands"),
    h("small", { class: "agent-note" }, "Once per session, until the vault locks. It uses your master password, so it applies once you have a vault."),
    buttons);
  return { el, enabled: () => on.checked, requirePassword: () => needPw.checked };
}
