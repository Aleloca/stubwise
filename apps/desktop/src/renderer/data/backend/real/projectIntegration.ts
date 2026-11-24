import { ApiError } from "@stubwise/api-client";
import type { IntegrationView } from "../../projectSettings/integration";
import { dsnWithKey, guideText, maskKey, snippetOf } from "../../projectSettings/integrationText";
import type { ProjectRefusal, ProjectResult } from "../../projectSettings/types";
import { appClient } from "./client";
import { webhookSecretOutcome, webhookSecretRefusal } from "./webhookSecret";

// Progetto → Settings → Integration nella build app (area 9, F5) su
// `GET /api/projects/:id/integration` (72, a19c56d09): la chiave con le sole
// ultime 4, la base del DSN senza chiave, l'indirizzo in entrata, i webhook
// git (a chi vede i repository) e chi può rigenerare, calcolati dal server.
// DSN, snippet e guida li compone il client con la chiave mascherata
// (`integrationText.ts`, gli stessi del prototipo); la chiave intera esce
// solo dalla rigenerazione, una volta. Il segreto del webhook si rigenera
// per id del repository (rimandi, lotto 5, voce 6: la rotta accetta anche
// l'id), senza dover ricordare lo slug della lettura.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.projects`, `client.repositories`). */
export interface IntegrationApi {
  integration(projectId: string): Promise<Any>;
  project(projectId: string): Promise<{ name: string; code?: string | null }>;
  regenerateIngestionKey(projectId: string): Promise<{ ingestionKey: string }>;
  /** `POST /api/repositories/:slugOrId/webhook-secret`: qui sempre con l'id. */
  regenerateWebhookSecret(
    repositoryId: string,
  ): Promise<{ mode: string; webhookSecret?: string; platformRestored?: boolean }>;
}

const invisible = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

function keyRefusal(error: unknown): ProjectRefusal {
  if (!(error instanceof ApiError)) throw error;
  if (error.code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  throw error;
}

export function createRealIntegration(api: IntegrationApi) {
  /** La lettura del server, `null` su un progetto che non si vede. */
  async function read(projectId: string): Promise<Any | null> {
    try {
      return await api.integration(projectId);
    } catch (error) {
      if (invisible(error)) return null;
      throw error;
    }
  }

  return {
    async getIntegration(projectId: string): Promise<IntegrationView | null> {
      const v = await read(projectId);
      if (!v) return null;
      const project = await api.project(projectId);
      const masked = maskKey(v.ingestion.last4);
      const maskedDsn = dsnWithKey(v.ingestion.dsnBase, masked);
      return {
        ingestion: {
          last4: v.ingestion.last4,
          createdAt: v.ingestion.createdAt ?? null,
          createdBy: v.ingestion.createdBy ?? null,
          maskedDsn,
          maskedSnippet: snippetOf(maskedDsn),
        },
        inbound: { url: v.inbound.url, auth: `Bearer ${masked}` },
        gitWebhooks: (v.gitWebhooks ?? []).map((w: Any) => ({
          repositoryId: w.repositoryId,
          name: w.name,
          url: w.url,
          secretLast4: w.secretLast4 ?? null,
          canRegenerate: !!v.canRegenerateWebhookSecret,
          state: w.configured ? "configured" : "not_configured",
          // Rimandi, lotto 5, voce 6 (72): la piattaforma, per nominarla nel
          // dialogo; una che il client non conosce (o un server di prima): nessuna.
          provider: w.provider === "github" || w.provider === "bitbucket" ? w.provider : null,
        })),
        canRegenerateKey: !!v.canRegenerateKey,
        guide: guideText({ name: project.name, code: project.code ?? "" }, maskedDsn, masked),
      };
    },

    async regenerateIngestionKey(
      projectId: string,
    ): Promise<ProjectResult<{ key: string; dsn: string; snippet: string }>> {
      let key: string;
      try {
        key = (await api.regenerateIngestionKey(projectId)).ingestionKey;
      } catch (error) {
        return keyRefusal(error);
      }
      // La chiave è già cambiata: una rilettura che fallisce non la perde
      // (review F5, M5), il DSN resta vuoto.
      const v = await read(projectId).catch(() => null);
      const dsn = v ? dsnWithKey(v.ingestion.dsnBase, key) : "";
      return { ok: true, key, dsn, snippet: snippetOf(dsn) };
    },

    async regenerateWebhookSecret(
      repositoryId: string,
    ): Promise<ProjectResult<{ secret: string; mode: "manual" | "platform" }>> {
      try {
        return webhookSecretOutcome(await api.regenerateWebhookSecret(repositoryId));
      } catch (error) {
        return webhookSecretRefusal(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: IntegrationApi = {
  integration: (projectId) => appClient().projects.integration(projectId),
  project: (projectId) => appClient().projects.get(projectId) as Promise<Any>,
  regenerateIngestionKey: (projectId) => appClient().projects.regenerateIngestionKey(projectId),
  regenerateWebhookSecret: (repositoryId) =>
    appClient().repositories.regenerateWebhookSecret(repositoryId),
};

/** SOLO TEST: le rotte vere. */
export const liveIntegrationApiForTest = liveApi;

export const liveIntegration = createRealIntegration(liveApi);
