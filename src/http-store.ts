import { api, newProfile } from "./api";
import type { Imported } from "./http-import";
import { ApiFile, blankRequest, ConnData, defaultApiSettings, Environment, HttpRequest, sanitizeFile } from "./http-model";

/** The saved requests and environments of ONE API connection (a profile of type "api"). */
export class ConnStore {
  readonly listeners = new Set<() => void>();

  constructor(readonly id: string) {}

  get data(): ConnData {
    return (httpStore.file.connections[this.id] ??= { requests: [], envs: [], activeEnv: "" });
  }

  changed() {
    for (const f of this.listeners) f();
  }

  async persist() {
    await httpStore.persist();
    this.changed();
  }

  request(id: string): HttpRequest | undefined {
    return this.data.requests.find((r) => r.id === id);
  }

  /** Saves a copy of `r` (new, or replacing the one with the same id). */
  async saveRequest(r: HttpRequest) {
    const copy = structuredClone(r);
    const i = this.data.requests.findIndex((x) => x.id === r.id);
    if (i < 0) this.data.requests.push(copy);
    else this.data.requests[i] = copy;
    await this.persist();
  }

  async deleteRequest(id: string) {
    this.data.requests = this.data.requests.filter((r) => r.id !== id);
    await this.persist();
  }

  async duplicateRequest(id: string): Promise<HttpRequest | null> {
    const src = this.request(id);
    if (!src) return null;
    const copy = { ...structuredClone(src), id: blankRequest().id, name: `${src.name} copy` };
    await this.saveRequest(copy);
    return copy;
  }

  /** Adds imported requests, and merges imported environments into existing ones of the same name (never overwriting a value). */
  async importData(imp: Imported) {
    this.data.requests.push(...imp.requests);
    for (const e of imp.envs) {
      const have = this.data.envs.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
      if (!have) { this.data.envs.push(e); continue; }
      for (const v of e.vars) if (!have.vars.some((x) => x.key === v.key)) have.vars.push(v);
    }
    await this.persist();
  }

  /**
   * Keeps values taken from a response as variables of the active environment. Secrets go to the vault
   * (and the environment only remembers that the variable exists). Returns false if no environment is active.
   */
  async capture(values: { name: string; value: string; secret: boolean }[]): Promise<boolean> {
    const env = this.env;
    if (!env) return false;
    for (const c of values) {
      let v = env.vars.find((x) => x.key === c.name);
      if (!v) env.vars.push((v = { key: c.name, value: "", secret: c.secret }));
      v.secret = c.secret;
      if (c.secret) { await api.setApiSecret(env.id, c.name, c.value); v.value = ""; }
      else v.value = c.value;
    }
    await this.persist();
    return true;
  }

  /** The environment requests currently run in. */
  get env(): Environment | undefined {
    return this.data.envs.find((e) => e.id === this.data.activeEnv);
  }

  async setActiveEnv(id: string) {
    this.data.activeEnv = id;
    await this.persist();
  }
}

/** All API connections' saved data, in one file (`api.json`). */
export const httpStore = {
  file: { version: 2, connections: {} } as ApiFile,
  stores: new Map<string, ConnStore>(),

  /**
   * Reads the file. Returns true if requests saved before connections existed were moved into a new
   * connection called "Saved requests" (so the caller should reload the profile list).
   */
  async load(): Promise<boolean> {
    const { file, legacy } = sanitizeFile(await api.loadApiData().catch(() => null));
    this.file = file;
    if (!legacy) return false;
    const p = await api.saveProfile({ ...newProfile(), protocol: "api", name: "Saved requests", api: defaultApiSettings() });
    file.connections[p.id] = legacy;
    await this.persist();
    return true;
  },

  forConn(id: string): ConnStore {
    let s = this.stores.get(id);
    if (!s) this.stores.set(id, (s = new ConnStore(id)));
    return s;
  },

  async persist() {
    await api.saveApiData(this.file);
  },

  /** Every saved request of every connection, with the connection it belongs to. */
  all(): { conn: string; request: HttpRequest }[] {
    return Object.entries(this.file.connections).flatMap(([conn, d]) => d.requests.map((request) => ({ conn, request })));
  },

  /** Forgets a deleted connection's requests and environments, and removes its secrets from the vault. */
  async deleteConnection(id: string) {
    const d = this.file.connections[id];
    if (!d) return;
    for (const e of d.envs) for (const v of e.vars) if (v.secret) await api.setApiSecret(e.id, v.key, "").catch(() => {});
    delete this.file.connections[id];
    this.stores.delete(id);
    await this.persist();
  },
};
