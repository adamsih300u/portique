/** A command kept with a profile and offered in the command palette while a tab for that profile is on screen. */
export interface SavedCommand {
  id: string;
  name: string;
  text: string;
  /** "run" types the text and presses Enter; "paste" only types it, so it can be read and edited first. */
  mode: "run" | "paste";
}

/** Profiles saved before this existed (or hand-edited files) have no or malformed commands: keep what is usable. */
export function sanitizeCommands(v: unknown): SavedCommand[] {
  if (!Array.isArray(v)) return [];
  const out: SavedCommand[] = [];
  for (const c of v as unknown[]) {
    if (!c || typeof c !== "object") continue;
    const { id, name, text, mode } = c as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    out.push({
      id: typeof id === "string" && id ? id : crypto.randomUUID(),
      name: typeof name === "string" && name.trim() ? name.trim() : text.trim().split("\n")[0].slice(0, 60),
      text,
      mode: mode === "paste" ? "paste" : "run",
    });
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** The `{{name}}` placeholders in a command, once each, in the order they first appear. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/** Replaces each `{{name}}` with its value; a name with no value is left as written. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (all, n: string) => (n in values ? values[n] : all));
}
