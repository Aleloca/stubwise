import { ApiError } from "@stubwise/api-client";
import type { UpdateProjectInput } from "@stubwise/shared";
import { DESCRIPTION_MAX, NAME_MAX } from "../../projectSettings/limits";
import type { ProjectSettingsView } from "../../projectSettings/reads";
import type { ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";

// Progetto → Settings → General e AI nella build app (ritiro del web vecchio,
// inventario 1.3), sulla stessa `PATCH /api/projects/:id` che usa il web:
// nome e descrizione, il modulo Docs (l'insieme intero dei moduli), l'account
// AI preferito e «Use only this account». I permessi li decide il server
// (`project.settings.manage`): qui solo le forme e i rifiuti del prototipo.
// Le scelte degli account le legge solo chi ha `ai_providers.manage`, come
// il web (`project-form.tsx`): agli altri resta il nome dell'account scelto.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.projects` e `client.aiProviders`). */
export interface ProjectGeneralApi {
  get(projectId: string): Promise<Any>;
  patch(projectId: string, body: UpdateProjectInput): Promise<Any>;
  providers(): Promise<Any[]>;
}

function refusalOf(error: unknown): ProjectResult {
  if (error instanceof ApiError && error.status === 404) return { ok: false, error: "not_found" };
  if (error instanceof ApiError && error.status === 403) {
    if (error.code === "reauth_required") return { ok: false, error: "reauth_required" } as ProjectResult;
    return { ok: false, error: "forbidden" };
  }
  if (error instanceof ApiError && error.status === 400)
    return { ok: false, error: "invalid", reason: error.code || "input" } as ProjectResult;
  throw error;
}

/** Gli account per la scelta e la catena di «Automatic» (gli abbonamenti accesi, se no le chiavi API). */
export function aiChoicesOf(providers: Any[]): Pick<ProjectSettingsView["ai"], "choices" | "automaticChain"> {
  const sorted = [...providers].sort((a, b) => a.position - b.position);
  const choices = sorted.map((p) => ({
    id: p.id as string,
    name: p.label as string,
    kind: (p.kind === "account" ? "subscription" : "api_key") as "subscription" | "api_key",
    enabled: p.enabled === true,
    limited: p.limitedUntil != null,
  }));
  const subs = choices.filter((c) => c.enabled && c.kind === "subscription");
  const chain = subs.length > 0 ? subs : choices.filter((c) => c.enabled && c.kind === "api_key");
  return { choices, automaticChain: chain.map((c) => c.name) };
}

export function createRealProjectGeneral(api: ProjectGeneralApi) {
  async function patch(projectId: string, body: UpdateProjectInput): Promise<ProjectResult> {
    try {
      await api.patch(projectId, body);
      return { ok: true };
    } catch (error) {
      return refusalOf(error);
    }
  }

  return {
    async updateProjectGeneral(
      projectId: string,
      input: { name?: string; description?: string },
    ): Promise<ProjectResult> {
      const body: UpdateProjectInput = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > NAME_MAX) return { ok: false, error: "invalid", reason: "name" } as ProjectResult;
        body.name = name;
      }
      if (input.description !== undefined) {
        const description = input.description.trim();
        if (description.length > DESCRIPTION_MAX)
          return { ok: false, error: "invalid", reason: "description" } as ProjectResult;
        // Il server vuole una descrizione non vuota o null: vuota = togliere.
        body.description = description === "" ? null : description;
      }
      return Object.keys(body).length === 0 ? { ok: true } : patch(projectId, body);
    },

    async setDocsModule(projectId: string, on: boolean): Promise<ProjectResult> {
      let p: Any;
      try {
        p = await api.get(projectId);
      } catch (error) {
        return refusalOf(error);
      }
      const modules: string[] = Array.isArray(p.modules) ? p.modules : [];
      if (modules.includes("docs") === on) return { ok: true };
      // `modules` è l'insieme intero (fetta 4): si manda con «docs» acceso o spento.
      const next = on ? [...modules, "docs"] : modules.filter((m) => m !== "docs");
      return patch(projectId, { modules: next as UpdateProjectInput["modules"] });
    },

    setProjectAi(projectId: string, input: { providerId: string | null; exclusive: boolean }): Promise<ProjectResult> {
      // «Use only this account» non vale senza un account scelto.
      return patch(projectId, {
        aiProviderId: input.providerId,
        aiProviderExclusive: input.providerId === null ? false : input.exclusive,
      });
    },
  };
}

export const liveProjectGeneral = createRealProjectGeneral({
  get: (projectId) => appClient().projects.get(projectId),
  patch: (projectId, body) => appClient().projects.patch(projectId, body),
  providers: () => appClient().aiProviders.list() as Promise<Any[]>,
});

/** Le scelte degli account per chi le può leggere (`ai_providers.manage`); vuote per gli altri. */
export async function liveAiChoices(canList: boolean): Promise<Pick<ProjectSettingsView["ai"], "choices" | "automaticChain">> {
  if (!canList) return { choices: [], automaticChain: [] };
  try {
    return aiChoicesOf((await appClient().aiProviders.list()) as Any[]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return { choices: [], automaticChain: [] };
    throw error;
  }
}
