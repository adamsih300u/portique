import { api } from "./api";
import { type ApiData, blankRequest, type Environment, type HttpRequest, sanitizeData } from "./http-model";

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

  /** The environment requests currently run in. */
  get env(): Environment | undefined {
    return this.data.envs.find((e) => e.id === this.data.activeEnv);
  },

  async setActiveEnv(id: string) {
    this.data.activeEnv = id;
    await this.persist();
  },
};
