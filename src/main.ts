import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import emblem from "./assets/portique.svg";
import { api, Profile, Settings, setUnlockHook } from "./api";
import { applyChrome, chromeDialog, DEFAULT_UI, PRESET_NAMES, presetUi } from "./chrome";
import { FileTab } from "./file-tab";
import { environmentsDialog } from "./http-env";
import { HttpRequest } from "./http-model";
import { httpStore } from "./http-store";
import { ApiTab } from "./http-tab";
import { editProfile, manageKeysDialog, themeDialog } from "./editors";
import { contextMenu, MenuEntries, menuOn } from "./menu";
import { Arrow, Dir, Layout, Tab } from "./panes";
import { shellIntegrationDialog } from "./shell-integration";
import { TerminalTab } from "./terminal-tab";
import { effectiveFont, ensureFont, getTheme, loadThemes } from "./themes";
import { toggleHelp } from "./help";
import { settingsDialog } from "./settings-ui";
import { FindTarget, openPalette, PaletteItem } from "./palette";
import { h, promptText } from "./ui";
import { windowControls } from "./window-controls";
import { changePasswordDialog, ensureUnlocked } from "./vault-ui";
import { listen } from "@tauri-apps/api/event";

interface Workspace {
  id: string;
  name: string;
  tabs: Layout[];
}
/** `last` is the open window, restored on launch; `named` are the ones the user saved. */
interface Workspaces {
  last: { tabs: Layout[]; active: number };
  named: Workspace[];
}

type AnyTab = Tab | FileTab | ApiTab;

let settings: Settings = { quake: false, quakeKey: "Ctrl+Backquote", gpu: true, ui: DEFAULT_UI, restoreTabs: true, sftpLocalDir: "", uiScale: "normal" };
let profiles: Profile[] = [];
let ws: Workspaces = { last: { tabs: [], active: 0 }, named: [] };
const tabs: AnyTab[] = [];
let active: AnyTab | null = null;
let ready = false; // set once the previous session was restored; until then nothing is persisted

const sidebar = h("div", { class: "profiles" });
const search = h("input", { class: "search", placeholder: "Search profiles…", oninput: () => renderProfiles() });
const tabBar = h("div", { class: "tabbar" }, ...windowControls());
const stage = h("div", { class: "stage" });
const empty = h("div", { class: "empty" },
  h("img", { class: "emblem", src: emblem, alt: "", draggable: false }),
  h("h1", {}, "Portique"),
  h("p", { class: "tagline" }, "Your servers, within reach"),
  h("div", { class: "filet" }, "◆"),
  h("p", {}, "Double-click a profile to connect, or create one with “+ New”."),
  h("p", {}, "Ctrl+Shift+A opens an API request."),
  h("p", { class: "hints" }, "Right-click a profile for more · Ctrl+Shift+D / E split a tab · Ctrl+click opens links"));

const GEAR = '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>';
const gearIcon = () => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("class", "gear");
  el.innerHTML = GEAR; // static literal
  return el;
};

const moreBtn = h("button", { class: "icon", title: "Menu and settings", onclick: () => {
  const r = moreBtn.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    { label: "New API request", hint: "Ctrl+Shift+A", action: () => openRequest() },
    { label: "Environments…", action: () => void environmentsDialog() },
    null,
    { label: "Save workspace…", action: () => void saveWorkspace() },
    null,
    { label: "SSH keys…", action: () => void manageKeysDialog() },
    { label: "Interface colours…", action: async () => { const ui = await chromeDialog(settings.ui); if (ui) settings.ui = ui; } },
    { label: "Colour themes…", action: async () => { await themeDialog("portique-nuit"); await loadThemes(); renderProfiles(); } },
    null,
    { label: "Settings…", action: () => void openSettings() },
    { label: "Change master password…", action: () => void changePasswordDialog() },
  ]);
} }, gearIcon());

document.querySelector("#app")!.append(
  h("aside", {},
    h("div", { class: "brand", "data-tauri-drag-region": true }, h("img", { src: emblem, alt: "", draggable: false }), h("span", {}, "Portique")),
    h("div", { class: "side-head" },
      h("button", { class: "primary", onclick: () => void newProfile() }, "+ New"),
      h("button", { class: "icon", title: "Lock the vault now", onclick: async () => { await api.vaultLock(); await ensureUnlocked(); } }, "🔒"),
      moreBtn),
    search, sidebar,
    h("button", { class: "help-link", title: "Keyboard shortcuts", onclick: () => toggleHelp(settings.quakeKey, settings.quake) }, "Keyboard shortcuts", h("kbd", {}, "F1"))),
  h("main", {}, tabBar, stage, empty),
);

// ---------------------------------------------------------------- sidebar

function renderProfiles() {
  const q = search.value.toLowerCase();
  const groups = new Map<string, Profile[]>();
  for (const p of profiles.filter((p) => `${p.name} ${p.host} ${p.group}`.toLowerCase().includes(q))) {
    const g = p.group || "Ungrouped";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const named = ws.named.filter((w) => w.name.toLowerCase().includes(q));
  const folders = new Map<string, HttpRequest[]>();
  for (const r of httpStore.data.requests.filter((r) => `${r.name} ${r.url} ${r.group} ${r.method}`.toLowerCase().includes(q))) {
    folders.set(r.group, [...(folders.get(r.group) ?? []), r]);
  }
  sidebar.replaceChildren(
    ...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) =>
      h("section", {}, h("div", { class: "group" }, g),
        ...list.sort((a, b) => a.name.localeCompare(b.name)).map(profileRow))),
    ...[...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) =>
      h("section", {}, h("div", { class: "group" }, g ? `Requests / ${g}` : "Requests"),
        ...list.sort((a, b) => a.name.localeCompare(b.name)).map(requestRow))),
    ...(named.length
      ? [h("section", {}, h("div", { class: "group" }, "Workspaces"), ...named.map(workspaceRow))]
      : []),
  );
}

function profileRow(p: Profile) {
  const th = getTheme(p.appearance.themeId);
  const row = h("div", { class: "profile", title: describe(p), ondblclick: () => openTab(p),
    oncontextmenu: (e: MouseEvent) => {
      row.classList.add("ctx");
      menuOn(e, profileMenu(p), () => row.classList.remove("ctx"));
    } },
    h("span", { class: "dot", style: `background:${th.background};border-color:${th.ansi[4]}` }),
    h("span", { class: "pname" }, p.name),
    h("span", { class: "proto" }, p.protocol.toUpperCase()));
  return row;
}

function requestRow(r: HttpRequest) {
  const row = h("div", { class: "profile", title: r.url, ondblclick: () => openRequest(r),
    oncontextmenu: (e: MouseEvent) => {
      row.classList.add("ctx");
      menuOn(e, [
        { label: "Open", action: () => openRequest(r) },
        null,
        { label: "Rename…", action: () => void renameRequest(r) },
        { label: "Move to folder…", action: () => void moveRequest(r) },
        { label: "Duplicate", action: () => void httpStore.duplicateRequest(r.id).then((c) => c && openRequest(c)) },
        null,
        { label: "Delete…", danger: true, action: () => void deleteRequest(r) },
      ], () => row.classList.remove("ctx"));
    } },
    h("span", { class: "dot api" }),
    h("span", { class: "pname" }, r.name),
    h("span", { class: `proto m-${r.method}` }, r.method));
  return row;
}

async function renameRequest(r: HttpRequest) {
  const name = await promptText("Rename request", "Name", r.name);
  if (name) await httpStore.saveRequest({ ...r, name });
}

async function moveRequest(r: HttpRequest) {
  const folder = await promptText("Move request", "Folder (leave empty for none)", r.group);
  if (folder !== null) await httpStore.saveRequest({ ...r, group: folder });
  else if (r.group) await httpStore.saveRequest({ ...r, group: "" }); // emptied the box: take it out of its folder
}

async function deleteRequest(r: HttpRequest) {
  if (confirm(`Delete request "${r.name}"?`)) await httpStore.deleteRequest(r.id);
}

function workspaceRow(w: Workspace) {
  const row = h("div", { class: "profile", title: "Double-click to open", ondblclick: () => openWorkspace(w),
    oncontextmenu: (e: MouseEvent) => {
      row.classList.add("ctx");
      menuOn(e, [
        { label: "Open", action: () => openWorkspace(w) },
        { label: "Rename…", action: () => void renameWorkspace(w) },
        null,
        { label: "Delete…", danger: true, action: () => void deleteWorkspace(w) },
      ], () => row.classList.remove("ctx"));
    } },
    h("span", { class: "dot ws" }),
    h("span", { class: "pname" }, w.name),
    h("span", { class: "proto" }, `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}`));
  return row;
}

function profileMenu(p: Profile): MenuEntries {
  return [
    { label: "Connect", action: () => openTab(p) },
    ...(p.protocol === "ssh" ? [{ label: "Open file browser (SFTP)", action: () => openFiles(p) }] : []),
    ...(active ? [
      { label: "Open in split right", action: () => splitActive("row", p) },
      { label: "Open in split below", action: () => splitActive("col", p) },
    ] : []),
    null,
    { label: "Edit…", action: () => void edit(p) },
    null,
    { label: "Delete…", danger: true, action: () => void remove(p) },
  ];
}

const describe = (p: Profile) =>
  p.protocol === "serial" ? `${p.serial.port} @ ${p.serial.baud}` : `${p.username ? p.username + "@" : ""}${p.host}:${p.port}`;

async function refresh() {
  await loadThemes();
  profiles = await api.listProfiles();
  renderProfiles();
}

async function newProfile() {
  if (await editProfile(null)) await refresh();
}

async function edit(p: Profile) {
  const saved = await editProfile(p);
  if (!saved) return;
  await refresh();
  await ensureFont(effectiveFont(saved.appearance), saved.appearance.fontSize);
  for (const t of tabs) t.applyProfile(saved);
}

async function remove(p: Profile) {
  if (!confirm(`Delete profile "${p.name}"?`)) return;
  await api.deleteProfile(p.id);
  await refresh();
}

// ---------------------------------------------------------------- tabs and panes

const findProfile = (id: string) => profiles.find((p) => p.id === id);

function addTab(layout: Layout): Tab | null {
  let tab: Tab | null = null;
  try {
    tab = Tab.create(layout, findProfile);
  } catch {} // a malformed saved layout must not stop the rest from restoring
  if (!tab) return null;
  const t = tab;
  t.header.addEventListener("click", () => activate(t));
  t.header.addEventListener("auxclick", (e) => e.button === 1 && closeTab(t));
  t.header.addEventListener("contextmenu", (e) => menuOn(e, tabMenu(t)));
  t.closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
  t.onChange = persist;
  t.onPaneMenu = (e) => menuOn(e, paneMenu(t));
  tabs.push(t);
  tabBar.append(t.header);
  stage.append(t.el);
  return t;
}

/** Opens a saved request (or a new empty one); an already open request is just brought forward. */
function openRequest(saved?: HttpRequest) {
  const open = saved && tabs.find((t): t is ApiTab => t instanceof ApiTab && t.requestId === saved.id);
  if (open) return activate(open);
  const t = new ApiTab(saved);
  attach(t);
}

function attach(t: FileTab | ApiTab) {
  t.header.addEventListener("click", () => activate(t));
  t.header.addEventListener("auxclick", (e) => e.button === 1 && closeTab(t));
  t.header.addEventListener("contextmenu", (e) => menuOn(e, tabMenu(t)));
  t.closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
  tabs.push(t);
  tabBar.append(t.header);
  stage.append(t.el);
  activate(t);
}

/** Opens an SFTP file browser for an SSH profile, using the profile's own credentials. */
function openFiles(p: Profile) {
  attach(new FileTab(p));
}

function openTab(p: Profile) {
  const tab = addTab({ p: p.id });
  if (tab) activate(tab);
}

function splitActive(dir: Dir, p?: Profile) {
  if (active instanceof Tab) active.split(dir, p);
}

function activate(tab: AnyTab | null) {
  active = tab;
  for (const t of tabs) t.show(t === tab);
  empty.style.display = tabs.length ? "none" : "";
  persist();
}

function closeTab(tab: AnyTab) {
  if (tab instanceof ApiTab && !tab.confirmClose()) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.dispose();
  activate(active === tab ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : active);
}

/** Closes the focused pane, or the whole tab if it is the only one. */
function closePane(tab: Tab) {
  if (tab.closeFocused()) closeTab(tab);
}

function tabMenu(tab: AnyTab): MenuEntries {
  if (tab instanceof FileTab) return [{ label: "Close tab", action: () => closeTab(tab) }];
  if (tab instanceof ApiTab) return [...tab.menuEntries(), null, { label: "Close tab", action: () => closeTab(tab) }];
  const on = (f: () => void) => () => { activate(tab); f(); };
  return [
    ...(tab.focused.profile.protocol === "ssh" ? [{ label: "Open file browser for this host", action: () => openFiles(tab.focused.profile) }, null] : []),
    { label: "Split right", hint: "Ctrl+Shift+D", action: on(() => tab.split("row")) },
    { label: "Split down", hint: "Ctrl+Shift+E", action: on(() => tab.split("col")) },
    null,
    ...(tab.paneCount > 1 ? [{ label: "Close pane", hint: "Ctrl+Shift+W", action: on(() => closePane(tab)) }] : []),
    { label: "Close tab", action: () => closeTab(tab) },
  ];
}

function paneMenu(tab: Tab): MenuEntries {
  const term = tab.focused;
  return [
    ...(term.hasSelection() ? [{ label: "Copy", hint: "Ctrl+Shift+C", action: () => void term.copy() }] : []),
    { label: "Paste", hint: "Ctrl+Shift+V", action: () => void term.paste() },
    null,
    ...(term.hasMarks ? [
      { label: "Previous prompt", hint: "Ctrl+Shift+↑", action: () => term.jumpPrompt(-1) },
      { label: "Next prompt", hint: "Ctrl+Shift+↓", action: () => term.jumpPrompt(1) },
      ...(term.hasOutput ? [{ label: "Copy last command output", action: () => void term.copyLastOutput() }] : []),
    ] : [
      { label: "Shell integration…", action: () => void shellIntegrationDialog() },
    ]),
    null,
    ...tabMenu(tab),
  ];
}

async function toggleGpu() {
  settings.gpu = !settings.gpu;
  TerminalTab.gpu = settings.gpu;
  await api.setGpu(settings.gpu).catch(() => {});
  for (const t of tabs) t.setGpu(settings.gpu);
}

async function toggleQuake() {
  try {
    await api.setQuake(!settings.quake);
    settings.quake = !settings.quake;
  } catch (e) {
    alert(`Drop-down mode could not be changed:\n${e}`);
  }
}

/** Applies settings that affect the running UI (the saved copy is already on disk). */
function applySettings(s: Settings) {
  settings = { ...s, ui: { ...DEFAULT_UI, ...s.ui } };
  document.documentElement.style.setProperty("--s", s.uiScale === "large" ? "1.2" : "1");
  FileTab.defaultLocalDir = s.sftpLocalDir;
  TerminalTab.gpu = s.gpu;
  for (const t of tabs) t.setGpu(s.gpu);
}

async function openSettings() {
  const s = await settingsDialog(settings);
  if (s) applySettings(s);
}

// ---------------------------------------------------------------- command palette

async function applyPreset(name: string) {
  const ui = presetUi(name, settings.ui);
  await api.setUi(ui).catch(() => {});
  settings.ui = ui;
  applyChrome(ui);
}

function paletteItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  const add = (group: string, id: string, title: string, run: () => void, extra: Partial<PaletteItem> = {}) => out.push({ id, group, title, run, ...extra });
  const tab = active instanceof Tab ? active : null;

  // What the focused tab can do right now.
  if (tab) {
    add("This tab", "split-right", "Split right", () => tab.split("row"), { hint: "Ctrl+Shift+D" });
    add("This tab", "split-down", "Split down", () => tab.split("col"), { hint: "Ctrl+Shift+E" });
    if (tab.paneCount > 1) add("This tab", "close-pane", "Close pane", () => closePane(tab), { hint: "Ctrl+Shift+W" });
    if (tab.focused.hasOutput) add("This tab", "copy-output", "Copy last command output", () => void tab.focused.copyLastOutput(), { keywords: "clipboard" });
    if (tab.focused.profile.protocol === "ssh") add("This tab", "files-here", "Open file browser for this host", () => openFiles(tab.focused.profile), { keywords: "sftp" });
  }
  if (active) add("This tab", "close-tab", "Close tab", () => closeTab(active!));
  for (const t of tabs) if (t !== active) add("Tabs", `tab:${t.title}:${tabs.indexOf(t)}`, `Switch to ${t.title}`, () => activate(t), { subtitle: t instanceof FileTab ? "file browser" : t instanceof ApiTab ? "API request" : "" });

  // Hosts: all connections first, then all file browsers.
  const hosts = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of hosts) add("Connect", `connect:${p.id}`, p.name, () => openTab(p), { subtitle: describe(p), keywords: p.group });
  for (const p of hosts.filter((x) => x.protocol === "ssh"))
    add("Files", `files:${p.id}`, `Browse files on ${p.name}`, () => openFiles(p), { subtitle: describe(p), keywords: `sftp upload download ${p.group}` });
  for (const w of ws.named) add("Workspaces", `ws:${w.id}`, `Open workspace ${w.name}`, () => openWorkspace(w), { subtitle: `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}` });

  // API requests.
  add("API", "new-request", "New API request", () => openRequest(), { hint: "Ctrl+Shift+A", keywords: "http rest postman curl endpoint" });
  add("API", "environments", "API environments…", () => void environmentsDialog(), { keywords: "variables secrets token" });
  if (active instanceof ApiTab) {
    const a = active;
    add("API", "send", "Send the request", () => void a.sendNow(), { hint: "Ctrl+Enter" });
    add("API", "save-request", "Save the request", () => void a.save(), { hint: "Ctrl+S" });
  }
  for (const r of httpStore.data.requests) add("API", `request:${r.id}`, `Open request ${r.name}`, () => openRequest(r), { subtitle: `${r.method} ${r.url}`, keywords: `${r.group} api http` });

  // The app.
  add("App", "new-profile", "New profile…", () => void newProfile());
  add("App", "save-workspace", "Save workspace…", () => void saveWorkspace());
  add("App", "ssh-keys", "SSH keys…", () => void manageKeysDialog());
  add("App", "lock", "Lock the vault", () => void api.vaultLock().then(() => ensureUnlocked()));
  add("App", "master-pw", "Change master password…", () => void changePasswordDialog());
  add("App", "shortcuts", "Keyboard shortcuts", () => toggleHelp(settings.quakeKey, settings.quake), { hint: "F1" });
  add("Appearance", "ui-colours", "Interface colours…", () => void chromeDialog(settings.ui).then((ui) => { if (ui) settings.ui = ui; }));
  add("Appearance", "themes", "Terminal colour themes…", async () => { await themeDialog("portique-nuit"); await loadThemes(); renderProfiles(); });
  for (const n of PRESET_NAMES) add("Appearance", `preset:${n}`, `Interface look: ${n}`, () => void applyPreset(n));
  add("App", "settings", "Settings…", () => void openSettings(), { keywords: "preferences hotkey startup font size gpu drop-down" });
  add("App", "gpu", `${settings.gpu ? "Turn off" : "Turn on"} GPU rendering`, () => void toggleGpu());
  add("App", "quake", `${settings.quake ? "Turn off" : "Turn on"} drop-down mode (${settings.quakeKey})`, () => void toggleQuake());
  return out;
}

/** Search target for find mode: the focused terminal of the active tab. */
function findTarget(): FindTarget | null {
  if (!(active instanceof Tab)) return null;
  const term = active.focused;
  return {
    find: (q, o, dir, inc) => term.find(q, o, dir, inc),
    clear: () => term.clearFind(),
    onResults: (cb) => { term.onFindResults = cb; },
  };
}

const showPalette = (mode: "commands" | "find") => openPalette({ items: paletteItems, findTarget }, mode);

// ---------------------------------------------------------------- shortcuts

const ARROWS: Record<string, Arrow> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The action for a key press, or null. Also used by terminals to know which keys not to swallow. */
function matchKey(e: KeyboardEvent): (() => void) | null {
  if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.shiftKey) return () => toggleHelp(settings.quakeKey, settings.quake);
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyP") return () => showPalette("commands");
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF") return () => showPalette("find");
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyA") return () => openRequest();
  if (e.ctrlKey && !e.altKey && e.key === "Tab" && tabs.length) {
    return () => activate(tabs[(tabs.indexOf(active!) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  }
  const tab = active;
  if (!(tab instanceof Tab)) return null;
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (e.code === "KeyW") return () => closePane(tab);
    if (e.code === "KeyD") return () => tab.split("row");
    if (e.code === "KeyE") return () => tab.split("col");
    // Prompt navigation only claims these keys once the shell is sending prompt marks.
    if ((e.code === "ArrowUp" || e.code === "ArrowDown") && tab.focused.hasMarks) {
      return () => tab.focused.jumpPrompt(e.code === "ArrowUp" ? -1 : 1);
    }
  }
  if (e.altKey && e.shiftKey && !e.ctrlKey && e.code in ARROWS) return () => tab.moveFocus(ARROWS[e.code]);
  return null;
}

TerminalTab.reserved = (e) => matchKey(e) !== null;
window.addEventListener("keydown", (e) => {
  const act = matchKey(e);
  if (act) {
    e.preventDefault();
    act();
  }
});

// ---------------------------------------------------------------- workspaces

/** File browsers aren't saved in workspaces (they would reconnect on launch). */
const terminalTabs = () => tabs.filter((t): t is Tab => t instanceof Tab);

/** Persist the open layout shortly after it changes (and the saved workspaces along with it). */
let persistTimer: number | undefined;
function persist() {
  if (!ready) return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void writeWorkspaces(), 300);
}

/** Writes everything, refreshing the open-window snapshot first so it is never stale. */
async function writeWorkspaces() {
  if (ready) {
    const term = terminalTabs();
    ws.last = { tabs: term.map((t) => t.layout()), active: Math.max(0, term.indexOf(active as Tab)) };
  }
  await api.saveWorkspaces(ws).catch(() => {});
}

async function loadWorkspaces() {
  const raw = (await api.loadWorkspaces().catch(() => null)) as Partial<Workspaces> | null;
  const list = (v: unknown): Layout[] => (Array.isArray(v) ? v : []);
  ws = {
    last: { tabs: list(raw?.last?.tabs), active: Number(raw?.last?.active) || 0 },
    named: (Array.isArray(raw?.named) ? raw.named : []).filter((w) => w && typeof w.name === "string").map((w) => ({
      id: String(w.id ?? crypto.randomUUID()), name: w.name, tabs: list(w.tabs),
    })),
  };
}

function restoreLast() {
  const added = ws.last.tabs.map(addTab).filter((t): t is Tab => !!t);
  if (added.length) activate(added[Math.min(ws.last.active, added.length - 1)]);
}

function openWorkspace(w: Workspace) {
  const added = w.tabs.map(addTab).filter((t): t is Tab => !!t);
  if (added.length) activate(added[0]);
  else alert(`None of the profiles in "${w.name}" exist any more.`);
}

async function saveWorkspace() {
  if (!terminalTabs().length) return alert("Open some terminal tabs first, then save them as a workspace.");
  const name = await promptText("Save workspace", "Name", "");
  if (!name) return;
  const snapshot = terminalTabs().map((t) => t.layout());
  const existing = ws.named.find((w) => w.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.tabs = snapshot;
  else ws.named.push({ id: crypto.randomUUID(), name, tabs: snapshot });
  await writeWorkspaces();
  renderProfiles();
}

async function renameWorkspace(w: Workspace) {
  const name = await promptText("Rename workspace", "Name", w.name);
  if (!name) return;
  w.name = name;
  await writeWorkspaces();
  renderProfiles();
}

async function deleteWorkspace(w: Workspace) {
  if (!confirm(`Delete workspace "${w.name}"?`)) return;
  ws.named = ws.named.filter((x) => x !== w);
  await writeWorkspaces();
  renderProfiles();
}

// ---------------------------------------------------------------- terminal font zoom

/** Ctrl+wheel in a terminal resizes its text; the size is remembered in the profile once it settles. */
let zoomTimer: number | undefined;
TerminalTab.onFontSize = (p, size) => {
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(async () => {
    const cur = profiles.find((x) => x.id === p.id);
    if (!cur || cur.appearance.fontSize === size) return;
    const saved = await api.saveProfile({ ...cur, appearance: { ...cur.appearance, fontSize: size } }).catch(() => null);
    if (!saved) return;
    profiles = profiles.map((x) => (x.id === saved.id ? saved : x));
    for (const t of tabs) t.applyProfile(saved);
  }, 700);
};

// ---------------------------------------------------------------- startup

// Keep the vault's idle timer alive while the user is actually working.
let lastPing = 0;
for (const ev of ["keydown", "mousedown", "wheel"]) {
  window.addEventListener(ev, () => {
    if (Date.now() - lastPing > 30_000) {
      lastPing = Date.now();
      void api.vaultTouch();
    }
  }, true);
}
setUnlockHook(ensureUnlocked);
void listen("vault-locked", () => ensureUnlocked());

activate(null);
httpStore.listeners.add(renderProfiles);
const settingsLoaded = api.getSettings().then((s) => {
  applySettings(s);
  applyChrome(settings.ui);
}).catch(() => {});
void ensureUnlocked().then(async () => {
  await refresh();
  await httpStore.load();
  await loadWorkspaces();
  await settingsLoaded; // whether to reopen the last tabs is a setting
  if (settings.restoreTabs) restoreLast();
  ready = true;
  renderProfiles();
});
