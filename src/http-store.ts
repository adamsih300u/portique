import { api } from "./api";
import type { Imported } from "./http-import";
import { ApiData, blankRequest, Environment, HttpRequest, sanitizeData } from "./http-model";

/** Saved requests and environments, shared by every API tab and the sidebar. */
export const httpStore = {
  data: { requests: [], envs: [], activeEnv: "" } as ApiData,
  listeners: new Set<() => void>(),

  async load() {
    this.data = sanitizeData(await api.loadApiData().catch(() => null));
    this.changed();
  },

  changed() {
    for (const f of this.listeners) f();
  },

  async persist() {
    await api.saveApiData(this.data);
    this.changed();
  },

  request(id: string): HttpRequest | undefined {
    return this.data.requests.find((r) => r.id === id);
  },

  /** Saves a copy of `r` (new or updating the one with the same id). */
  async saveRequest(r: HttpRequest) {
    const copy = structuredClone(r);
    const i = this.data.requests.findIndex((x) => x.id === r.id);
    if (i < 0) this.data.requests.push(copy);
    else this.data.requests[i] = copy;
    await this.persist();
  },

  async deleteRequest(id: string) {
    this.data.requests = this.data.requests.filter((r) => r.id !== id);
    await this.persist();
  },

  async duplicateRequest(id: string): Promise<HttpRequest | null> {
    const src = this.request(id);
    if (!src) return null;
    const copy = { ...structuredClone(src), id: blankRequest().id, name: `${src.name} copy` };
    await this.saveRequest(copy);
    return copy;
  },

  /** Adds imported requests, and merges imported environments into existing ones of the same name (never overwriting a value). */
  async importData(imp: Imported) {
    this.data.requests.push(...imp.requests);
    for (const e of imp.envs) {
      const have = this.data.envs.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
      if (!have) { this.data.envs.push(e); continue; }
      for (const v of e.vars) if (!have.vars.some((x) => x.key === v.key)) have.vars.push(v);
    }
    await this.persist();
  },

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
  },

  /** The environment requests currently run in. */
  get env(): Environment | undefined {
    return this.data.envs.find((e) => e.id === this.data.activeEnv);
  },

  async setActiveEnv(id: string) {
    this.data.activeEnv = id;
    await this.persist();
  },
};
