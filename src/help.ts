import { h } from "./ui";

type Row = [keys: string, what: string];

const sections = (quakeKey: string, quakeOn: boolean): [string, Row[]][] => [
  ["Tabs", [
    ["Ctrl+Tab", "Next tab"],
    ["Ctrl+Shift+Tab", "Previous tab"],
    ["Double-click profile", "Connect"],
    ["Right-click tab", "Split, close"],
  ]],
  ["Panes", [
    ["Ctrl+Shift+D", "Split right"],
    ["Ctrl+Shift+E", "Split down"],
    ["Ctrl+Shift+W", "Close pane (or tab if last)"],
    ["Alt+Shift+Arrows", "Move between panes"],
    ["Drag divider", "Resize (double-click evens out)"],
  ]],
  ["Terminal", [
    ["Ctrl+Shift+C / V", "Copy / paste"],
    ["Right-click", "Copy selection, or paste"],
    ["Shift+Right-click", "Pane menu"],
    ["Ctrl+Shift+↑ / ↓", "Previous / next prompt (needs shell integration)"],
    ["Enter / Esc", "While reconnecting: retry now / stop"],
    ["Ctrl+click", "Open a link"],
    ["Ctrl+wheel", "Text size (also Ctrl+= / Ctrl+-)"],
    ["Ctrl+0", "Reset text size"],
  ]],
  ["File browser (SFTP)", [
    ["Right-click profile", "Open file browser"],
    ["Drag between panes", "Upload / download"],
    ["Double-click / Enter", "Open folder, or copy file across"],
    ["F2 / Del", "Rename / delete"],
    ["Ctrl+Shift+N", "New folder"],
    ["Backspace / Alt+↑", "Parent folder"],
    ["Ctrl+A", "Select all"],
    ["Ctrl+click / Shift+click", "Select several"],
    ["F5", "Refresh"],
  ]],
  ["API connections", [
    ["+ New → API", "Make a connection"],
    ["Double-click", "Open it"],
    ["Ctrl+Shift+A", "New request"],
    ["Ctrl+Enter", "Send"],
    ["Esc", "Cancel while waiting"],
    ["Ctrl+S", "Save the request"],
    ["Ctrl+L", "Go to the address"],
    ["Paste a curl command", "Import it into the request"],
    ["Right-click", "Copy as cURL, environments, settings"],
  ]],
  ["Window", [
    ["Ctrl+Shift+P", "Command palette: hosts, tabs, tools, actions"],
    ["Ctrl+Shift+F", "Find in the terminal's scrollback"],
    ["Enter / F3", "Find: next (Shift: previous)"],
    ["Alt+C / Alt+W / Alt+R", "Find: case / whole word / regex"],
    ["Ctrl+Shift+B", "Show / hide the sidebar"],
    ["Drag sidebar edge", "Resize (double-click resets)"],
    ["F1", "This list"],
    ...(quakeOn ? [[quakeKey, "Show / hide drop-down"]] as Row[] : []),
  ]],
];

let open: HTMLElement | null = null;

/** Closes the shortcuts panel if it is showing. */
function closeHelp() {
  open?.remove();
  open = null;
}

/** Shows (or hides) the shortcuts panel, anchored to the bottom-left above the sidebar footer. */
export function toggleHelp(quakeKey: string, quakeOn: boolean) {
  if (open) return closeHelp();
  const panel = h("div", { class: "help", role: "dialog", "aria-label": "Keyboard shortcuts" },
    ...sections(quakeKey, quakeOn).flatMap(([title, rows]) => [
      h("h4", {}, title),
      ...rows.map(([keys, what]) => h("div", { class: "help-row" },
        h("span", { class: "keys" }, ...keys.split(" / ").flatMap((k, i) => [i ? " / " : "", h("kbd", {}, k)])),
        h("span", {}, what))),
    ]));
  open = panel;
  document.body.append(panel);
  const away = (e: Event) => {
    if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
    if (e.type === "mousedown" && (panel.contains(e.target as Node) || (e.target as HTMLElement).closest?.(".help-link"))) return;
    closeHelp();
    window.removeEventListener("mousedown", away, true);
    window.removeEventListener("keydown", away, true);
  };
  window.addEventListener("mousedown", away, true);
  window.addEventListener("keydown", away, true);
}
