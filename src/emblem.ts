import svg from "./assets/portique.svg?raw";

/** The built-in colours in the artwork, and the interface variables that stand in for them. */
const THEMED: Record<string, string> = {
  "#c9a45c": "var(--accent)",
  "#0b0f19": "var(--door)",
  "#e9e4d6": "var(--door-ink)",
};

/**
 * The Portique emblem as an inline image whose colours follow the interface theme:
 * the arch takes the accent colour, the doorway and its prompt take `--door` and `--door-ink`.
 */
export function emblem(cls = ""): SVGElement {
  const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement as unknown as SVGElement; // our own bundled file
  for (const node of el.querySelectorAll<SVGElement>("[fill], [stroke]")) {
    for (const prop of ["fill", "stroke"] as const) {
      const v = THEMED[(node.getAttribute(prop) ?? "").toLowerCase()];
      if (v) {
        node.style.setProperty(prop, v);
        node.removeAttribute(prop);
      }
    }
  }
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  return document.importNode(el, true);
}
