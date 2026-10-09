import { api } from "./api";
import { Environment, EnvVar } from "./http-model";
import type { ConnStore } from "./http-store";
import { h, modal } from "./ui";

interface Row extends EnvVar {
  /** A secret already in the vault: its value is never shown, and typing replaces it. */
  stored: boolean;
  /** The name it had when the dialog opened (stored secrets can't be renamed). */
  was: string;
}

interface Draft {
  id: string;
  name: string;
  rows: Row[];
}

/** The environments editor: named sets of variables (`{{name}}`) that requests are filled in with. */
export async function environmentsDialog(store: ConnStore, selectId = ""): Promise<boolean> {
  const drafts: Draft[] = await Promise.all(store.data.envs.map(async (e) => ({
    id: e.id,
    name: e.name,
    rows: await Promise.all(e.vars.map(async (v) => ({
      ...v,
      was: v.key,
      stored: v.secret ? await api.hasApiSecret(e.id, v.key).catch(() => true) : false,
    }))),
  })));
  let current = drafts.find((d) => d.id === selectId) ?? drafts.find((d) => d.id === store.data.activeEnv) ?? drafts[0];

  const list = h("div", { class: "env-list" });
  const editor = h("div", { class: "env-editor" });

  const add = () => {
    const d: Draft = { id: crypto.randomUUID(), name: `Environment ${drafts.length + 1}`, rows: [] };
    drafts.push(d);
    current = d;
    render();
    (editor.querySelector(".env-name") as HTMLInputElement | null)?.select();
  };

  const render = () => {
    list.replaceChildren(
      ...drafts.map((d) => h("button", { class: "env-item" + (d === current ? " on" : ""), onclick: () => { current = d; render(); } }, d.name || "Untitled")),
      h("button", { class: "env-add", onclick: add }, "+ Add environment"));
    editor.replaceChildren(...(current ? editorFor(current) : [
      h("div", { class: "env-empty" },
        h("p", {}, "An environment is a set of named values, such as a server address or an API token."),
        h("p", {}, "Write ", h("code", {}, "{{name}}"), " anywhere in a request, and it is filled in when you press Send. Switch environments to run the same requests against staging or production."),
        h("button", { class: "primary", onclick: add }, "Create your first environment")),
    ]));
  };

  const editorFor = (d: Draft): HTMLElement[] => {
    const name = h("input", { class: "env-name", value: d.name, placeholder: "Name, e.g. Production", spellcheck: false });
    name.addEventListener("input", () => {
      d.name = name.value;
      const on = list.querySelector(".env-item.on");
      if (on) on.textContent = d.name || "Untitled";
    });
    const rows = h("div", { class: "env-rows" });
    const draw = () => {
      if (!d.rows.length || d.rows[d.rows.length - 1].key || d.rows[d.rows.length - 1].value) d.rows.push({ key: "", value: "", secret: false, stored: false, was: "" });
      rows.replaceChildren(
        h("div", { class: "env-row head" }, h("span", {}, "Variable"), h("span", {}, "Value"), h("span", { title: "Kept encrypted in the vault, and never shown again" }, "Secret"), h("span")),
        ...d.rows.map((r, i) => {
          const last = i === d.rows.length - 1;
          const locked = r.stored && r.secret && r.was !== "";
          const key = h("input", { value: r.key, placeholder: last ? "name" : "", spellcheck: false, readOnly: locked, title: locked ? "A saved secret can't be renamed. Delete it and add it again." : "" });
          const value = h("input", { value: r.value, spellcheck: false, type: r.secret ? "password" : "text", autocomplete: "off",
            placeholder: r.secret && r.stored ? "•••••••• saved (type to replace)" : last ? "value" : "" });
          const secret = h("input", { type: "checkbox", checked: r.secret, "aria-label": "Secret" });
          key.addEventListener("input", () => { r.key = key.value.trim(); if (last && r.key) draw(); });
          value.addEventListener("input", () => { r.value = value.value; if (last && r.value) draw(); });
          secret.addEventListener("change", () => {
            r.secret = secret.checked;
            if (!r.secret) { r.value = ""; r.stored = false; } // the old secret is deleted on save
            draw();
          });
          const del = h("button", { class: "mini row-del", title: "Remove", onclick: () => { d.rows.splice(i, 1); draw(); } }, "✕");
          return h("div", { class: "env-row" }, key, value, secret, last ? h("span") : del);
        }));
    };
    draw();
    return [
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      rows,
      h("small", { class: "muted" }, "Use a variable as ", h("code", {}, "{{name}}"), " in a URL, header, body or login. ", h("code", {}, "{{$uuid}}"), " and ", h("code", {}, "{{$timestamp}}"), " are always available."),
      h("div", { class: "env-foot" }, h("button", { class: "fm-link danger", onclick: () => {
        if (!confirm(`Delete the environment "${d.name}"? Its secrets are removed from the vault.`)) return;
        drafts.splice(drafts.indexOf(d), 1);
        current = drafts[0];
        render();
      } }, "Delete this environment")),
    ];
  };
  render();

  let saved = false;
  await modal("Environments", h("div", { class: "env-dialog" }, list, editor), [
    { label: "Cancel" },
    { label: "Save", primary: true, action: async () => {
      const names = new Set<string>();
      for (const d of drafts) {
        if (!d.name.trim()) throw new Error("Give every environment a name.");
        if (names.has(d.name.trim().toLowerCase())) throw new Error(`There are two environments called "${d.name.trim()}".`);
        names.add(d.name.trim().toLowerCase());
        const keys = new Set<string>();
        for (const r of d.rows.filter((r) => r.key)) {
          if (!/^[A-Za-z_$][\w.$-]*$/.test(r.key)) throw new Error(`"${r.key}" in ${d.name} isn't a usable variable name. Use letters, digits, _ . or -.`);
          if (keys.has(r.key)) throw new Error(`${d.name} has the variable "${r.key}" twice.`);
          keys.add(r.key);
        }
      }
      // Secrets go to the vault; anything that stopped being one, or was removed, is deleted from it.
      const before = store.data.envs;
      for (const d of drafts) {
        for (const r of d.rows.filter((r) => r.key && r.secret && r.value)) await api.setApiSecret(d.id, r.key, r.value);
      }
      for (const e of before) {
        const now = drafts.find((d) => d.id === e.id);
        for (const v of e.vars.filter((v) => v.secret)) {
          if (!now?.rows.some((r) => r.key === v.key && r.secret)) await api.setApiSecret(e.id, v.key, "").catch(() => {});
        }
      }
      store.data.envs = drafts.map((d): Environment => ({
        id: d.id,
        name: d.name.trim(),
        vars: d.rows.filter((r) => r.key).map((r) => ({ key: r.key, value: r.secret ? "" : r.value, secret: r.secret })),
      }));
      if (!store.data.envs.some((e) => e.id === store.data.activeEnv)) store.data.activeEnv = "";
      await store.persist();
      saved = true;
    } },
  ], true);
  return saved;
}
