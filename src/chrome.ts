import type { UiColours } from "./api";
import { api } from "./api";
import { field, h, modal } from "./ui";

export const DEFAULT_UI: UiColours = { side: "", top: "", content: "", accent: "", plainTabs: false };

/** Named looks for the interface; the first is the built-in one. */
const PRESETS: { name: string; ui: Omit<UiColours, "plainTabs"> }[] = [
  { name: "Nuit", ui: { side: "", top: "", content: "", accent: "" } },
  { name: "Ivoire", ui: { side: "#ece6d6", top: "#e3dbc6", content: "#f7f3e8", accent: "#8a6d2f" } },
  { name: "Bordeaux", ui: { side: "#2a1219", top: "#351720", content: "#1d0d13", accent: "#d9b26f" } },
  { name: "Forêt", ui: { side: "#101e19", top: "#162820", content: "#0c1713", accent: "#c9a45c" } },
  { name: "Ardoise", ui: { side: "#1c2128", top: "#242b35", content: "#14181d", accent: "#9fb8d0" } },
];

export const PRESET_NAMES = PRESETS.map((p) => p.name);

/** A named look, keeping the user's tab-style choice. */
export function presetUi(name: string, current: UiColours): UiColours {
  const p = PRESETS.find((x) => x.name === name) ?? PRESETS[0];
  return { ...p.ui, plainTabs: current.plainTabs };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** WCAG relative luminance. */
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const isLight = (hex: string) => luminance(hex) > 0.35;
const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a}, ${b} ${pct}%)`;

/**
 * Colours that carry meaning (success, failure, method names, JSON syntax). The pale ones that read well on a dark
 * background wash out on a light one, so each region gets the set that suits its own background.
 */
const SEMANTIC = {
  dark: {
    "--ok": "#6fb98f", "--warn": "#d29922", "--danger": "#e5767a", "--info": "#6e9fd8", "--violet": "#a58bd6",
    "--j-str": "#8fc4a3", "--j-num": "#7fa8dc", "--j-lit": "#c39bd3",
  },
  light: {
    "--ok": "#236a40", "--warn": "#7c5000", "--danger": "#a82f38", "--info": "#285a98", "--violet": "#65459f",
    "--j-str": "#236a40", "--j-num": "#285a98", "--j-lit": "#74409a",
  },
};

/** Re-colours one region (and everything inside it) by overriding the variables its children read. */
function paintRegion(el: Element | null, bg: string, content = false) {
  const s = (el as HTMLElement | null)?.style;
  if (!s) return;
  const props = ["--bg", "--panel", "--panel2", "--line", "--text", "--muted", "--door", "--door-ink", ...Object.keys(SEMANTIC.dark), "color-scheme"];
  if (!bg) return props.forEach((p) => s.removeProperty(p));
  const light = isLight(bg);
  const text = light ? "#23252d" : "#e4e1d6";
  // The main area's own colour is the page background; its headers and panels sit a shade away from it.
  if (content) s.setProperty("--bg", bg);
  s.setProperty("--panel", content ? mix(bg, text, 5) : bg);
  s.setProperty("--panel2", mix(bg, text, 9));
  s.setProperty("--line", mix(bg, text, 18));
  s.setProperty("--text", text);
  s.setProperty("--muted", mix(bg, text, 62));
  // The emblem's doorway: dark ink on a light region, a deeper shade of the region on a dark one.
  s.setProperty("--door", light ? text : mix(bg, "#000000", 55));
  s.setProperty("--door-ink", light ? bg : text);
  for (const [k, v] of Object.entries(light ? SEMANTIC.light : SEMANTIC.dark)) s.setProperty(k, v);
  s.setProperty("color-scheme", light ? "light" : "dark");
}

/** With no explicit content colour, the main area (empty screen, file browser) follows the sidebar instead of staying stock navy. */
const contentFor = (side: string) => {
  if (!side) return "";
  const to = isLight(side) ? 1 : 0, k = isLight(side) ? 0.55 : 0.25;
  return "#" + rgb(side).map((c) => Math.round((c + (to - c) * k) * 255).toString(16).padStart(2, "0")).join("");
};

/** Applies interface colours to the live document. */
export function applyChrome(ui: UiColours) {
  document.documentElement.classList.toggle("plain-tabs", ui.plainTabs);
  // The document itself takes the content look, so dialogs, menus and the palette (which sit outside the regions below) match it too.
  paintRegion(document.documentElement, ui.content, true);
  paintRegion(document.querySelector("aside"), ui.side);
  paintRegion(document.querySelector("main"), ui.content || contentFor(ui.side), true);
  paintRegion(document.querySelector(".tabbar"), ui.top);
  const root = document.documentElement.style;
  if (!ui.accent) return ["--accent", "--accent-hi", "--on-accent"].forEach((p) => root.removeProperty(p));
  root.setProperty("--accent", ui.accent);
  root.setProperty("--accent-hi", mix(ui.accent, "#ffffff", 22));
  root.setProperty("--on-accent", isLight(ui.accent) ? "#10151f" : "#ffffff");
}

const same = (a: Omit<UiColours, "plainTabs">, b: UiColours) => a.side === b.side && a.top === b.top && a.content === b.content && a.accent === b.accent;
const BASE: Record<"side" | "top" | "content" | "accent", string> = { side: "#141a29", top: "#141a29", content: "#0f1420", accent: "#c9a45c" };

/** Dialog for choosing interface colours, previewed live. Resolves with the saved colours, or null if cancelled. */
export async function chromeDialog(current: UiColours): Promise<UiColours | null> {
  let draft: UiColours = { ...current };
  const picker = (key: "side" | "top" | "content" | "accent") => {
    const input = h("input", { type: "color", value: draft[key] || BASE[key] });
    input.addEventListener("input", () => { draft[key] = input.value; sync(); });
    return input;
  };
  const side = picker("side"), top = picker("top"), content = picker("content"), accent = picker("accent");
  const presetBar = h("div", { class: "presets" });
  const sync = () => {
    applyChrome(draft);
    for (const b of presetBar.children) b.classList.toggle("on", same(PRESETS.find((p) => p.name === b.textContent)!.ui, draft));
  };
  for (const p of PRESETS)
    presetBar.append(h("button", { onclick: () => {
      draft = { ...p.ui, plainTabs: draft.plainTabs };
      side.value = draft.side || BASE.side; top.value = draft.top || BASE.top; content.value = draft.content || BASE.content; accent.value = draft.accent || BASE.accent;
      sync();
    } }, p.name));
  const plain = h("input", { type: "checkbox", checked: draft.plainTabs });
  plain.addEventListener("change", () => { draft.plainTabs = plain.checked; sync(); });
  sync();
  let saved: UiColours | null = null;
  await modal("Interface colours", h("div", {},
    h("p", { class: "muted" }, "Colours of the sidebar, tab bar, main area (including the file browser) and highlights. Terminal colours are set per profile under Colour themes."),
    presetBar,
    h("div", { class: "grid4" }, field("Sidebar", side), field("Tab bar", top), field("Content", content), field("Accent", accent)),
    h("label", { class: "check" }, plain, " Tabs use these colours, not their terminal theme's")),
  [
    { label: "Cancel" },
    { label: "Save", primary: true, action: async () => { await api.setUi(draft); saved = draft; } },
  ]);
  if (!saved) applyChrome(current);
  return saved;
}
