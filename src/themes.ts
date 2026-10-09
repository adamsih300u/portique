import type { Theme } from "./api";
import { api } from "./api";

const t = (id: string, name: string, background: string, foreground: string, cursor: string, selection: string, ansi: string[]): Theme =>
  ({ id, name, background, foreground, cursor, selection, ansi });

export const BUILTIN_THEMES: Theme[] = [
  t("portique-nuit", "Portique Nuit", "#0f1420", "#e4e1d6", "#c9a45c", "#27324d", [
    "#2e3440", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#4b5263", "#ef8a93", "#b3dd95", "#f0d08f", "#7bc0ff", "#d896ee", "#6fd0dc", "#ffffff"]),
  t("portique-ivoire", "Portique Ivoire", "#f7f3e8", "#2a2d36", "#8a6d2f", "#e3d9bd", [
    "#2b2f36", "#c0392b", "#27803f", "#9a6700", "#1f5fbf", "#8e44ad", "#0e7c86", "#d0d3d8",
    "#59616d", "#e0503f", "#2f9e4d", "#b57d0a", "#3a7be0", "#a35bc4", "#1798a3", "#ffffff"]),
  t("solarized-dark", "Solarized Dark", "#002b36", "#839496", "#93a1a1", "#073642", [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  t("dracula", "Dracula", "#282a36", "#f8f8f2", "#f8f8f2", "#44475a", [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
  t("nord", "Nord", "#2e3440", "#d8dee9", "#d8dee9", "#434c5e", [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  t("gruvbox-dark", "Gruvbox Dark", "#282828", "#ebdbb2", "#ebdbb2", "#504945", [
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  // SGI IRIX shell window: blue background, with SGI's "screen" font (Irix Screen Mono, CC0, bundled).
  // Colours are an approximation from recollection, not sampled from a real IRIX system.
  { ...t("sgi-irix", "SGI IRIX", "#0d1b4c", "#f0f0f0", "#ffe066", "#3b4f9a", [
    "#0d1b4c", "#ff5f5f", "#5fe08a", "#ffe066", "#7ea2ff", "#e07fff", "#5fe0e0", "#f0f0f0",
    "#5a6aa6", "#ff8787", "#8affb0", "#fff08a", "#a9c0ff", "#f0a8ff", "#8affff", "#ffffff"]),
    fontFamily: "'Irix Screen Mono 15', 'Irix Screen Mono 13', Terminus, 'Courier New', monospace", fontSize: 15,
    letterSpacing: 1, lineHeight: 1.1 },
  t("green-phosphor", "Green Phosphor", "#030a03", "#33ff33", "#33ff33", "#0b3d0b", [
    "#030a03", "#1f9f1f", "#33ff33", "#7dff7d", "#22cc22", "#2ee62e", "#1fbf1f", "#33ff33",
    "#0f5f0f", "#2fcf2f", "#66ff66", "#99ff99", "#44dd44", "#55ee55", "#44cc44", "#b6ffb6"]),
  t("amber", "Amber", "#140c00", "#ffb000", "#ffb000", "#4a3000", [
    "#140c00", "#cc5500", "#ffb000", "#ffd060", "#cc8800", "#e69500", "#d9a030", "#ffb000",
    "#6b4a00", "#ff7a1a", "#ffc933", "#ffe08a", "#ffa500", "#ffb733", "#ffc866", "#fff0c8"]),
];

let userThemes: Theme[] = [];

export async function loadThemes() {
  userThemes = await api.listThemes();
}

export const allThemes = () => [...BUILTIN_THEMES, ...userThemes];
export const isBuiltin = (id: string) => BUILTIN_THEMES.some((x) => x.id === id);
// Ids from earlier builds that were merged into the single SGI theme.
const ALIASES: Record<string, string> = {
  "sgi-irix-blue": "sgi-irix", "sgi-indigo-magic": "sgi-irix",
  // From before the app was renamed.
  "termix-dark": "portique-nuit", "termix-light": "portique-ivoire",
};
export const getTheme = (id: string) =>
  allThemes().find((x) => x.id === (ALIASES[id] ?? id)) ?? BUILTIN_THEMES[0];

/** xterm measures glyphs once at open, so make sure webfonts are loaded first. */
export async function ensureFont(fontFamily: string, size: number) {
  const load = Promise.all([
    document.fonts.load(`${size}px ${fontFamily}`),
    document.fonts.load(`bold ${size}px ${fontFamily}`),
  ]);
  await Promise.race([load, new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
}

/** Convert to xterm.js ITheme. */
export function xtermTheme(th: Theme) {
  const n = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const o: Record<string, string> = {
    background: th.background,
    foreground: th.foreground,
    cursor: th.cursor,
    cursorAccent: th.background,
    selectionBackground: th.selection,
  };
  n.forEach((name, i) => {
    o[name] = th.ansi[i];
    o["bright" + name[0].toUpperCase() + name.slice(1)] = th.ansi[i + 8];
  });
  return o;
}
