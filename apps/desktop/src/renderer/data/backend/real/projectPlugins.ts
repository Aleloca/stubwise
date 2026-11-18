import { ApiError } from "@stubwise/api-client";
import type { ProjectPluginsView } from "../../projectSettings/pluginDraft";
import type { ProjectPluginChoices } from "../../projectSettings/state";
import type { ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";

// Progetto → Settings → Plugins nella build app (area 9, F5) su
// `/api/projects/:id/plugins` (72, f5677875b e a19c56d09): le scelte del
// progetto, il registro (ogni plugin, in ogni stato, senza URL, sha né
// comandi degli hook) e la versione opaca per `ifMatch`.
// La regola (del server e, dalla decisione del maintainer in F5, anche del
// prototipo): un plugin entra nei run solo se è acceso sul progetto
// (`enabled`) e pronto; dentro, per sottrazione (skill e gruppi di hook
// spenti). Il salvataggio accende i plugin che `enabled` nomina e spegne gli
// altri pronti; senza `enabled` ogni riga tiene il suo. Un non pronto resta
// com'era (la pagina non lo sceglie, [PG 4]). Il PUT sostituisce l'insieme
// intero: nessuna riga si perde. Il plugin base sta fuori dal registro e qui
// non c'è.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

interface ServerChoice {
  pluginId: string;
  enabled: boolean;
  disabledSkills: string[];
  disabledHooks: string[];
}

/** Le rotte (sul client vero: `client.projects`). */
export interface ProjectPluginsApi {
  get(projectId: string): Promise<Any>;
  put(projectId: string, plugins: ServerChoice[], ifMatch?: string | null): Promise<Any>;
}

const STATUSES = new Set(["ready", "materializing", "failed"]);
/** `none` (mai materializzato) e un valore ignoto: non pronto. */
const statusOf = (s: string): "ready" | "materializing" | "failed" =>
  STATUSES.has(s)
    ? (s as "ready" | "materializing" | "failed")
    : s === "none"
      ? "materializing"
      : "failed";

const invalid = (reason: string) => ({ ok: false, error: "invalid", reason }) as const;

export function createRealProjectPlugins(api: ProjectPluginsApi) {
  async function read(projectId: string): Promise<Any | null> {
    try {
      return await api.get(projectId);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  return {
    async getProjectPlugins(projectId: string): Promise<ProjectPluginsView | null> {
      const v = await read(projectId);
      if (!v) return null;
      const choices = new Map<string, ServerChoice>(
        (v.plugins as ServerChoice[]).map((c) => [c.pluginId, c]),
      );
      return {
        version: v.version ?? "",
        // Il server la legge solo a chi gestisce le impostazioni del progetto.
        canEdit: true,
        plugins: (v.registry as Any[]).map((r) => {
          const c = choices.get(r.pluginId);
          const offSkills = c?.disabledSkills ?? [];
          const offHooks = c?.disabledHooks ?? [];
          const status = statusOf(r.status);
          return {
            name: r.name,
            slug: r.slug,
            status,
            base: false,
            on: !!c?.enabled,
            inRuns: status === "ready" && !!c?.enabled,
            skills: [
              ...r.skills.map((name: string) => ({
                name,
                description: "",
                enabled: !offSkills.includes(name),
              })),
              ...offSkills
                .filter((name) => !r.skills.includes(name))
                .map((name) => ({ name, description: "", enabled: false })),
            ],
            hooks: [
              ...r.hookGroups.map((key: string) => ({
                key,
                event: key.split("#")[0]!,
                command: "",
                enabled: !offHooks.includes(key),
              })),
              ...offHooks
                .filter((key) => !r.hookGroups.includes(key))
                .map((key) => ({ key, event: key.split("#")[0]!, command: "", enabled: false })),
            ],
            preset: r.recommendedDisabledSkills?.length ? [...r.recommendedDisabledSkills] : null,
          };
        }),
      };
    },

    async saveProjectPlugins(
      projectId: string,
      input: { version: string; enabled?: string[]; disabled: ProjectPluginChoices["disabled"] },
    ): Promise<ProjectResult<{ version: string }>> {
      const v = await read(projectId);
      if (!v) return { ok: false, error: "not_found" };
      const registry = new Map<string, Any>((v.registry as Any[]).map((r) => [r.name, r]));
      const current = new Map<string, ServerChoice>(
        (v.plugins as ServerChoice[]).map((c) => [c.pluginId, c]),
      );
      const wanted = input.enabled;
      if (wanted?.some((name) => !registry.has(name))) return invalid("plugin");
      const nameOf = new Map<string, string>(
        [...registry.values()].map((r) => [r.pluginId, r.name]),
      );
      /** Acceso dopo il salvataggio: quello che `enabled` dice, o com'era. */
      const onAfter = (id: string, was: boolean) =>
        wanted ? wanted.includes(nameOf.get(id) ?? "") : was;
      const named = new Map<string, ServerChoice>();
      for (const d of input.disabled) {
        const r = registry.get(d.plugin);
        if (!r || statusOf(r.status) !== "ready") return invalid("plugin");
        const before = current.get(r.pluginId);
        if (d.skills.some((s) => !r.skills.includes(s) && !before?.disabledSkills.includes(s)))
          return invalid("skill");
        if (
          d.hookGroups.some((h) => !r.hookGroups.includes(h) && !before?.disabledHooks.includes(h))
        )
          return invalid("hook");
        named.set(r.pluginId, {
          pluginId: r.pluginId,
          enabled: onAfter(r.pluginId, before?.enabled ?? false),
          disabledSkills: [...d.skills],
          disabledHooks: [...d.hookGroups],
        });
      }
      const ready = (id: string) =>
        [...registry.values()].some((r) => r.pluginId === id && statusOf(r.status) === "ready");
      const plugins: ServerChoice[] = [];
      for (const c of current.values()) {
        // Un pronto non nominato: dentro tutto acceso (come nel prototipo),
        // acceso o no come dice `enabled`. Un non pronto resta com'era.
        plugins.push(
          named.get(c.pluginId) ??
            (ready(c.pluginId)
              ? {
                  ...c,
                  enabled: onAfter(c.pluginId, c.enabled),
                  disabledSkills: [],
                  disabledHooks: [],
                }
              : c),
        );
        named.delete(c.pluginId);
      }
      // Un pronto mai salvato: si salva se qualcosa è spento, o (sotto) se si accende.
      for (const c of named.values())
        if (c.disabledSkills.length || c.disabledHooks.length) plugins.push(c);
      for (const name of wanted ?? []) {
        const r = registry.get(name)!;
        if (!plugins.some((c) => c.pluginId === r.pluginId))
          plugins.push({
            pluginId: r.pluginId,
            enabled: true,
            disabledSkills: [],
            disabledHooks: [],
          });
      }
      try {
        const r = await api.put(projectId, plugins, input.version);
        return { ok: true, version: r.version ?? "" };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409)
          return { ok: false, error: "conflict" };
        if (error instanceof ApiError && error.status === 404)
          return { ok: false, error: "not_found" };
        if (error instanceof ApiError && error.status === 403)
          return { ok: false, error: "forbidden" };
        throw error;
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ProjectPluginsApi = {
  get: (projectId) => appClient().projects.plugins(projectId),
  put: (projectId, plugins, ifMatch) =>
    appClient().projects.setPlugins(projectId, plugins, ifMatch),
};

/** SOLO TEST: le rotte vere. */
export const liveProjectPluginsApiForTest = liveApi;

export const liveProjectPlugins = createRealProjectPlugins(liveApi);
