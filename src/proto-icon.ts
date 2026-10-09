import type { Protocol } from "./api";

export type IconKind = Protocol | "sftp" | "workspace";

interface Glyph {
  /** Shown as the tooltip and read out by screen readers. */
  label: string;
  /** SVG path data on a 16 x 16 grid, drawn as 1.4px round strokes. */
  paths: string[];
  /** Small filled dots (cx, cy), for glyphs that need them. */
  dots?: [number, number][];
}

const GLYPHS: Record<IconKind, Glyph> = {
  ssh: { label: "SSH", paths: ["M2.5 3h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M4.8 6.2 7 8l-2.2 1.8", "M8.6 10h2.6"] },
  telnet: { label: "Telnet", paths: ["M2 5.5h11", "M10.5 3l2.5 2.5-2.5 2.5", "M14 10.5H3", "M5.5 8 3 10.5 5.5 13"] },
  serial: { label: "Serial", paths: ["M2 4.5h12l-1.6 7H3.6z"], dots: [[5.2, 7], [8, 7], [10.8, 7], [6.6, 9.3], [9.4, 9.3]] },
  api: { label: "API", paths: ["M6 2.5C4.6 2.5 4.2 3.2 4.2 4.4v1.4c0 1-.6 1.7-1.7 2.2 1.1.5 1.7 1.2 1.7 2.2v1.4c0 1.2.4 1.9 1.8 1.9", "M10 2.5c1.4 0 1.8.7 1.8 1.9v1.4c0 1 .6 1.7 1.7 2.2-1.1.5-1.7 1.2-1.7 2.2v1.4c0 1.2-.4 1.9-1.8 1.9"] },
  local: { label: "Local terminal", paths: ["M3.5 4.5 7.5 8l-4 3.5", "M8.8 12h3.8"] },
  sftp: { label: "File browser (SFTP)", paths: ["M1.8 4.2a1 1 0 0 1 1-1h3.1l1.5 1.7h5.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"] },
  workspace: { label: "Workspace", paths: ["M2.5 2.5h4.2v4.2H2.5z", "M9.3 2.5h4.2v4.2H9.3z", "M2.5 9.3h4.2v4.2H2.5z", "M9.3 9.3h4.2v4.2H9.3z"] },
};

const NS = "http://www.w3.org/2000/svg";

const svgEl = (tag: string, attrs: Record<string, string>) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** The words for a kind of connection ("SSH", "Serial"), for tooltips and lists. */
export const protoLabel = (kind: IconKind) => GLYPHS[kind].label;

/**
 * A small icon for a kind of connection. It takes its colour from the CSS class `pi-<kind>`
 * (the interface variables, so it follows the look) and is announced by its label.
 */
export function protoIcon(kind: IconKind): HTMLElement {
  const g = GLYPHS[kind];
  const svg = svgEl("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" });
  for (const d of g.paths) svg.append(svgEl("path", { d }));
  for (const [cx, cy] of g.dots ?? []) svg.append(svgEl("circle", { cx: `${cx}`, cy: `${cy}`, r: "0.9", class: "pi-fill" }));
  const wrap = document.createElement("span");
  wrap.className = `pi pi-${kind}`;
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", g.label);
  wrap.title = g.label;
  wrap.append(svg);
  return wrap;
}
