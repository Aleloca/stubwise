import { ApiError } from "@stubwise/api-client";
import type { TestOutcome } from "../../instance/state";
import type { InstanceResult } from "../../instance/types";
import type {
  WebhookEventId,
  WebhookFormat,
  WebhookInput,
  WebhookView,
} from "../../instance/webhook";
import { appClient } from "./client";

// Amministrazione → Outgoing webhooks nella build app (area 9, F3) sulle rotte
// di 72 (`/api/settings/webhooks`, `client.webhooks`). Il server decide chi
// gestisce (`integrations.manage`), la riconferma (crea, rigenera,
// elimina), il limite (20) e il catalogo degli eventi. Il segreto esce solo
// da `create` e `rotateSecret`, una volta: qui passa al risultato e basta.
//
// Differenza dichiarata: il server non ricorda l'ultima prova (`test` dice
// solo com'è andata). L'esito resta in memoria per la sessione, per la riga
// «Sent · delivered · data»; ricaricando l'app torna «not tested yet».

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.webhooks`). */
export interface WebhooksApi {
  list(): Promise<Any[]>;
  create(input: {
    name: string;
    url: string;
    format: WebhookFormat;
    enabled: boolean;
    events: string[];
  }): Promise<Any>;
  update(id: string, patch: Partial<WebhookInput>): Promise<Any>;
  rotateSecret(id: string): Promise<Any>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<{ ok: boolean; status: number | null; error: string | null }>;
  preview(format: WebhookFormat, event: WebhookEventId): Promise<{ body: unknown }>;
}

/** Il rifiuto del server nelle parole della pagina del prototipo. */
function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 400) {
    // La validazione di Fastify dice il campo nel messaggio («body/url …»).
    const field = /\b(url|events|name|format)\b/.exec(error.message)?.[1] ?? "url";
    return { ok: false, error: "invalid", reason: field };
  }
  // `webhook_limit` (409) e gli altri rifiuti di regola col loro codice.
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

/** L'esito di una prova del server nelle parole del prototipo. */
const outcomeOf = (r: { ok: boolean; status: number | null }): TestOutcome =>
  r.ok ? "ok" : r.status !== null ? "invalid_credentials" : "unreachable";

export function createRealWebhooks(api: WebhooksApi) {
  /** L'ultima prova di ogni webhook in questa sessione (il server non la tiene). */
  const lastTests = new Map<string, { at: string; outcome: TestOutcome }>();

  const viewOf = (w: Any): WebhookView => ({
    id: w.id,
    name: w.name,
    url: w.url,
    format: w.format,
    enabled: !!w.enabled,
    events: (w.events ?? []).filter((e: string) => e !== "__unknown__"),
    secretSet: !!w.secretSet,
    secretRotatedAt: w.secretRotatedAt ?? null,
    createdAt: w.createdAt,
    lastTest: lastTests.get(w.id) ?? null,
  });

  async function attempt<T extends object>(call: () => Promise<T>): Promise<InstanceResult<T>> {
    try {
      return { ok: true, ...(await call()) } as InstanceResult<T>;
    } catch (error) {
      return refusalOf(error);
    }
  }

  return {
    async listWebhooks(): Promise<WebhookView[]> {
      return (await api.list()).map(viewOf);
    },

    async getWebhook(id: string): Promise<WebhookView> {
      const found = (await api.list()).find((w) => w.id === id);
      if (!found) throw new Error("not_found");
      return viewOf(found);
    },

    createWebhook: (input: WebhookInput) =>
      attempt(async () => {
        const r = await api.create({
          name: input.name.trim(),
          url: input.url.trim(),
          format: input.format,
          enabled: input.enabled ?? true,
          events: input.events,
        });
        return { webhook: viewOf(r), secret: r.secret as string };
      }),

    async updateWebhook(id: string, patch: Partial<WebhookInput>): Promise<InstanceResult> {
      const r = await attempt(async () => {
        await api.update(id, patch);
        return {};
      });
      // Cambiare indirizzo o formato rimette la prova a «non ancora provata».
      if (r.ok && (patch.url !== undefined || patch.format !== undefined)) lastTests.delete(id);
      return r;
    },

    regenerateWebhookSecret: (id: string) =>
      attempt(async () => {
        const r = await api.rotateSecret(id);
        return { secret: r.secret as string, secretRotatedAt: r.secretRotatedAt as string };
      }),

    async deleteWebhook(id: string): Promise<InstanceResult> {
      const r = await attempt(async () => {
        await api.remove(id);
        return {};
      });
      if (r.ok) lastTests.delete(id);
      return r;
    },

    testWebhook: (id: string) =>
      attempt(async () => {
        const outcome = outcomeOf(await api.test(id));
        lastTests.set(id, { at: new Date().toISOString(), outcome });
        return { outcome };
      }),

    /** Il corpo che arriverebbe: Slack e Discord come testo, il JSON indentato. */
    async previewWebhook(eventId: WebhookEventId, format: WebhookFormat): Promise<string> {
      const { body } = await api.preview(format, eventId);
      const b = body as { text?: string; content?: string } | null;
      if (format === "slack" && typeof b?.text === "string") return b.text;
      if (format === "discord" && typeof b?.content === "string") return b.content;
      return JSON.stringify(body, null, 2);
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: WebhooksApi = {
  list: () => appClient().webhooks.list() as Promise<Any[]>,
  create: (input) => appClient().webhooks.create(input as Any),
  update: (id, patch) => appClient().webhooks.update(id, patch as Any),
  rotateSecret: (id) => appClient().webhooks.rotateSecret(id),
  remove: (id) => appClient().webhooks.remove(id),
  test: (id) => appClient().webhooks.test(id) as Promise<Any>,
  preview: (format, event) => appClient().webhooks.preview(format, event as Any),
};

/** SOLO TEST: le rotte vere. */
export const liveWebhooksApiForTest = liveApi;

export const liveWebhooks = createRealWebhooks(liveApi);
