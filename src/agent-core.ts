import type { AgentAudit, AgentDecision, AgentMode, AgentQuestion, AgentSessionInfo } from "./api";

/** The three levels of access a profile can give an agent, in the order the dialog lists them. */
export const MODE_CHOICES: { mode: AgentMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "Agents cannot see this profile." },
  { mode: "ask", label: "Ask me each time", hint: "Agents can open it and type into it, but you see the exact command and say yes or no first." },
  { mode: "allow", label: "Allow", hint: "Agents can open it and run commands without asking. Use it where a mistake is cheap." },
];

/** What the profile menu says about the current access. */
export function modeMenuLabel(mode: AgentMode): string {
  return mode === "ask" ? "Agent access: asks first…" : mode === "allow" ? "Agent access: allowed…" : "Agent access…";
}

export interface AnswerButton {
  label: string;
  decision: AgentDecision;
  /** The button that grants the most is never the default; this marks the safe one. */
  safe?: boolean;
}

export interface QuestionCopy {
  title: string;
  lead: string;
  /** Exactly what would run or be typed, shown as it is. */
  code: string;
  note: string;
  buttons: AnswerButton[];
}

/** Past this many characters the box that shows a command scrolls, so the dialog says so. */
export const LONG_TEXT = 600;

/**
 * Data the terminal sends by itself, in answer to a program's questions or to the window gaining focus: device and
 * cursor-position reports, focus changes, and the replies to colour and string queries. Anything else it sends is the
 * person (a key, a paste, drag and drop, input-method text), and takes the keyboard from an agent.
 */
export function isTerminalReply(data: string): boolean {
  return REPLY.test(data);
}

const ESC = String.fromCharCode(27);
const REPLY = new RegExp(`^${ESC}(?:\\[[?>]?[0-9;:]*[cRnIOt]|[\\]P][\\s\\S]*)$`);

/** The words of a dialog that asks the person to let an agent do something. */
export function questionCopy(q: AgentQuestion): QuestionCopy {
  const c = baseCopy(q);
  if (q.text.length > LONG_TEXT) {
    c.note = `${c.note ? c.note + " " : ""}This one is ${q.text.length.toLocaleString("en-US")} characters long; scroll the box to read all of it before you answer.`;
  }
  return c;
}

function baseCopy(q: AgentQuestion): QuestionCopy {
  const who = q.client || "An agent";
  const deny: AnswerButton = { label: "Deny", decision: "deny", safe: true };
  switch (q.kind) {
    case "open":
      return {
        title: "Let an agent open a terminal?",
        lead: `${who} wants to open a terminal on ${q.profile}.`,
        code: q.text,
        note: "It will use the login Portique has saved for this profile. You will see the session in a tab of its own and can take the keyboard at any time.",
        buttons: [deny, { label: "Allow, ask me for each step", decision: "once" }, { label: "Allow, don't ask again in this session", decision: "session" }],
      };
    case "input":
      return {
        title: "Let an agent type this?",
        lead: `${who} wants to type this into ${q.profile}:`,
        code: q.text,
        note: "⏎ is Enter and ^C is Ctrl+C.",
        buttons: [deny, { label: "Allow once", decision: "once" }, { label: "Allow for this session", decision: "session" }],
      };
    default:
      return {
        title: "Run this command?",
        lead: `${who} wants to run this in ${q.profile}:`,
        code: q.text,
        note: "",
        buttons: [deny, { label: "Allow once", decision: "once" }, { label: "Allow for this session", decision: "session" }],
      };
  }
}

/** Short text for the tab badge and its tip, by who holds the keyboard. */
export function controllerBadge(controller: AgentSessionInfo["controller"], client: string): { text: string; tip: string } {
  return controller === "user"
    ? { text: "you", tip: `You have this terminal; ${client || "the agent"} is paused. Right-click the tab to hand it back.` }
    : { text: "agent", tip: `${client || "An agent"} opened this terminal and is using it. Type to take over.` };
}

/** One line of the activity log, in words. */
export function activityLine(a: AgentAudit, now = new Date(a.at)): string {
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const who = a.client || "agent";
  const text = a.text.replace(/\s+/g, " ").slice(0, 160);
  const outcome = a.outcome ? ` (${a.outcome})` : "";
  let what: string;
  switch (a.action) {
    case "open": what = `${who} opened a terminal on ${a.profile}`; break;
    case "run": what = `${who} ran on ${a.profile}: ${text}${outcome}`; break;
    case "input": what = `${who} typed on ${a.profile}: ${text}`; break;
    case "close": what = `${who}'s terminal on ${a.profile} closed${outcome}`; break;
    case "refused": what = `${who} was refused on ${a.profile}: ${text}`; break;
    case "took-control": what = `You took over ${a.profile}; ${who} is paused`; break;
    case "handed-back": what = `You handed ${a.profile} back to ${who}`; break;
    default: what = `${who} ${a.action} on ${a.profile}${text ? `: ${text}` : ""}${outcome}`;
  }
  return `${time}  ${what}`;
}

/** Where the settings pane tells people to look, depending on whether the server is up. */
export function endpointNote(enabled: boolean, url: string | null): string {
  if (!enabled) return "Off. Nothing listens, and no agent can reach Portique.";
  return url ? `Listening on ${url} (this computer only).` : "Starting…";
}
