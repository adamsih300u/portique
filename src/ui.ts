type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = `${v as string}`;
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : `${v as string}`);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export interface ModalButton {
  label: string;
  primary?: boolean;
  /** Return false to keep the dialog open. */
  action?: () => Promise<boolean | void> | boolean | void;
}

/** Shows a modal dialog; resolves with the label of the button pressed (or null on dismiss). */
export function modal(title: string, body: Node, buttons: ModalButton[], wide = false, dismissable = true): Promise<string | null> {
  return new Promise((resolve) => {
    const error = h("div", { class: "modal-error" });
    const close = (r: string | null) => {
      overlay.remove();
      resolve(r);
    };
    const bar = h(
      "div",
      { class: "modal-buttons" },
      ...buttons.map((b) =>
        h(
          "button",
          {
            class: b.primary ? "primary" : "",
            onclick: async () => {
              error.textContent = "";
              try {
                if ((await b.action?.()) === false) return;
              } catch (e) {
                error.textContent = String(e);
                return;
              }
              close(b.label);
            },
          },
          b.label,
        ),
      ),
    );
    const overlay = h(
      "div",
      { class: "overlay" },
      h("div", { class: "modal" + (wide ? " wide" : "") }, h("h2", {}, title), h("div", { class: "modal-body" }, body), error, bar),
    );
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dismissable) close(null);
    });
    document.body.append(overlay);
    overlay.querySelector<HTMLElement>("input, select, textarea")?.focus();
  });
}

export function field(label: string, input: Node, hint?: string) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);
}

export async function promptSecret(
  title: string,
  label: string,
  offerSave: boolean,
): Promise<{ value: string; save: boolean } | null> {
  const input = h("input", { type: "password", autocomplete: "off" });
  const save = h("input", { type: "checkbox" });
  const submit = () => (document.querySelector(".modal-buttons .primary") as HTMLElement)?.click();
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  const body = h(
    "div",
    {},
    field(label, input),
    offerSave ? h("label", { class: "check" }, save, " Save in encrypted vault") : null,
  );
  let result: { value: string; save: boolean } | null = null;
  await modal(title, body, [
    { label: "Cancel" },
    {
      label: "OK",
      primary: true,
      action: () => {
        result = { value: input.value, save: save.checked };
      },
    },
  ]);
  return result;
}

export const toBytes = (s: string) => new TextEncoder().encode(s);

/** Asks for one line of text. Resolves with the trimmed value, or null if cancelled/empty. */
export async function promptText(title: string, label: string, initial = ""): Promise<string | null> {
  const input = h("input", { value: initial, autocomplete: "off" });
  input.addEventListener("keydown", (e) => e.key === "Enter" && (document.querySelector(".modal-buttons .primary") as HTMLElement)?.click());
  let result: string | null = null;
  await modal(title, field(label, input), [
    { label: "Cancel" },
    { label: "OK", primary: true, action: () => { result = input.value.trim() || null; } },
  ]);
  return result;
}
