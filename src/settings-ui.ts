import { api, type LocalShell, type Settings } from "./api";
import { field, h, modal } from "./ui";

/** Turns a key press into an accelerator such as "Ctrl+Alt+Space"; null while only modifiers are down. */
function accelerator(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  const code = e.code.replace(/^Key/, "").replace(/^Digit/, "");
  const fKey = /^F\d+$/.test(code);
  if (!mods.length && !fKey) return "";
  return [...mods, code].join("+");
}

/** The settings pane. Resolves with the new settings once saved, or null if cancelled. */
export async function settingsDialog(current: Settings): Promise<Settings | null> {
  const next: Settings = structuredClone(current);
  const shells: LocalShell[] = await api.listLocalShells().catch(() => []);

  const scale = h("select", {},
    h("option", { value: "normal" }, "Normal"), h("option", { value: "large" }, "Large"));
  scale.value = current.uiScale;
  const lockAfter = h("select", {},
    ...[[0, "Never"], [1, "1 minute"], [5, "5 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"]]
      .map(([m, label]) => h("option", { value: String(m) }, String(label))));
  lockAfter.value = String(current.vaultIdleMinutes);
  const restore = h("input", { type: "checkbox", checked: current.restoreTabs });
  const gpu = h("input", { type: "checkbox", checked: current.gpu });
  const quake = h("input", { type: "checkbox", checked: current.quake });
  const dir = h("input", { value: current.sftpLocalDir, placeholder: "The folder it was last in", spellcheck: false });

  // Which shells on this computer to offer as terminals. Turning the section on with nothing chosen picks the usual one.
  const local = h("input", { type: "checkbox", checked: current.localTerminals });
  const picks = shells.map((s) => ({ s, box: h("input", { type: "checkbox", checked: current.localShells.includes(s.id) }) }));
  const pickList = h("div", { class: "local-shells" },
    ...picks.map(({ s, box }) => h("label", { class: "check" }, box, ` ${s.name}`)));
  const syncPicks = () => {
    pickList.hidden = !local.checked;
    for (const { box } of picks) box.disabled = !local.checked;
  };
  local.addEventListener("change", () => {
    if (local.checked && !picks.some(({ box }) => box.checked)) {
      const usual = picks.find(({ s }) => s.isDefault) ?? picks[0];
      if (usual) usual.box.checked = true;
    }
    syncPicks();
  });
  syncPicks();

  // The hotkey is recorded by pressing it, so nobody has to know the accelerator syntax.
  const key = h("input", { class: "hotkey", value: current.quakeKey, readOnly: true, spellcheck: false, "aria-label": "Drop-down hotkey" });
  const keyNote = h("small", {}, "Click the box, then press the keys you want.");
  key.addEventListener("focus", () => { keyNote.textContent = "Press the new keys… (Esc to keep the old one)"; key.select(); });
  key.addEventListener("blur", () => { keyNote.textContent = "Click the box, then press the keys you want."; });
  key.addEventListener("keydown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return key.blur();
    const acc = accelerator(e);
    if (acc === null) return;
    if (acc === "") { keyNote.textContent = "Include Ctrl, Alt, Shift or Win with the key."; return; }
    key.value = acc;
    key.blur();
  });

  const body = h("div", {},
    h("h3", {}, "Appearance"),
    field("Interface text size", scale, "Terminal text has its own size: Ctrl+mouse wheel (or Ctrl+ + / −, Ctrl+0 to reset) in a terminal."),
    h("h3", {}, "Startup"),
    h("label", { class: "check" }, restore, " Reopen my tabs when Portique starts"),
    h("h3", {}, "Vault"),
    field("Lock the vault after", lockAfter, "Counted from your last key press or click. Open connections stay open; saved passwords and keys are asked for again. \"Never\" keeps the vault unlocked until you lock it or quit."),
    h("h3", {}, "File browser"),
    field("Start in this folder on this computer", dir, "Each profile can choose its own folders in the profile editor; this is the default for the rest."),
    h("h3", {}, "Local terminals"),
    h("label", { class: "check" }, local, " Show local terminals"),
    shells.length ? pickList : h("small", {}, "No shells were found on this computer."),
    h("small", {}, "Shells on this computer open in their own tabs, listed under Local in the sidebar."),
    h("h3", {}, "Drop-down mode"),
    h("label", { class: "check" }, quake, " Drop-down terminal on a global hotkey"),
    field("Hotkey", key, undefined),
    keyNote,
    h("h3", {}, "Rendering"),
    h("label", { class: "check" }, gpu, " GPU rendering for terminals (falls back by itself if unavailable)"));

  let saved: Settings | null = null;
  await modal("Settings", body, [
    { label: "Cancel" },
    {
      label: "Save",
      primary: true,
      action: async () => {
        // The hotkey first: drop-down mode is switched on with whatever key is current.
        if (key.value !== current.quakeKey) await api.setQuakeKey(key.value);
        next.quakeKey = key.value;
        if (quake.checked !== current.quake || (quake.checked && key.value !== current.quakeKey)) {
          await api.setQuake(quake.checked);
        }
        next.quake = quake.checked;
        if (gpu.checked !== current.gpu) await api.setGpu(gpu.checked);
        next.gpu = gpu.checked;
        next.restoreTabs = restore.checked;
        next.sftpLocalDir = dir.value.trim();
        next.uiScale = scale.value as Settings["uiScale"];
        next.vaultIdleMinutes = Number(lockAfter.value);
        next.localTerminals = local.checked;
        next.localShells = picks.filter(({ box }) => box.checked).map(({ s }) => s.id);
        await api.setLocalTerminals(next.localTerminals, next.localShells);
        await api.setPrefs(next.restoreTabs, next.sftpLocalDir, next.uiScale, next.vaultIdleMinutes);
        saved = next;
      },
    },
  ]);
  return saved;
}
