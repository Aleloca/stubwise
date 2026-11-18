import { ApiError } from "@stubwise/api-client";
import type { PluginView } from "../../instance/plugins";
import type { RegisteredPlugin } from "../../instance/state";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → Plugins nella build app (area 9, F3) su `/api/plugins`
// (72). Registrare e aggiornare un ref mandano «Mi fido» (`trust: true`,
// obbligatorio sul server: 422 `trust_required`) e chiedono la riconferma;
// la preparazione e lo smoke li fa il worker, e la pagina rilegge finché un
// passo è in corso (`busy`, dal job in coda: `pendingJobKind`).
//
// Differenze dichiarate (parità): il server non dice chi ha registrato o
// aggiornato un plugin («updated … by» senza nome); comandi, agenti e MCP
// dell'inventario non entrano nella forma del prototipo.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.plugins`). */
export interface PluginsApi {
  list(): Promise<{ plugins: Any[]; recommendations: Any }>;
  get(id: string): Promise<Any>;
  register(input: {
    sourceUrl: string;
    ref: string;
    sourceSubdir?: string;
    trust: true;
  }): Promise<Any>;
  updateRef(id: string, ref: string, trust: true): Promise<Any>;
  rerunSmoke(id: string): Promise<Any>;
  remove(id: string): Promise<void>;
}

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (code === "trust_required") return { ok: false, error: "invalid", reason: "not_trusted" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    const field = /\b(sourceUrl|ref|sourceSubdir)\b/.exec(error.message)?.[1];
    const reason = field === "sourceUrl" ? "url" : field === "sourceSubdir" ? "subdir" : "ref";
    return { ok: false, error: "invalid", reason };
  }
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

const statusOf = (s: string): RegisteredPlugin["status"] =>
  s === "ready" ? "ready" : s === "failed" ? "failed" : "materializing";
const smokeOf = (s: string): RegisteredPlugin["smoke"] =>
  s === "pending" ? "running" : s === "passed" ? "passed" : s === "failed" ? "failed" : null;

function viewOf(p: Any): PluginView {
  const status = statusOf(p.status);
  const smoke = smokeOf(p.smokeStatus);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    url: p.sourceUrl,
    ref: p.ref,
    sha: p.resolvedSha ?? null,
    subdir: p.sourceSubdir ?? null,
    status,
    smoke,
    error: p.error ?? p.smokeError ?? null,
    inventory: p.inventory
      ? {
          skills: (p.inventory.skills ?? []).map((s: Any) => ({
            name: s.name,
            description: s.description ?? "",
          })),
          hooks: (p.inventory.hooks ?? []).map((h: Any) => ({
            key: h.key,
            event: h.event,
            command: h.command,
          })),
        }
      : null,
    registeredById: "",
    updatedById: "",
    updatedAt: p.updatedAt,
    registeredByName: null,
    updatedByName: null,
    busy: p.pendingJobKind !== null || status === "materializing" || smoke === "running",
  };
}

export function createRealPlugins(api: PluginsApi) {
  async function write(call: () => Promise<unknown>): Promise<InstanceResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      return refusalOf(error);
    }
  }

  return {
    async listPlugins(): Promise<PluginView[]> {
      return (await api.list()).plugins.map(viewOf);
    },

    async getPlugin(id: string): Promise<PluginView> {
      try {
        return viewOf(await api.get(id));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) throw new Error("not_found");
        throw error;
      }
    },

    async registerPlugin(input: {
      url: string;
      ref: string;
      subdir: string | null;
      trusted: true;
    }): Promise<InstanceResult<{ pluginId: string; name: string }>> {
      try {
        const r = await api.register({
          sourceUrl: input.url.trim(),
          ref: input.ref.trim(),
          ...(input.subdir ? { sourceSubdir: input.subdir.trim() } : {}),
          trust: true,
        });
        return { ok: true, pluginId: r.id as string, name: r.name as string };
      } catch (error) {
        return refusalOf(error);
      }
    },

    updatePluginRef: (id: string, input: { ref: string; trusted: true }) =>
      write(() => api.updateRef(id, input.ref.trim(), true)),

    rerunSmoke: (id: string) => write(() => api.rerunSmoke(id)),

    removePlugin: (id: string) => write(() => api.remove(id)),
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: PluginsApi = {
  list: () => appClient().plugins.list() as Promise<Any>,
  get: (id) => appClient().plugins.get(id),
  register: (input) => appClient().plugins.register(input as Any),
  updateRef: (id, ref, trust) => appClient().plugins.updateRef(id, ref, trust),
  rerunSmoke: (id) => appClient().plugins.rerunSmoke(id),
  remove: (id) => appClient().plugins.remove(id),
};

/** SOLO TEST: le rotte vere. */
export const livePluginsApiForTest = liveApi;

export const livePlugins = createRealPlugins(liveApi);
