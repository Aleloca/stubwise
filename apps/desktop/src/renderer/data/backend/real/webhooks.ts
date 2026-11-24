import { ApiError } from "@stubwise/api-client";
import type { WebhookTestOutcome } from "../../instance/state";
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
// L'ultima prova la ricorda il server (rimandi, lotto 5, voce 6: `lastTest`,
// tolta quando cambiano URL o formato): la riga «Sent · delivered · data» la
// legge da lì, e sopravvive a un riavvio dell'app.

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
/**
 * L'esito della prova appena fatta (revisione del lotto 5, M-5, come il
 * server): 401/403 credenziali, un altro codice errore della destinazione,
 * nessuna risposta irraggiungibile.
 */
const outcomeOf = (r: { ok: boolean; status: number | null }): WebhookTestOutcome =>
  r.ok
    ? "ok"
    : r.status === null
      ? "unreachable"
      : r.status === 401 || r.status === 403
        ? "invalid_credentials"
        : "destination_error";

const OUTCOMES: ReadonlySet<string> = new Set([
  "ok",
  "invalid_credentials",
  "destination_error",
  "unreachable",
]);

/** L'ultima prova del server; un esito che il client non conosce: «non ancora provata». */
const lastTestOf = (
  t: Any,
): { at: string; outcome: WebhookTestOutcome; status: number | null } | null =>
  t && typeof t.at === "string" && OUTCOMES.has(t.outcome)
    ? {
        at: t.at,
        outcome: t.outcome as WebhookTestOutcome,
        // Una riga di prima del codice (0227): null.
        status: typeof t.status === "number" ? t.status : null,
      }
    : null;

export function createRealWebhooks(api: WebhooksApi) {
  const viewOf = (w: Any): WebhookView => ({
    id: w.id,
    name: w.name,
    url: w.url,
    // Un formato che il client non conosce: la pagina non lo modifica (I2).
    format: w.format === "__unknown__" ? "generic" : w.format,
    formatUnknown: w.format === "__unknown__",
    unknownEvents: (w.events ?? []).includes("__unknown__"),
    enabled: !!w.enabled,
    events: (w.events ?? []).filter((e: string) => e !== "__unknown__"),
    secretSet: !!w.secretSet,
    secretRotatedAt: w.secretRotatedAt ?? null,
    createdAt: w.createdAt,
    lastTest: lastTestOf(w.lastTest),
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

    // Cambiare indirizzo o formato toglie l'ultima prova: lo fa il server.
    updateWebhook: (id: string, patch: Partial<WebhookInput>): Promise<InstanceResult> =>
      attempt(async () => {
        await api.update(id, patch);
        return {};
      }),

    regenerateWebhookSecret: (id: string) =>
      attempt(async () => {
        const r = await api.rotateSecret(id);
        return { secret: r.secret as string, secretRotatedAt: r.secretRotatedAt as string };
      }),

    deleteWebhook: (id: string): Promise<InstanceResult> =>
      attempt(async () => {
        await api.remove(id);
        return {};
      }),

    testWebhook: (id: string) =>
      attempt(async () => {
        // L'esito di adesso; quello che resta lo scrive il server (`lastTest`).
        return { outcome: outcomeOf(await api.test(id)) };
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
