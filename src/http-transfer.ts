import { api } from "./api";
import { exportData, parseImport } from "./http-import";
import type { ConnStore } from "./http-store";
import { h, modal } from "./ui";

const FILES = [{ name: "API requests", extensions: ["json", "txt", "sh"] }];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

async function say(title: string, ...lines: (Node | string)[]) {
  await modal(title, h("div", {}, ...lines.map((l) => (typeof l === "string" ? h("p", {}, l) : l))), [{ label: "OK", primary: true }]);
}

/** Asks for a file and adds its requests (and environments) to the connection. */
export async function importRequests(store: ConnStore): Promise<void> {
  const path = await api.chooseFileToOpen(FILES);
  if (!path) return;
  try {
    const imp = parseImport(await api.readTextFile(path), baseName(path));
    await store.importData(imp);
    const where = imp.folder ? ` in “${imp.folder}”` : "";
    await say("Imported",
      `Added ${plural(imp.requests.length, "request")}${where}.`,
      ...(imp.envs.length ? [`Environment “${imp.envs.map((e) => e.name).join("”, “")}” now holds the variables it uses. Fill in any values the file couldn't carry, such as passwords and tokens.`] : []),
      ...(imp.skipped.length ? [h("div", {}, h("p", {}, "Not brought across:"), h("ul", {}, ...imp.skipped.map((s) => h("li", {}, s))))] : []));
  } catch (e) {
    await say("Couldn't import that file", String((e as Error).message ?? e).replace(/^Error: /, ""));
  }
}

/** Saves the connection's requests and environments to a file; secret values are never included. */
export async function exportRequests(store: ConnStore): Promise<void> {
  const d = store.data;
  if (!d.requests.length && !d.envs.length) {
    await say("Nothing to export", "Save a request first (Ctrl+S in a request), then export.");
    return;
  }
  const path = await api.chooseFileToSave("portique-requests.json", [{ name: "JSON", extensions: ["json"] }]);
  if (!path) return;
  try {
    await api.writeTextFile(path, exportData(d));
    await say("Exported", `Saved ${plural(d.requests.length, "request")} and ${plural(d.envs.length, "environment")} to ${baseName(path)}.`, "Secret values stay in the vault and are not in the file.");
  } catch (e) {
    await say("Couldn't save the file", String((e as Error).message ?? e).replace(/^Error: /, ""));
  }
}
