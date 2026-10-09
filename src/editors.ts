import { api, type Forward, type KeyInfo, newProfile, type Profile, type Theme } from "./api";
import { allThemes, getTheme, isBuiltin, loadThemes } from "./themes";

const DEFAULT_FONT = "Cascadia Mono, Consolas, 'DejaVu Sans Mono', monospace";
import { field, h, modal } from "./ui";

const FONTS = [
  "Cascadia Mono", "Cascadia Code", "Consolas", "Fira Code", "JetBrains Mono", "Source Code Pro",
  "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", "Hack", "Courier New", "monospace",
];
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DEFAULT_PORT = { ssh: 22, telnet: 23, serial: 0 };

const opt = (value: string | number, label: string, selected: boolean) =>
  h("option", { value: String(value), selected }, label);

const select = (items: [string | number, string][], current: string | number) =>
  h("select", {}, ...items.map(([v, l]) => opt(v, l, String(v) === String(current))));

// ---------------------------------------------------------------- profile editor

/** Opens the profile editor. Resolves with the saved profile, or null if cancelled. */
export async function editProfile(existing: Profile | null): Promise<Profile | null> {
  const p: Profile = structuredClone(existing ?? newProfile());
  const hadPassword = p.id ? await api.hasPassword(p.id).catch(() => false) : false;
  const keys = await api.listKeys();
  await loadThemes();

  const name = h("input", { value: p.name, placeholder: "e.g. core-switch-1" });
  const group = h("input", { value: p.group, placeholder: "e.g. Work, Home", list: "groups" });
  const proto = select([["ssh", "SSH"], ["telnet", "Telnet"], ["serial", "Serial"]], p.protocol);
  const host = h("input", { value: p.host, placeholder: "hostname or IP" });
  const port = h("input", { type: "number", value: String(p.port), min: "1", max: "65535" });
  const user = h("input", { value: p.username, autocomplete: "off" });
  const pass = h("input", {
    type: "password",
    autocomplete: "new-password",
    placeholder: hadPassword ? "•••••• (saved — leave blank to keep)" : "not saved",
  });
  const clearPass = h("input", { type: "checkbox" });
  const authSel = select(
    [["password", "Password"], ["key", "Private key"], ["keyAndPassword", "Private key + password"]],
    p.authMethod,
  );
  const keySel = h("select", {});
  const fillKeys = (list: KeyInfo[]) => {
    keySel.replaceChildren(
      opt("", "— choose a key —", !p.keyId),
      ...list.map((k) => opt(k.id, `${k.name} (${k.algorithm})`, k.id === p.keyId)),
    );
  };
  fillKeys(keys);
  const manageKeys = h("button", {
    type: "button",
    onclick: async () => fillKeys(await manageKeysDialog()),
  }, "Manage keys…");

  // jump host and port forwards (SSH)
  const allProfiles = await api.listProfiles();
  const jumpSel = select(
    [["", "None (connect directly)"], ...allProfiles.filter((x) => x.protocol === "ssh" && x.id !== p.id)
      .sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.id, `${x.name} (${x.host})`] as [string, string])],
    p.jumpHost ?? "",
  );
  const fwds: Forward[] = structuredClone(p.forwards ?? []);
  const fwdRows = h("div", { class: "fwds" });
  const fwdTitle = h("span", {});
  const KIND_TIPS = {
    local: "Listen on this machine and reach a host through the server (ssh -L)",
    remote: "Listen on the server and reach a host from this machine (ssh -R)",
    dynamic: "Local SOCKS5 proxy that connects through the server (ssh -D)",
  };
  const renderFwds = () => {
    fwdTitle.textContent = fwds.length ? `Port forwards (${fwds.length})` : "Port forwards";
    fwdRows.replaceChildren(...fwds.map((f) => {
      const kind = select([["local", "Local"], ["remote", "Remote"], ["dynamic", "SOCKS"]], f.kind);
      kind.title = KIND_TIPS[f.kind];
      const num = (v: number, ph: string) => h("input", { type: "number", min: "1", max: "65535", placeholder: ph, value: v ? String(v) : "" });
      const lport = num(f.listenPort, f.kind === "remote" ? "server port" : "local port");
      const dhost = h("input", { value: f.destHost, placeholder: f.kind === "remote" ? "local host" : "destination host" });
      const dport = num(f.destPort, "port");
      const sync = () => {
        f.kind = kind.value as Forward["kind"];
        f.listenPort = Number(lport.value) || 0;
        f.destHost = dhost.value.trim();
        f.destPort = Number(dport.value) || 0;
      };
      for (const e of [lport, dhost, dport]) e.addEventListener("input", sync);
      kind.addEventListener("change", () => { sync(); renderFwds(); });
      const dyn = f.kind === "dynamic";
      return h("div", { class: "fwd" }, kind, lport,
        dyn ? h("span", { class: "muted fwd-note" }, "SOCKS5 proxy on 127.0.0.1") : h("span", { class: "fwd-dest" }, "→ ", dhost, " : ", dport),
        h("button", { type: "button", class: "mini", title: "Remove", onclick: () => { fwds.splice(fwds.indexOf(f), 1); renderFwds(); } }, "✕"));
    }));
  };
  renderFwds();
  const fwdSection = h("details", { class: "fwd-section", open: fwds.length > 0 },
    h("summary", {}, fwdTitle),
    fwdRows,
    h("button", { type: "button", onclick: () => { fwds.push({ kind: "local", listenPort: 0, destHost: "localhost", destPort: 0 }); renderFwds(); } }, "+ Add forward"),
    h("p", { class: "muted" }, "Active while the session is connected."));

  const localDir = h("input", { value: p.localDir ?? "", placeholder: "Default (see Settings)", spellcheck: false });
  const remoteDir = h("input", { value: p.remoteDir ?? "", placeholder: "Login folder", spellcheck: false });
  const filesSection = h("details", { class: "fwd-section", open: !!(p.localDir || p.remoteDir) },
    h("summary", {}, "File browser (SFTP)"),
    field("Start in this folder on this computer", localDir),
    field("Start in this folder on the server", remoteDir),
    h("p", { class: "muted" }, "Leave blank to use the default from Settings, and the login folder on the server."));

  // serial
  const s = p.serial;
  const serialPort = h("input", { value: s.port, list: "serial-ports", placeholder: "COM3 or /dev/ttyUSB0" });
  const portList = h("datalist", { id: "serial-ports" });
  const refreshPorts = async () => {
    const ports = await api.listSerialPorts().catch(() => []);
    portList.replaceChildren(...ports.map((x) => h("option", { value: x.name }, x.description)));
  };
  void refreshPorts();
  const baud = h("input", { type: "number", value: String(s.baud), list: "bauds" });
  const bauds = h("datalist", { id: "bauds" }, ...BAUDS.map((b) => h("option", { value: String(b) })));
  const dataBits = select([[8, "8"], [7, "7"], [6, "6"], [5, "5"]], s.dataBits);
  const parity = select([["none", "None"], ["even", "Even"], ["odd", "Odd"]], s.parity);
  const stopBits = select([[1, "1"], [2, "2"]], s.stopBits);
  const flow = select([["none", "None"], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]], s.flow);

  // appearance
  const a = p.appearance;
  const themeSel = h("select", {});
  const fillThemes = (sel: string) =>
    themeSel.replaceChildren(...allThemes().map((t) => opt(t.id, t.name, t.id === sel)));
  fillThemes(a.themeId);
  const editThemes = h("button", { type: "button", onclick: async () => {
    const chosen = await themeDialog(themeSel.value);
    fillThemes(chosen ?? themeSel.value);
    themeSel.dispatchEvent(new Event("change"));
    renderPreview();
  } }, "Edit themes…");
  const font = h("input", { value: a.fontFamily, list: "fonts" });
  const fonts = h("datalist", { id: "fonts" }, ...FONTS.map((f) => h("option", { value: f })));
  const size = h("input", { type: "number", value: String(a.fontSize), min: "6", max: "48", step: "0.5" });
  const cursor = select([["block", "Block"], ["underline", "Underline"], ["bar", "Bar"]], a.cursorStyle);
  const blink = h("input", { type: "checkbox", checked: a.cursorBlink });
  const ligatures = h("input", { type: "checkbox", checked: a.ligatures });
  const autoReconnect = h("input", { type: "checkbox", checked: p.autoReconnect });
  const scrollback = h("input", { type: "number", value: String(a.scrollback), min: "0", step: "1000" });
  const preview = h("pre", { class: "preview" });
  const renderPreview = () => {
    const t = getTheme(themeSel.value);
    preview.style.background = t.background;
    preview.style.color = t.foreground;
    preview.style.fontFamily = font.value;
    preview.style.fontSize = `${Number(size.value) || 14}px`;
    const col = (text: string, color: string) => h("span", { style: `color:${color}` }, text);
    preview.replaceChildren(
      `user@${host.value || "host"}:~$ ls -la\n`,
      col("drwxr-xr-x", t.ansi[4]), " ", col("config", t.ansi[2]), " ", col("error.log", t.ansi[1]), " ", col("notes.txt", t.ansi[3]), "\n",
      ...t.ansi.map((c) => h("span", { style: `background:${c}` }, "  ")),
    );
  };
  [themeSel, font, size, host].forEach((e) => e.addEventListener("input", renderPreview));
  // A theme can carry a font (e.g. SGI's screen font); picking it applies the font too.
  let prevThemeId = themeSel.value;
  themeSel.addEventListener("change", () => {
    const next = getTheme(themeSel.value);
    const prev = getTheme(prevThemeId);
    if (next.fontFamily) {
      font.value = next.fontFamily;
      if (next.fontSize) size.value = String(next.fontSize);
    } else if (prev.fontFamily && font.value === prev.fontFamily) {
      font.value = DEFAULT_FONT; // leaving a font-bearing theme: go back to the default font
      size.value = "14";
    }
    prevThemeId = themeSel.value;
  });
  renderPreview();

  const forgetHost = h("button", { type: "button", onclick: async () => {
    await api.forgetHost(host.value, Number(port.value) || 22);
    forgetHost.textContent = "Forgotten";
  } }, "Forget saved host key");

  const netSection = h("div", { class: "grid" });
  const sshSection = h("div", { class: "grid" });
  const serialSection = h("div", { class: "grid" });
  const credSection = h("div", { class: "grid" });
  const plainWarn = h("p", { class: "muted warn" },
    "Telnet and serial are not encrypted, and the saved password is typed automatically at the first password prompt after connecting (within 60 s). Only use this on trusted networks and devices.");

  netSection.append(field("Host", host), field("Port", port));
  sshSection.append(
    field("Authentication", authSel),
    field("Private key", h("div", { class: "row" }, keySel, manageKeys)),
    h("label", { class: "check" }, autoReconnect, " Reconnect automatically if the connection drops"),
    field("Jump host", jumpSel, "Connects through another SSH profile (like ProxyJump), using its saved login."),
    field("Host key", forgetHost, "Host keys are pinned on first connect; clear it after a legitimate key change."),
  );
  serialSection.append(
    field("Port", serialPort), field("Baud", baud), field("Data bits", dataBits),
    field("Parity", parity), field("Stop bits", stopBits), field("Flow control", flow), portList, bauds,
  );
  credSection.append(
    plainWarn,
    field("Username", user),
    field("Password", pass, "Kept in the encrypted vault, never in the profile file."),
    h("label", { class: "check" }, clearPass, " Remove saved password"),
  );

  const sync = () => {
    const pr = proto.value as Profile["protocol"];
    netSection.hidden = pr === "serial";
    sshSection.hidden = pr !== "ssh";
    fwdSection.hidden = pr !== "ssh";
    filesSection.hidden = pr !== "ssh";
    serialSection.hidden = pr !== "serial";
    keySel.closest("label")!.hidden = pr !== "ssh" || authSel.value === "password";
    // Password applies to everything except pure key auth.
    const needsPw = pr !== "ssh" || authSel.value !== "key";
    pass.closest("label")!.hidden = !needsPw;
    clearPass.closest("label")!.hidden = !needsPw;
    if (!p.id || Number(port.value) === DEFAULT_PORT[p.protocol]) port.value = String(DEFAULT_PORT[pr] || "");
    plainWarn.hidden = pr === "ssh";
    p.protocol = pr;
  };
  proto.addEventListener("change", sync);
  authSel.addEventListener("change", sync);
  sync();

  const body = h(
    "div",
    { class: "editor" },
    h("div", { class: "grid" }, field("Name", name), field("Group", group), field("Protocol", proto)),
    h("datalist", { id: "groups" }, ...[...new Set(allProfiles.map((x) => x.group).filter(Boolean))].map((g) => h("option", { value: g }))),
    h("h3", {}, "Connection"), netSection, serialSection, sshSection, fwdSection, filesSection,
    h("h3", {}, "Login"), credSection,
    h("h3", {}, "Appearance"),
    h("div", { class: "grid" },
      field("Colour theme", h("div", { class: "row" }, themeSel, editThemes)),
      field("Font", font), field("Font size", size), field("Cursor", cursor),
      field("Scrollback (lines)", scrollback), h("label", { class: "check" }, blink, " Blinking cursor"),
      h("label", { class: "check" }, ligatures, " Font ligatures (needs a font that has them)"), fonts),
    preview,
  );

  let saved: Profile | null = null;
  await modal(existing ? `Edit ${existing.name}` : "New profile", body, [
    { label: "Cancel" },
    {
      label: "Save",
      primary: true,
      action: async () => {
        if (!name.value.trim()) throw new Error("Name is required");
        if (p.protocol === "serial" ? !serialPort.value.trim() : !host.value.trim())
          throw new Error(p.protocol === "serial" ? "Serial port is required" : "Host is required");
        if (p.protocol === "ssh" && authSel.value !== "password" && !keySel.value)
          throw new Error("Choose a private key (or import one with Manage keys)");
        const live = p.protocol === "ssh" ? fwds.filter((f) => f.listenPort || f.destHost !== "localhost" || f.destPort) : [];
        for (const f of live) {
          if (!f.listenPort || f.listenPort > 65535) throw new Error("Each port forward needs a listening port (1-65535)");
          if (f.kind !== "dynamic" && (!f.destHost || !f.destPort || f.destPort > 65535))
            throw new Error("Each port forward needs a destination host and port");
        }
        Object.assign(p, {
          jumpHost: p.protocol === "ssh" ? jumpSel.value || null : null,
          autoReconnect: autoReconnect.checked,
          forwards: live,
          localDir: p.protocol === "ssh" ? localDir.value.trim() : "",
          remoteDir: p.protocol === "ssh" ? remoteDir.value.trim() : "",
          name: name.value.trim(), group: group.value.trim(), host: host.value.trim(),
          port: Number(port.value) || DEFAULT_PORT[p.protocol], username: user.value,
          authMethod: authSel.value, keyId: keySel.value || null,
        });
        Object.assign(p.serial, {
          port: serialPort.value.trim(), baud: Number(baud.value) || 9600, dataBits: Number(dataBits.value),
          parity: parity.value, stopBits: Number(stopBits.value), flow: flow.value,
        });
        Object.assign(p.appearance, {
          themeId: themeSel.value, fontFamily: font.value, fontSize: Number(size.value) || 14,
          cursorStyle: cursor.value, cursorBlink: blink.checked, ligatures: ligatures.checked, scrollback: Number(scrollback.value) || 0,
        });
        saved = await api.saveProfile(p);
        if (clearPass.checked) await api.setPassword(saved.id, "");
        else if (pass.value) await api.setPassword(saved.id, pass.value);
      },
    },
  ], true);
  return saved;
}

// ---------------------------------------------------------------- key manager

/** Key import/delete dialog. Resolves with the refreshed key list. */
export async function manageKeysDialog(): Promise<KeyInfo[]> {
  const list = h("div", { class: "key-list" });
  const render = async () => {
    const keys = await api.listKeys();
    list.replaceChildren(
      ...(keys.length ? keys : []).map((k) =>
        h("div", { class: "key-row" },
          h("div", {}, h("strong", {}, k.name), h("small", {}, ` ${k.algorithm}${k.encrypted ? " · passphrase-protected" : ""}`),
            h("div", { class: "mono small" }, k.fingerprint)),
          h("button", { onclick: async () => {
            if (confirm(`Delete key "${k.name}"? Profiles using it will stop connecting.`)) {
              await api.deleteKey(k.id);
              await render();
            }
          } }, "Delete")),
      ),
      ...(keys.length ? [] : [h("p", { class: "muted" }, "No keys imported yet.")]),
    );
    return keys;
  };
  await render();

  const kname = h("input", { placeholder: "Key name, e.g. work-laptop" });
  const file = h("input", { type: "file" });
  const pem = h("textarea", { rows: 5, placeholder: "…or paste a private key (OpenSSH, PKCS#8, RSA PEM)", spellcheck: false });
  const pp = h("input", { type: "password", placeholder: "Passphrase (if the key is protected)", autocomplete: "off" });
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    pem.value = await f.text();
    if (!kname.value) kname.value = f.name.replace(/\.(pem|key)$/i, "");
  });
  const importBtn = h("button", { class: "primary", onclick: async () => {
    try {
      if (!pem.value.trim()) throw new Error("Choose a file or paste a key first");
      await api.importKey(kname.value.trim() || "imported-key", pem.value, pp.value);
      kname.value = pem.value = pp.value = "";
      file.value = "";
      await render();
    } catch (e) {
      alert(String(e));
    }
  } }, "Import key");

  const body = h("div", {}, list, h("h3", {}, "Import a private key"), kname, file, pem, pp, importBtn,
    h("p", { class: "muted" }, "Keys and passphrases are stored inside the encrypted vault (vault.bin), never as plain files."));
  await modal("SSH keys", body, [{ label: "Close", primary: true }], true);
  return api.listKeys();
}

// ---------------------------------------------------------------- theme editor

const COLOR_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

/** Theme list/editor. Resolves with the id of the theme selected when closing (or null). */
export async function themeDialog(current: string): Promise<string | null> {
  let selected = current;
  const pick = select([], "");
  const area = h("div", { class: "theme-area" });
  const nameIn = h("input", {});

  const redraw = () => {
    pick.replaceChildren(...allThemes().map((t) => opt(t.id, t.name + (isBuiltin(t.id) ? "" : " ★"), t.id === selected)));
    const base = getTheme(selected);
    const draft: Theme = structuredClone(base);
    nameIn.value = isBuiltin(base.id) ? base.name + " (copy)" : base.name;
    const color = (get: () => string, set: (v: string) => void) => {
      const i = h("input", { type: "color", value: get() });
      i.addEventListener("input", () => { set(i.value); paint(); });
      return i;
    };
    const fontIn = h("input", { value: draft.fontFamily ?? "", placeholder: "optional, e.g. 'Irix Screen Mono 15', monospace" });
    const fontSizeIn = h("input", { type: "number", value: draft.fontSize ? String(draft.fontSize) : "", min: "6", max: "48", step: "0.5" });
    const sample = h("pre", { class: "preview" });
    const paint = () => {
      sample.style.background = draft.background;
      sample.style.color = draft.foreground;
      sample.replaceChildren(...draft.ansi.flatMap((c, i) => [
        h("span", { style: `color:${c}` }, i < 8 ? COLOR_NAMES[i] : COLOR_NAMES[i - 8].toUpperCase()), " ",
      ]));
    };
    paint();
    const swatches = h("div", { class: "swatches" },
      ...([
        ["Background", () => draft.background, (v: string) => (draft.background = v)],
        ["Foreground", () => draft.foreground, (v: string) => (draft.foreground = v)],
        ["Cursor", () => draft.cursor, (v: string) => (draft.cursor = v)],
        ["Selection", () => draft.selection, (v: string) => (draft.selection = v)],
        ...draft.ansi.map((_, i) => [
          (i < 8 ? "" : "Bright ") + COLOR_NAMES[i % 8], () => draft.ansi[i], (v: string) => (draft.ansi[i] = v),
        ]),
      ] as [string, () => string, (v: string) => string][]).map(([l, g, s]) => h("label", { class: "swatch" }, color(g, s), h("span", {}, l))),
    );
    const isUser = !isBuiltin(base.id);
    area.replaceChildren(
      field("Theme name", nameIn), swatches, sample,
      h("div", { class: "grid" }, field("Theme font (optional)", fontIn), field("Font size", fontSizeIn)),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: async () => {
          const out: Theme = { ...draft, id: isUser ? base.id : "", name: nameIn.value.trim() || "Custom" };
          out.fontFamily = fontIn.value.trim() || undefined;
          out.fontSize = Number(fontSizeIn.value) || undefined;
          const saved = await api.saveTheme(out);
          await loadThemes();
          selected = saved.id;
          redraw();
        } }, isUser ? "Save changes" : "Save as new theme"),
        isUser ? h("button", { onclick: async () => {
          await api.deleteTheme(base.id);
          await loadThemes();
          selected = "portique-nuit";
          redraw();
        } }, "Delete theme") : null),
    );
  };
  pick.addEventListener("change", () => { selected = pick.value; redraw(); });
  redraw();
  await modal("Colour themes", h("div", {}, field("Theme", pick), area,
    h("p", { class: "muted" }, "Built-in themes can't be changed; saving creates your own copy (★). Assign themes per profile in the profile editor.")),
    [{ label: "Use selected", primary: true }], true);
  return selected;
}
