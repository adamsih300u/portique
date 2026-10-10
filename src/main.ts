import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { emblem } from "./emblem";
import { api, type Profile, type Settings, setUnlockHook } from "./api";
import { applyChrome, chromeDialog, DEFAULT_UI, PRESET_NAMES, presetUi } from "./chrome";
import { FileTab } from "./file-tab";
import { ApiTab } from "./api-tab";
import { httpStore } from "./http-store";
import { editProfile, localLookDialog, manageKeysDialog, themeDialog } from "./editors";
import { protoIcon } from "./proto-icon";
import { contextMenu, type MenuEntries, menuOn } from "./menu";
import { type Arrow, type Dir, type Layout, Tab } from "./panes";
import { shellIntegrationDialog } from "./shell-integration";
import { TerminalTab } from "./terminal-tab";
import { ensureFont, loadThemes } from "./themes";
import { toggleHelp } from "./help";
import { settingsDialog } from "./settings-ui";
import { type FindTarget, openPalette, type PaletteItem } from "./palette";
import { serverTools } from "./server-tools";
import { openTool, TOOLS } from "./toolbox";
import { fillPlaceholders, placeholders, type SavedCommand } from "./saved-commands";
import { isQuick, parseQuickTarget, type QuickTarget, quickLabel, quickProfileFor } from "./quick-connect";
import { h, promptText } from "./ui";
import { windowControls } from "./window-controls";
import { changePasswordDialog, ensureUnlocked } from "./vault-ui";
import { listen } from "@tauri-apps/api/event";
import { initSidebar } from "./sidebar-layout";

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

let settings: Settings = { quake: false, quakeKey: "Ctrl+Backquote", gpu: true, ui: DEFAULT_UI, restoreTabs: true, sftpLocalDir: "", uiScale: "normal", vaultIdleMinutes: 15, localTerminals: false, localShells: [] };
let profiles: Profile[] = [];
/** Shells on this computer that the settings turn on. They exist only in memory and are never saved, so they stay apart from `profiles`. */
let localTerms: Profile[] = [];
let ws: Workspaces = { last: { tabs: [], active: 0 }, named: [] };
const tabs: AnyTab[] = [];
let active: AnyTab | null = null;
let ready = false; // set once the previous session was restored; until then nothing is persisted

const sidebar = h("div", { class: "profiles" });
const search = h("input", { class: "search", placeholder: "Search profiles…", oninput: () => renderProfiles() });
const tabBar = h("div", { class: "tabbar" }, ...windowControls());
const stage = h("div", { class: "stage" });
const empty = h("div", { class: "empty" },
  emblem("emblem"),
  h("h1", {}, "Portique"),
  h("p", { class: "tagline" }, "Your servers, within reach"),
  h("div", { class: "filet" }, "◆"),
  h("p", {}, "Double-click a profile to connect, or create one with “+ New”."),
  h("p", {}, "Choose the API protocol under “+ New” to work with a web endpoint."),
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
    { label: "Save workspace…", action: () => void saveWorkspace() },
    { label: "Sidebar", hint: "Ctrl+Shift+B", checked: !sideLayout.isCollapsed(), action: () => sideLayout.toggle() },
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
    h("div", { class: "brand", "data-tauri-drag-region": true }, emblem(), h("span", {}, "Portique")),
    h("div", { class: "side-head" },
      h("button", { class: "primary", onclick: () => void newProfile() }, "+ New"),
      h("button", { class: "icon", title: "Lock the vault now", onclick: async () => { await api.vaultLock(); await ensureUnlocked(); } }, "🔒"),
      moreBtn),
    search, sidebar,
    h("button", { class: "help-link", title: "Keyboard shortcuts", onclick: () => toggleHelp(settings.quakeKey, settings.quake) }, "Keyboard shortcuts", h("kbd", {}, "F1"))),
  h("main", {}, tabBar, stage, empty),
);

const sideLayout = initSidebar(document.querySelector<HTMLElement>("#app")!, document.querySelector("aside")!, sidebar, () => ({
  groups: [...(localTerms.length ? ["Local"] : []), ...new Set(profiles.map((p) => p.group || "Ungrouped")), ...(ws.named.length ? ["Workspaces"] : [])],
  rows: [
    ...[...localTerms, ...profiles].map((p) => ({ name: p.name, icon: p.protocol })),
    ...ws.named.map((w) => ({ name: w.name, icon: "workspace" as const })),
  ],
}));

// ---------------------------------------------------------------- sidebar

// Right-clicking empty space in the list offers what you can add to it (rows have their own menus).
sidebar.addEventListener("contextmenu", (e) => menuOn(e, [
  { label: "New profile…", action: () => void newProfile() },
  { label: "New API connection…", action: () => void newProfile("api") },
]));

function renderProfiles() {
  const q = search.value.toLowerCase();
  const groups = new Map<string, Profile[]>();
  for (const p of profiles.filter((p) => `${p.name} ${p.host} ${p.group}`.toLowerCase().includes(q))) {
    const g = p.group || "Ungrouped";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const named = ws.named.filter((w) => w.name.toLowerCase().includes(q));
  const local = localTerms.filter((p) => `${p.name} local terminal shell`.toLowerCase().includes(q));
  const searching = q !== "";
  const section = (key: string, label: string, rows: HTMLElement[], drop?: string) => {
    const shut = !searching && collapsed.has(key);
    const head = h("div", { class: "group", title: shut ? "Expand" : "Collapse", onclick: () => toggleGroup(key) },
      h("span", { class: "caret" }, shut ? "▸" : "▾"), label);
    const sec = h("section", { class: shut ? "collapsed" : "" }, head, ...(shut ? [] : rows));
    if (drop !== undefined) acceptProfiles(sec, drop);
    return sec;
  };
  sidebar.replaceChildren(
    ...(local.length ? [section("l", "Local", local.map(profileRow))] : []),
    ...[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, list]) =>
      section(`p:${g}`, g, list.sort((a, b) => a.name.localeCompare(b.name)).map(profileRow), g === "Ungrouped" ? "" : g)),
    ...(named.length ? [section("w", "Workspaces", named.map(workspaceRow))] : []),
  );
  sideLayout.refit();
}

const COLLAPSED_KEY = "portique.collapsedGroups";
const collapsed = new Set<string>((() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]; } catch { return []; }
})());

function toggleGroup(key: string) {
  if (!collapsed.delete(key)) collapsed.add(key);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* storage unavailable: just don't remember */ }
  renderProfiles();
}

const DRAG_TYPE = "application/x-portique-profile";

/** Lets a group section take dropped profile rows; the profile joins that group (`""` = no group). */
function acceptProfiles(sec: HTMLElement, group: string) {
  const has = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) ?? false;
  sec.addEventListener("dragover", (e) => {
    if (!has(e)) return;
    e.preventDefault();
    sec.classList.add("drop");
  });
  sec.addEventListener("dragleave", (e) => {
    if (!sec.contains(e.relatedTarget as Node | null)) sec.classList.remove("drop");
  });
  sec.addEventListener("drop", (e) => {
    sec.classList.remove("drop");
    if (!has(e)) return;
    e.preventDefault();
    const p = profiles.find((x) => x.id === e.dataTransfer!.getData(DRAG_TYPE));
    if (p && (p.group || "") !== group) void moveToGroup(p, group);
  });
}

async function moveToGroup(p: Profile, group: string) {
  const saved = await api.saveProfile({ ...p, group }).catch(() => null);
  if (!saved) return;
  profiles = profiles.map((x) => (x.id === saved.id ? saved : x));
  collapsed.delete(`p:${group || "Ungrouped"}`);
  renderProfiles();
}

function profileRow(p: Profile) {
  const row = h("div", { class: "profile", title: describe(p), draggable: p.protocol !== "local", ondblclick: () => openTab(p),
    ondragstart: (e: DragEvent) => {
      e.dataTransfer!.setData(DRAG_TYPE, p.id);
      e.dataTransfer!.effectAllowed = "move";
    },
    oncontextmenu: (e: MouseEvent) => {
      row.classList.add("ctx");
      menuOn(e, profileMenu(p), () => row.classList.remove("ctx"));
    } },
    protoIcon(p.protocol),
    h("span", { class: "pname" }, p.name));
  return row;
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
    protoIcon("workspace"),
    h("span", { class: "pname" }, w.name),
    h("span", { class: "proto" }, `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}`));
  return row;
}

function profileMenu(p: Profile): MenuEntries {
  if (p.protocol === "local") {
    return [
      { label: "Open", action: () => openTab(p) },
      ...(active ? [
        { label: "Open in split right", action: () => splitActive("row", p) },
        { label: "Open in split below", action: () => splitActive("col", p) },
      ] : []),
      null,
      { label: "Appearance…", action: () => void localAppearance(p) },
    ];
  }
  if (p.protocol === "api") {
    return [
      { label: "Open", action: () => openTab(p) },
      { label: "New request", hint: "Ctrl+Shift+A", action: () => { openApi(p); apiTabFor(p)?.newRequest(); } },
      null,
      { label: "Edit…", action: () => void edit(p) },
      { label: "Duplicate…", action: () => void duplicate(p) },
      null,
      { label: "Delete…", danger: true, action: () => void remove(p) },
    ];
  }
  return [
    { label: "Connect", action: () => openTab(p) },
    ...(p.protocol === "ssh" ? [{ label: "Open file browser (SFTP)", action: () => openFiles(p) }] : []),
    ...(active ? [
      { label: "Open in split right", action: () => splitActive("row", p) },
      { label: "Open in split below", action: () => splitActive("col", p) },
    ] : []),
    null,
    { label: "Edit…", action: () => void edit(p) },
    { label: "Duplicate…", action: () => void duplicate(p) },
    null,
    { label: "Delete…", danger: true, action: () => void remove(p) },
  ];
}

const describe = (p: Profile) =>
  p.protocol === "local" ? "Terminal on this computer"
    : p.protocol === "serial" ? `${p.serial.port} @ ${p.serial.baud}`
    : p.protocol === "api" ? p.api.baseUrl || "API connection (no base address)"
    : `${p.username ? p.username + "@" : ""}${p.host}:${p.port}`;

async function refresh() {
  await loadThemes();
  profiles = await api.listProfiles();
  renderProfiles();
}

/** Refreshes the list after each profile the editor saves; a new API connection is for working with, so it opens. */
async function created(saved: Profile) {
  await refresh();
  if (saved.protocol === "api") openApi(saved);
}

async function newProfile(protocol?: Profile["protocol"]) {
  await editProfile(null, protocol, { onSaved: created });
}

/** Opens the editor pre-filled from `p`, named "<name> copy" (numbered if that is taken). */
async function duplicate(p: Profile) {
  const taken = new Set(profiles.map((x) => x.name));
  let name = `${p.name} copy`;
  for (let n = 2; taken.has(name); n++) name = `${p.name} copy ${n}`;
  await editProfile(null, undefined, { template: p, name, onSaved: created });
}

async function edit(p: Profile) {
  const saved = await editProfile(p);
  if (!saved) return;
  await refresh();
  await ensureFont(saved.appearance.fontFamily, saved.appearance.fontSize);
  for (const t of tabs) t.applyProfile(saved);
}

async function remove(p: Profile) {
  const apiNote = p.protocol === "api" ? ` Its saved requests and environments are deleted with it.` : "";
  if (!confirm(`Delete profile "${p.name}"?${apiNote}`)) return;
  if (p.protocol === "api") {
    for (const t of tabs.filter((t) => t instanceof ApiTab && t.usesProfile(p.id))) { tabs.splice(tabs.indexOf(t), 1); t.dispose(); }
    activate(tabs.includes(active as AnyTab) ? active : (tabs[tabs.length - 1] ?? null));
    await httpStore.deleteConnection(p.id);
  }
  await api.deleteProfile(p.id);
  await refresh();
}

// ---------------------------------------------------------------- tabs and panes

const findProfile = (id: string) => profiles.find((p) => p.id === id) ?? localTerms.find((p) => p.id === id);

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
  t.onRetitle = renumber;
  dragReorder(t);
  t.onPaneMenu = (e) => menuOn(e, paneMenu(t));
  tabs.push(t);
  tabBar.append(t.header);
  stage.append(t.el);
  renumber();
  return t;
}

/** Terminal tabs on the same profile are numbered 1, 2, 3… in tab order; a lone tab keeps its plain name. */
function renumber() {
  const groups = new Map<string, Tab[]>();
  for (const t of tabs) if (t instanceof Tab) groups.set(t.focused.profile.id, [...(groups.get(t.focused.profile.id) ?? []), t]);
  for (const g of groups.values()) g.forEach((t, i) => t.setOrdinal(g.length > 1 ? i + 1 : 0));
}

/** Lets a tab header be dragged to a new place in the tab bar. */
let dragging: AnyTab | null = null;
function dragReorder(t: AnyTab) {
  const el = t.header;
  const side = (e: DragEvent) => (e.clientX < el.getBoundingClientRect().left + el.offsetWidth / 2 ? "before" : "after");
  const clear = () => el.classList.remove("drop-before", "drop-after");
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    dragging = t;
    e.dataTransfer?.setData("text/plain", t.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    el.classList.remove("dragging");
    for (const x of tabs) x.header.classList.remove("drop-before", "drop-after");
  });
  el.addEventListener("dragover", (e) => {
    if (!dragging || dragging === t) return;
    e.preventDefault();
    clear();
    el.classList.add(`drop-${side(e)}`);
  });
  el.addEventListener("dragleave", clear);
  el.addEventListener("drop", (e) => {
    const moved = dragging;
    clear();
    if (!moved || moved === t) return;
    e.preventDefault();
    tabs.splice(tabs.indexOf(moved), 1);
    moveTab(moved, tabs.indexOf(t) + (side(e) === "after" ? 1 : 0));
  });
}

/** Puts a tab (already taken out of `tabs`) at an index, in the array and in the tab bar. */
function moveTab(moved: AnyTab, at: number) {
  tabs.splice(at, 0, moved);
  const next = tabs[at + 1];
  tabBar.insertBefore(moved.header, next ? next.header : tabBar.querySelector(".tab-drag"));
  renumber();
  persist();
}

// The empty part of the tab bar, after the last tab, is a drop target for "move to the end".
const lastTab = () => tabs[tabs.length - 1];
const inGap = (e: DragEvent) => !!dragging && !(e.target as HTMLElement).closest(".tab");
tabBar.addEventListener("dragover", (e) => {
  if (!inGap(e)) return;
  e.preventDefault();
  lastTab()?.header.classList.toggle("drop-after", dragging !== lastTab());
});
tabBar.addEventListener("dragleave", (e) => {
  if (e.target === tabBar || !(e.target as HTMLElement).closest(".tab")) lastTab()?.header.classList.remove("drop-after");
});
tabBar.addEventListener("drop", (e) => {
  if (!inGap(e)) return;
  e.preventDefault();
  const moved = dragging;
  lastTab()?.header.classList.remove("drop-after");
  if (!moved || moved === lastTab()) return;
  tabs.splice(tabs.indexOf(moved), 1);
  moveTab(moved, tabs.length);
});

async function renameTab(tab: Tab) {
  const name = await promptText("Rename tab", "Name", tab.title);
  if (name) tab.rename(name);
}

const LAST_API = "portique.api.last";

const apiTabFor = (p: Profile) => tabs.find((t): t is ApiTab => t instanceof ApiTab && t.usesProfile(p.id));

/** Opens an API connection as a tab (an already open one is just brought forward). */
function openApi(p: Profile) {
  try { localStorage.setItem(LAST_API, p.id); } catch {}
  const open = apiTabFor(p);
  if (open) return activate(open);
  attach(new ApiTab(p, { editConnection: (pr) => void edit(pr) }));
}

/** Ctrl+Shift+A: a new request on the connection on screen, else on the one used last, else make a first connection. */
function newApiRequest() {
  if (active instanceof ApiTab) return active.newRequest();
  const all = profiles.filter((p) => p.protocol === "api").sort((a, b) => a.name.localeCompare(b.name));
  if (!all.length) return void newProfile("api");
  let last = "";
  try { last = localStorage.getItem(LAST_API) ?? ""; } catch {}
  const p = all.find((x) => x.id === last) ?? all[0];
  openApi(p);
  apiTabFor(p)?.newRequest();
}

function attach(t: FileTab | ApiTab) {
  dragReorder(t);
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
  if (p.protocol === "api") return openApi(p);
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

// Coming back to the window clears the flag on the tab in front of you.
window.addEventListener("focus", () => active?.header.classList.remove("unread"));

function closeTab(tab: AnyTab) {
  if (tab instanceof ApiTab && !tab.confirmClose()) return;
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.dispose();
  renumber();
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
    { label: "Rename tab…", action: () => void renameTab(tab) },
    ...(tab.customName ? [{ label: "Reset tab name", action: () => tab.rename(null) }] : []),
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
    alert(`Drop-down mode could not be changed:\n${String(e)}`);
  }
}

/** Applies settings that affect the running UI (the saved copy is already on disk). */
function applySettings(s: Settings) {
  settings = { ...s, ui: { ...DEFAULT_UI, ...s.ui } };
  document.documentElement.style.setProperty("--s", s.uiScale === "large" ? "1.2" : "1");
  sideLayout.refit();
  FileTab.defaultLocalDir = s.sftpLocalDir;
  TerminalTab.gpu = s.gpu;
  for (const t of tabs) t.setGpu(s.gpu);
}

async function openSettings() {
  const s = await settingsDialog(settings);
  if (!s) return;
  applySettings(s);
  await loadLocal();
  renderProfiles();
}

/** Asks which shells on this computer the settings turn on. A failure just means none are offered. */
async function loadLocal() {
  localTerms = await api.listLocalTerminals().catch(() => []);
}

/** Opens the look dialog for a local shell; it is saved by the dialog and shown at once in every tab on that shell. */
async function localAppearance(p: Profile) {
  const look = await localLookDialog(p);
  if (look) adoptLocalLook(p, look);
}

function adoptLocalLook(p: Profile, look: Profile["appearance"]) {
  const updated = { ...p, appearance: look };
  localTerms = localTerms.map((x) => (x.id === p.id ? updated : x));
  for (const t of tabs) t.applyProfile(updated);
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
    const term = tab.focused;
    if (term.connected)
      for (const c of term.profile.commands)
        add(`${term.profile.name} commands`, `cmd:${term.profile.id}:${c.id}`, c.name, () => void runSavedCommand(term, c), { subtitle: c.text.split("\n")[0], keywords: c.text });
    // Tools that run on this host: one row to browse them, every tool when typing. They use the open connection.
    if (term.session && term.profile.protocol === "ssh") {
      add("Server", "server-tools", "Server tools…", () => showPalette("commands", "Server "), { only: "browse", subtitle: `facts, services, containers and logs on ${term.profile.name}`, keywords: "host machine" });
      for (const t of serverTools({ name: term.profile.name, session: () => term.session, type: (text, run) => term.typeCommand(text, run) }))
        add("Server", `server:${term.profile.id}:${t.id}`, t.title, () => void openTool(t), { only: "search", subtitle: t.hint, keywords: t.keywords });
    }
    if (tab.focused.profile.protocol === "ssh") add("This tab", "files-here", "Open file browser for this host", () => openFiles(tab.focused.profile), { keywords: "sftp" });
  }
  if (active) add("This tab", "close-tab", "Close tab", () => closeTab(active!));
  for (const t of tabs) if (t !== active) add("Tabs", `tab:${t.title}:${tabs.indexOf(t)}`, `Switch to ${t.title}`, () => activate(t), { subtitle: t instanceof FileTab ? "file browser" : t instanceof ApiTab ? "API" : "" });

  // Hosts: all connections first, then all file browsers.
  const hosts = [...localTerms, ...profiles].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of hosts) add("Connect", `connect:${p.id}`, p.name, () => openTab(p), { subtitle: describe(p), keywords: p.protocol === "local" ? "local shell terminal this computer" : p.group });
  for (const p of hosts.filter((x) => x.protocol === "ssh"))
    add("Files", `files:${p.id}`, `Browse files on ${p.name}`, () => openFiles(p), { subtitle: describe(p), keywords: `sftp upload download ${p.group}` });
  for (const w of ws.named) add("Workspaces", `ws:${w.id}`, `Open workspace ${w.name}`, () => openWorkspace(w), { subtitle: `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}` });

  // API connections (they are also listed with the hosts above, under Connect).
  add("API", "new-request", "New API request", () => newApiRequest(), { hint: "Ctrl+Shift+A", keywords: "http rest curl endpoint" });
  add("API", "new-connection", "New API connection…", () => void newProfile("api"), { keywords: "http rest endpoint base url" });
  if (active instanceof ApiTab) {
    const a = active;
    add("API", "send", "Send the request", () => void a.active?.sendNow(), { hint: "Ctrl+Enter" });
    add("API", "save-request", "Save the request", () => void a.active?.save(), { hint: "Ctrl+S" });
    add("API", "environments", "Environments…", () => a.manageEnvironments(), { keywords: "variables secrets token" });
    add("API", "import-requests", "Import requests…", () => void a.importFile(), { keywords: "collection openapi swagger curl file" });
    add("API", "export-requests", "Export requests…", () => void a.exportFile(), { keywords: "backup save file" });
    add("API", "conn-settings", "Connection settings…", () => a.editSettings(), { keywords: "base url auth headers" });
  }
  for (const { conn, request } of httpStore.all()) {
    const p = findProfile(conn);
    if (p) add("API", `request:${request.id}`, `${p.name}: ${request.name}`, () => { openApi(p); apiTabFor(p)?.select(request.id); }, { subtitle: `${request.method} ${request.url}`, keywords: `${request.group} api http` });
  }

  if (tab && tab.focused.profile.protocol === "local") {
    const p = localTerms.find((x) => x.id === tab.focused.profile.id);
    if (p) add("This tab", "local-look", `Appearance of ${p.name}…`, () => void localAppearance(p), { keywords: "theme font colours cursor local terminal" });
  }
  if (tab && isQuick(tab.focused.profile)) {
    const p = tab.focused.profile;
    add("This tab", "save-quick", `Save ${p.name} as a profile…`, () => void saveQuick(p), { keywords: "quick connect keep" });
  }

  // The toolbox: one row in the default list, every tool when typing ("port", "hash", "subnet"…).
  add("Toolbox", "toolbox", "Toolbox…", () => showPalette("commands", "Toolbox "), { only: "browse", subtitle: "port check, DNS, passwords, converters and more", keywords: "tools utilities" });
  for (const t of TOOLS) add("Toolbox", `tool:${t.id}`, t.title, () => void openTool(t), { only: "search", subtitle: t.hint, keywords: t.keywords });

  // The app.
  add("App", "new-profile", "New profile…", () => void newProfile());
  add("App", "save-workspace", "Save workspace…", () => void saveWorkspace());
  add("App", "ssh-keys", "SSH keys…", () => void manageKeysDialog());
  add("App", "lock", "Lock the vault", () => void api.vaultLock().then(() => ensureUnlocked()));
  add("App", "master-pw", "Change master password…", () => void changePasswordDialog());
  add("App", "sidebar", sideLayout.isCollapsed() ? "Show the sidebar" : "Hide the sidebar", () => sideLayout.toggle(), { hint: "Ctrl+Shift+B", keywords: "collapse full width" });
  add("App", "shortcuts", "Keyboard shortcuts", () => toggleHelp(settings.quakeKey, settings.quake), { hint: "F1" });
  add("Appearance", "ui-colours", "Interface colours…", () => void chromeDialog(settings.ui).then((ui) => { if (ui) settings.ui = ui; }));
  add("Appearance", "themes", "Terminal colour themes…", async () => { await themeDialog("portique-nuit"); await loadThemes(); renderProfiles(); });
  for (const n of PRESET_NAMES) add("Appearance", `preset:${n}`, `Interface look: ${n}`, () => void applyPreset(n));
  add("App", "settings", "Settings…", () => void openSettings(), { keywords: "preferences hotkey startup font size gpu drop-down" });
  add("App", "gpu", `${settings.gpu ? "Turn off" : "Turn on"} GPU rendering`, () => void toggleGpu());
  add("App", "quake", `${settings.quake ? "Turn off" : "Turn on"} drop-down mode (${settings.quakeKey})`, () => void toggleQuake());
  return out;
}

/** Types a saved command into a terminal, asking for each `{{value}}` it names first. */
async function runSavedCommand(term: TerminalTab, c: SavedCommand) {
  const values: Record<string, string> = {};
  for (const name of placeholders(c.text)) {
    const v = await promptText(c.name, `Value for ${name}`);
    if (v === null) return;
    values[name] = v;
  }
  term.typeCommand(fillPlaceholders(c.text, values), c.mode === "run");
}

/** Opens the profile editor on a quick-connect host so it can be kept; the open tab carries on as it is. */
async function saveQuick(p: Profile) {
  const saved = await editProfile({ ...p, id: "" });
  if (saved) await refresh();
}

const QUICK_USER = "portique.quick.user";

/** Opens a host that isn't saved, in a new tab named after it. Asks for a user name when the text had none. */
async function quickConnect(t: QuickTarget) {
  let user = t.user;
  if (!user) {
    let last = "";
    try { last = localStorage.getItem(QUICK_USER) ?? ""; } catch {}
    const asked = await promptText("Quick connect", `User name for ${quickLabel(t)}`, last);
    if (!asked) return;
    user = asked;
  }
  try { localStorage.setItem(QUICK_USER, user); } catch {}
  try {
    openTab(await api.quickProfile(quickProfileFor(t, user)));
  } catch (e) {
    alert(`Can't connect:\n${String(e)}`);
  }
}

/** Entries made from the typed text. */
function dynamicItems(query: string): PaletteItem[] {
  const out: PaletteItem[] = [];
  const t = parseQuickTarget(query);
  if (t) out.push({
    id: `quick:${query}`, group: "Quick connect", pin: t.clear ? "top" : "bottom",
    title: `Connect to ${quickLabel(t)}`,
    subtitle: `${t.protocol === "ssh" ? "SSH" : "Telnet"}${t.user ? ` as ${t.user}` : ""}, not saved`,
    run: () => void quickConnect(t),
  });
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

const showPalette = (mode: "commands" | "find", initial = "") => openPalette({ items: paletteItems, dynamic: dynamicItems, findTarget }, mode, initial);

// ---------------------------------------------------------------- shortcuts

const ARROWS: Record<string, Arrow> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The action for a key press, or null. Also used by terminals to know which keys not to swallow. */
function matchKey(e: KeyboardEvent): (() => void) | null {
  if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.shiftKey) return () => toggleHelp(settings.quakeKey, settings.quake);
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyP") return () => showPalette("commands");
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF") return () => showPalette("find");
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyA") return () => newApiRequest();
  if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyB") return () => sideLayout.toggle();
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
    const cur = profiles.find((x) => x.id === p.id) ?? localTerms.find((x) => x.id === p.id);
    if (!cur || cur.appearance.fontSize === size) return;
    if (cur.protocol === "local") {
      const look = { ...cur.appearance, fontSize: size };
      if (await api.setLocalLook(cur.id, look).then(() => true, () => false)) adoptLocalLook(cur, look);
      return;
    }
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
const settingsLoaded = api.getSettings().then((s) => {
  applySettings(s);
  applyChrome(settings.ui);
}).catch(() => {});
void ensureUnlocked().then(async () => {
  await refresh();
  if (await httpStore.load()) await refresh(); // requests saved before connections existed were moved into a connection of their own
  await loadWorkspaces();
  await settingsLoaded; // whether to reopen the last tabs is a setting
  await loadLocal(); // and tabs on local shells can only reopen once those are known
  if (settings.restoreTabs) restoreLast();
  ready = true;
  renderProfiles();
});
