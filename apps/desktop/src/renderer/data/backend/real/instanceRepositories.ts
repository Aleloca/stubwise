import { ApiError } from "@stubwise/api-client";
import type { DetachedRepositoryRow, InstanceRepositoryGroup } from "../../instance/repositories";
import type { ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";

// Amministrazione → Repositories nella build app (area 9, F6, Task 6 di 72,
// 1d3d3a5c5). I collegati non hanno una rotta loro: `repositories.list()`
// senza progetto risponde per i progetti dove chi guarda ha `repos.view` o
// `docs.view`, ma la configurazione (`config: true`, il nome dell'account
// git) c'è solo con `repos.view`: quelle sono le righe della pagina. Codice e
// nome del progetto da `projects.list()`. La lista esclude già staccati e
// archiviati. Gli staccati, il collegamento e l'eliminazione hanno le rotte
// di F6, con `linkTargets`, `canDelete` e `formerProject` calcolati dal server.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.repositories` e `client.projects`). */
export interface InstanceRepositoriesApi {
  repositories(): Promise<Any[]>;
  projects(): Promise<Any[]>;
  detached(): Promise<Any[]>;
  link(repositoryId: string, projectId: string): Promise<void>;
  deleteDetached(repositoryId: string): Promise<void>;
}

/** `owner/nome` dall'URL, con la regola del server (senza host né `.git`); `null` se non si ricava. */
export function fullNameOf(repoUrl: string): string | null {
  const path = repoUrl
    .replace(/^[a-z]+:\/\/[^/]+\//i, "")
    .replace(/^git@[^:]+:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return path.length > 0 ? path : null;
}

/**
 * I rifiuti delle due scritture. `not_detached`: un altro l'ha appena
 * collegato o eliminato; come nel prototipo, lo staccato non c'è più.
 */
function refusalOf(error: unknown): ProjectResult {
  if (!(error instanceof ApiError)) throw error;
  if (error.code === "name_taken") return { ok: false, error: "invalid", reason: "name_taken" };
  // La destinazione sparita (Task 7 di 72): il dialogo resta aperto, non è lo staccato che manca.
  if (error.code === "target_not_found")
    return { ok: false, error: "invalid", reason: "target_not_found" };
  if (error.code === "not_detached" || error.status === 404)
    return { ok: false, error: "not_found" };
  if (error.code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  throw error;
}

export function createRealInstanceRepositories(api: InstanceRepositoriesApi) {
  return {
    async listAllRepositories(): Promise<InstanceRepositoryGroup[]> {
      const [rows, projects] = await Promise.all([api.repositories(), api.projects()]);
      const byId = new Map<string, Any>(projects.map((p) => [p.id, p]));
      const groups = new Map<string, InstanceRepositoryGroup>();
      for (const r of rows) {
        // Solo dove chi guarda ha `repos.view` (la configurazione c'è).
        if (r.config !== true) continue;
        const p = byId.get(r.projectId);
        if (!p) continue;
        let g = groups.get(p.id);
        if (!g) {
          // Il codice come altrove (`projects.ts`): dallo slug se il server non lo dà.
          const code: string = p.code ?? String(p.slug).toUpperCase();
          g = { projectId: p.id, projectCode: code, projectName: p.name, repositories: [] };
          groups.set(p.id, g);
        }
        g.repositories.push({
          id: r.id,
          name: r.name,
          fullName: fullNameOf(r.repoUrl),
          gitAccountName: r.gitAccountName ?? null,
          href: `#/p/${g.projectCode}/settings/repositories`,
        });
      }
      return [...groups.values()]
        .map((g) => ({
          ...g,
          repositories: g.repositories.sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
    },

    /** Gli staccati come li calcola il server; un 403 si propaga, come nel prototipo. */
    async listDetachedRepositories(): Promise<DetachedRepositoryRow[]> {
      return (await api.detached()).map((d) => ({
        id: d.id,
        name: d.name,
        fullName: d.fullName ?? null,
        gitAccountName: d.gitAccountName ?? null,
        gitAccountProvider: d.gitAccountProvider ?? null,
        detachedAt: d.detachedAt ?? null,
        formerProject: d.formerProject ?? null,
        linkTargets: d.linkTargets ?? [],
        canDelete: d.canDelete === true,
      }));
    },

    async linkRepository(repositoryId: string, projectId: string): Promise<ProjectResult> {
      try {
        await api.link(repositoryId, projectId);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async deleteDetachedRepository(repositoryId: string): Promise<ProjectResult> {
      try {
        await api.deleteDetached(repositoryId);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: InstanceRepositoriesApi = {
  repositories: () => appClient().repositories.list() as Promise<Any[]>,
  projects: () => appClient().projects.list() as Promise<Any[]>,
  detached: () => appClient().repositories.detached() as Promise<Any[]>,
  link: (repositoryId, projectId) => appClient().repositories.link(repositoryId, projectId),
  deleteDetached: (repositoryId) => appClient().repositories.deleteDetached(repositoryId),
};

export const liveInstanceRepositories = createRealInstanceRepositories(liveApi);
