import { ApiError } from "@stubwise/api-client";
import type { GitAccountView } from "../../instance/git";
import type { TestOutcome } from "../../instance/state";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → Git accounts nella build app (area 9, F3) su
// `/api/git-accounts` (72). Il server decide la riconferma (crea, sostituisce
// il token, elimina), l'ambito del revisore predefinito (`replaced` nella
// risposta) e il 409 `git_account_in_use`.
//
// Differenze dichiarate (parità): niente ultime 4 del token («••••»); la
// validazione non resta sul server (la ricorda la sessione); i repository
// che usano un account non arrivano (né nella riga né nel rifiuto `in_use`);
// chi verrebbe sostituito come revisore si sa solo dopo, dalla risposta.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.gitAccounts`). */
export interface GitAccountsApi {
  list(): Promise<Any[]>;
  create(input: {
    name: string;
    provider: "github" | "bitbucket";
    credentials: { token: string };
    workspace?: string;
  }): Promise<Any>;
  update(
    id: string,
    patch: { name?: string; workspace?: string; credentials?: { token: string } },
  ): Promise<Any>;
  validate(id: string): Promise<{ ok: boolean; checks: unknown[] }>;
  setDefaultReviewer(id: string): Promise<Any>;
  unsetDefaultReviewer(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (code === "git_account_in_use")
    return { ok: false, error: "in_use", usedBy: [], hiddenCount: 0 };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 409) return { ok: false, error: "conflict" };
  if (error.status === 400) {
    const field = /\b(workspace|token|name|provider)\b/.exec(error.message)?.[1] ?? "token";
    return { ok: false, error: "invalid", reason: field };
  }
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

export function createRealGitAccounts(api: GitAccountsApi) {
  /** L'ultima validazione di ogni account in questa sessione (il server non la tiene). */
  const validations = new Map<string, { at: string; outcome: TestOutcome }>();

  const viewOf = (a: Any): GitAccountView => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    workspace: a.workspace ?? null,
    // Rimandi, lotto 5, voce 6 (72): un token di prima ne è senza («••••»).
    last4: a.tokenLast4 ?? "",
    defaultReviewer: !!a.isDefaultReviewer,
    lastValidation: validations.get(a.id) ?? null,
    createdAt: a.createdAt,
    repositories: [],
    hiddenRepositories: 0,
    replacesAsReviewer: null,
  });

  async function write(call: () => Promise<unknown>): Promise<InstanceResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      return refusalOf(error);
    }
  }

  return {
    async listGitAccounts(): Promise<GitAccountView[]> {
      return (await api.list()).map(viewOf);
    },

    async createGitAccount(input: {
      name: string;
      provider: "github" | "bitbucket";
      workspace: string | null;
      token: string;
    }): Promise<InstanceResult<{ accountId: string }>> {
      try {
        const r = await api.create({
          name: input.name.trim(),
          provider: input.provider,
          credentials: { token: input.token.trim() },
          ...(input.provider === "bitbucket" && input.workspace
            ? { workspace: input.workspace.trim() }
            : {}),
        });
        return { ok: true, accountId: r.id as string };
      } catch (error) {
        return refusalOf(error);
      }
    },

    updateGitAccount: (id: string, input: { name?: string; workspace?: string | null }) =>
      write(() =>
        api.update(id, {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.workspace ? { workspace: input.workspace.trim() } : {}),
        }),
      ),

    replaceGitToken: (id: string, token: string) =>
      write(() => api.update(id, { credentials: { token: token.trim() } })),

    async validateGitAccount(id: string): Promise<InstanceResult<{ outcome: TestOutcome }>> {
      try {
        const r = await api.validate(id);
        const outcome: TestOutcome = r.ok ? "ok" : "invalid_credentials";
        validations.set(id, { at: new Date().toISOString(), outcome });
        return { ok: true, outcome };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async setDefaultReviewer(
      id: string,
      on: boolean,
    ): Promise<InstanceResult<{ replaced: string | null }>> {
      try {
        if (!on) {
          await api.unsetDefaultReviewer(id);
          return { ok: true, replaced: null };
        }
        const r = await api.setDefaultReviewer(id);
        return { ok: true, replaced: (r.replaced?.name as string | undefined) ?? null };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async deleteGitAccount(id: string): Promise<InstanceResult> {
      const r = await write(() => api.remove(id));
      if (r.ok) validations.delete(id);
      return r;
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: GitAccountsApi = {
  list: () => appClient().gitAccounts.list() as Promise<Any[]>,
  create: (input) => appClient().gitAccounts.create(input as Any),
  update: (id, patch) => appClient().gitAccounts.update(id, patch as Any),
  validate: (id) => appClient().gitAccounts.validate(id) as Promise<Any>,
  setDefaultReviewer: (id) => appClient().gitAccounts.setDefaultReviewer(id),
  unsetDefaultReviewer: (id) => appClient().gitAccounts.unsetDefaultReviewer(id),
  remove: (id) => appClient().gitAccounts.remove(id),
};

/** SOLO TEST: le rotte vere. */
export const liveGitAccountsApiForTest = liveApi;

export const liveGitAccounts = createRealGitAccounts(liveApi);
