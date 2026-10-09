import { invoke, Channel } from "@tauri-apps/api/core";
import { type ApiSettings, defaultApiSettings, sanitizeApiSettings } from "./http-model";
import { type SavedCommand, sanitizeCommands } from "./saved-commands";

export type Protocol = "ssh" | "telnet" | "serial" | "api" | "local";
export type AuthMethod = "password" | "key" | "keyAndPassword";

export interface SerialSettings {
  port: string;
  baud: number;
  dataBits: number;
  parity: "none" | "odd" | "even";
  stopBits: number;
  flow: "none" | "software" | "hardware";
}

export interface Appearance {
  fontFamily: string;
  fontSize: number;
  themeId: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  ligatures: boolean;
}

export interface Forward {
  kind: "local" | "remote" | "dynamic";
  listenPort: number;
  destHost: string;
  destPort: number;
}

export interface Profile {
  id: string;
  name: string;
  group: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyId: string | null;
  serial: SerialSettings;
  appearance: Appearance;
  /** SSH only: id of another SSH profile to tunnel through. */
  jumpHost: string | null;
  /** SSH only: reconnect by itself when the connection drops. */
  autoReconnect: boolean;
  /** SSH only: port forwards that live as long as the session. */
  forwards: Forward[];
  /** SSH only: where this profile's file browser starts on this computer ("": the global setting). */
  localDir: string;
  /** SSH only: where it starts on the server ("": the login folder). */
  remoteDir: string;
  /** API only: base address, default sign-in and headers, and options. */
  api: ApiSettings;
  /** Commands offered in the palette while a tab for this profile is on screen. */
  commands: SavedCommand[];
}

export interface Theme {
  id: string;
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: string[];
  /** Optional: selecting the theme also selects this font. */
  fontFamily?: string;
  fontSize?: number;
  /** Optional: whole pixels added between cells, and a line-height multiplier, while that font is in use. */
  letterSpacing?: number;
  lineHeight?: number;
}

export interface KeyInfo {
  id: string;
  name: string;
  algorithm: string;
  fingerprint: string;
  encrypted: boolean;
}

export interface PortInfo {
  name: string;
  description: string;
}

export function newProfile(): Profile {
  return {
    id: "",
    name: "",
    group: "",
    protocol: "ssh",
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    keyId: null,
    serial: { port: "", baud: 115200, dataBits: 8, parity: "none", stopBits: 1, flow: "none" },
    appearance: {
      fontFamily: "Cascadia Mono, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 14,
      themeId: "portique-nuit",
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 10000,
      ligatures: false,
    },
    jumpHost: null,
    autoReconnect: true,
    forwards: [],
    localDir: "",
    remoteDir: "",
    api: defaultApiSettings(),
    commands: [],
  };
}

let unlockHook: () => Promise<void> = async () => {};
export const setUnlockHook = (f: () => Promise<void>) => (unlockHook = f);

/** Run a vault-dependent call; if the vault is locked, prompt to unlock and retry once. */
async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!String(e).includes("vault is locked")) throw e;
    await unlockHook();
    return f();
  }
}

/** One file or folder in a directory listing (local or remote). */
export interface FileEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  /** Seconds since the epoch. */
  mtime: number | null;
  mode: number | null;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

/** What to copy: `src` and `dst` are full paths (local for uploads' source and downloads' destination). */
export interface TransferItem {
  src: string;
  dst: string;
  isDir: boolean;
}

export interface Settings {
  quake: boolean;
  quakeKey: string;
  gpu: boolean;
  ui: UiColours;
  restoreTabs: boolean;
  sftpLocalDir: string;
  uiScale: "normal" | "large";
  /** Minutes of inactivity before the vault locks itself; 0 = never. */
  vaultIdleMinutes: number;
  /** Offer shells on this computer as terminals. */
  localTerminals: boolean;
  /** Ids of the shells to offer (from `listLocalShells`). */
  localShells: string[];
}

/** A shell found on this computer. */
export interface LocalShell {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Colours of the app chrome; "" means the built-in look. */
export interface UiColours {
  side: string;
  top: string;
  content: string;
  accent: string;
  /** Tabs keep the interface colours instead of taking their terminal theme's. */
  plainTabs: boolean;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  minPasswordLen: number;
}

/** What the API tab sends; `{{variables}}` are still in it, and are filled in by the backend. */
export interface HttpPayload {
  id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: { kind: "none" } | { kind: "json" | "text"; text: string } | { kind: "form"; pairs: [string, string][] };
  auth:
    | { kind: "none" }
    | { kind: "bearer"; token: string }
    | { kind: "basic"; user: string; pass: string }
    | { kind: "header"; name: string; value: string }
    | { kind: "oauth2"; tokenUrl: string; clientId: string; clientSecret: string; scope: string };
  insecure: boolean;
  followRedirects: boolean;
  timeoutSecs: number;
  envId: string;
  vars: Record<string, string>;
  /** Local SOCKS5 port of an SSH session to send through. */
  proxyPort?: number;
}

export interface HttpResult {
  status: number;
  reason: string;
  version: string;
  headers: [string, string][];
  body: string;
  binary: boolean;
  size: number;
  truncated: boolean;
  headMillis: number;
  millis: number;
  url: string;
}

/** Profiles saved before API connections or saved commands existed have no settings for them: give every profile well-formed ones. */
const withDefaults = (p: Profile): Profile => ({ ...p, api: sanitizeApiSettings(p.api), commands: sanitizeCommands(p.commands) });

export const api = {
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (password: string) => invoke<void>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultTouch: () => invoke<void>("vault_touch"),
  vaultChangePassword: (old: string, nw: string) => invoke<void>("vault_change_password", { old, new: nw }),
  listProfiles: async () => (await invoke<Profile[]>("list_profiles")).map(withDefaults),
  saveProfile: async (profile: Profile) => withDefaults(await invoke<Profile>("save_profile", { profile })),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  getSettings: () => invoke<Settings>("get_settings"),
  setGpu: (enabled: boolean) => invoke<void>("set_gpu", { enabled }),
  setUi: (ui: UiColours) => invoke<void>("set_ui", { ui }),
  setPrefs: (restoreTabs: boolean, sftpLocalDir: string, uiScale: string, vaultIdleMinutes: number) =>
    invoke<void>("set_prefs", { restoreTabs, sftpLocalDir, uiScale, vaultIdleMinutes }),
  listLocalShells: () => invoke<LocalShell[]>("list_local_shells"),
  /** The local terminals the settings turn on, as profiles (never saved; empty when they are off). */
  listLocalTerminals: async () => (await invoke<Profile[]>("list_local_terminals")).map(withDefaults),
  /** Remembers the look of one local terminal (`id` is its profile id, `local:<shell>`). */
  setLocalLook: (id: string, look: Profile["appearance"]) => invoke<void>("set_local_look", { id, look }),
  setLocalTerminals: (enabled: boolean, shells: string[]) => invoke<void>("set_local_terminals", { enabled, shells }),
  setQuake: (enabled: boolean) => invoke<void>("set_quake", { enabled }),
  setQuakeKey: (key: string) => invoke<void>("set_quake_key", { key }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  loadWorkspaces: () => invoke<unknown>("load_workspaces"),
  saveWorkspaces: (data: unknown) => invoke<void>("save_workspaces", { data }),
  listThemes: () => invoke<Theme[]>("list_themes"),
  saveTheme: (theme: Theme) => invoke<Theme>("save_theme", { theme }),
  deleteTheme: (id: string) => invoke<void>("delete_theme", { id }),
  /** Registers a host typed into quick connect; the result has an id but is never saved to disk. */
  quickProfile: async (profile: Profile) => withDefaults(await guarded(() => invoke<Profile>("quick_profile", { profile }))),
  setPassword: (profileId: string, password: string) =>
    guarded(() => invoke<void>("set_password", { profileId, password })),
  copyPassword: (fromId: string, toId: string) => guarded(() => invoke<void>("copy_password", { fromId, toId })),
  hasPassword: (profileId: string) => guarded(() => invoke<boolean>("has_password", { profileId })),
  listKeys: () => invoke<KeyInfo[]>("list_keys"),
  importKey: (name: string, pem: string, passphrase?: string) =>
    guarded(() => invoke<KeyInfo>("import_key", { name, pem, passphrase: passphrase || null })),
  deleteKey: (id: string) => guarded(() => invoke<void>("delete_key", { id })),
  forgetHost: (host: string, port: number) => invoke<void>("forget_host", { host, port }),
  listSerialPorts: () => invoke<PortInfo[]>("list_serial_ports"),
  connect: (
    profileId: string,
    cols: number,
    rows: number,
    onEvent: Channel<ArrayBuffer>,
    password?: string,
    passphrase?: string,
  ) => invoke<string>("connect_session", { profileId, cols, rows, password, passphrase, onEvent }),
  connectSftp: (profileId: string, onEvent: Channel<ArrayBuffer>, password?: string, passphrase?: string) =>
    invoke<string>("connect_sftp", { profileId, password: password ?? null, passphrase: passphrase ?? null, onEvent }),
  sftpList: (id: string, path: string) => invoke<Listing>("sftp_list", { id, path }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpDelete: (id: string, path: string) => invoke<void>("sftp_delete", { id, path }),
  sftpTransfer: (id: string, upload: boolean, items: TransferItem[], overwrite: boolean) =>
    invoke<{ tid: string; name: string }[]>("sftp_transfer", { id, upload, items, overwrite }),
  sftpCancel: (id: string, tid: string) => invoke<void>("sftp_cancel", { id, tid }),
  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<Listing>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localRename: (from: string, to: string) => invoke<void>("local_rename", { from, to }),
  localDelete: (path: string) => invoke<void>("local_delete", { path }),
  loadApiData: () => invoke<unknown>("load_api_data"),
  saveApiData: (data: unknown) => invoke<void>("save_api_data", { data }),
  setApiSecret: (envId: string, name: string, value: string) => guarded(() => invoke<void>("set_api_secret", { envId, name, value })),
  hasApiSecret: (envId: string, name: string) => guarded(() => invoke<boolean>("has_api_secret", { envId, name })),
  httpSend: (req: HttpPayload) => guarded(() => invoke<HttpResult>("http_send", { req })),
  httpCancel: (id: string) => invoke<void>("http_cancel", { id }),
  connectProxy: (profileId: string, onEvent: Channel<ArrayBuffer>, password?: string, passphrase?: string) =>
    invoke<string>("connect_proxy", { profileId, password: password ?? null, passphrase: passphrase ?? null, onEvent }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  /** The system file chooser (the dialog plugin's own commands); null if cancelled. */
  chooseFileToOpen: (filters: { name: string; extensions: string[] }[]) =>
    invoke<string | null>("plugin:dialog|open", { options: { multiple: false, directory: false, filters } }),
  chooseFileToSave: (defaultPath: string, filters: { name: string; extensions: string[] }[]) =>
    invoke<string | null>("plugin:dialog|save", { options: { defaultPath, filters } }),
  confirmHost: (id: string, accept: boolean) => invoke<void>("confirm_host", { id, accept }),
  input: (id: string, data: Uint8Array) => invoke<void>("session_input", { id, data: Array.from(data) }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("session_resize", { id, cols, rows }),
  close: (id: string) => invoke<void>("session_close", { id }),
};

export { Channel };
