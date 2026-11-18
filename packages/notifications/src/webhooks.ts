import { createHmac } from "node:crypto";
import { decrypt, instanceSettings, outgoingWebhooks, type Db } from "@stubwise/db";
import { OUTGOING_WEBHOOK_EVENTS, webhookEventsOfKind, type OutgoingWebhookEvent } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { formatNotification, sampleEvents } from "./format.js";
import type { NotificationEvent } from "./format.js";

/**
 * Area 9, F3 (D-10 = b): i webhook in uscita, in UN posto, per il server
 * (prova, anteprima) e per il worker (il poller delle consegne). Ogni webhook
 * ha il suo formato e il suo segreto; un webhook riceve SOLO gli eventi che ha
 * scelto (`webhookEventsOfKind`), e mai uno personale (quelli non hanno un
 * evento nel catalogo).
 */

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type WebhookFormat = "slack" | "discord" | "generic";

/** Un webhook pronto all'invio: il segreto in chiaro (decifrato ORA), o null se non c'è. */
export interface SendableWebhook {
  id: string;
  url: string;
  format: WebhookFormat;
  secret: string | null;
}

/**
 * L'header della firma: `t=<unix>,v1=<hex HMAC-SHA256 di "<t>.<body>">`. Il
 * destinatario ricalcola l'HMAC sul corpo GREZZO ricevuto e confronta in tempo
 * costante; `t` gli permette di rifiutare un invio troppo vecchio.
 */
export function webhookSignature(secret: string, body: string, unixSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${v1}`;
}

export interface WebhookSendOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Il corpo che QUEL webhook riceverebbe per un evento, nel suo formato. */
export function webhookBody(format: WebhookFormat, event: NotificationEvent, lang: "en" | "it"): Record<string, unknown> {
  return formatNotification(event, format, lang).body as Record<string, unknown>;
}

/**
 * INVIA a un webhook: col suo formato e, se ha un segreto, la firma. Lancia su
 * rete, timeout e risposta non 2xx (il poller incrementa i tentativi di QUESTA
 * consegna e riprova: un webhook che fallisce non ferma gli altri).
 */
export async function sendToWebhook(webhook: SendableWebhook, event: NotificationEvent, lang: "en" | "it", opts: WebhookSendOptions = {}): Promise<Response> {
  const body = JSON.stringify(webhookBody(webhook.format, event, lang));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhook.secret) {
    const t = Math.floor((opts.now?.() ?? Date.now()) / 1000);
    headers["x-stubwise-signature"] = webhookSignature(webhook.secret, body, t);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const response = await (opts.fetchImpl ?? fetch)(webhook.url, { method: "POST", headers, body, signal: controller.signal });
    if (!response.ok) throw new Error(`Webhook responded with status ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Il webhook di una consegna, se esiste ancora ed è acceso (sennò la consegna
 * si chiude senza invio). `includeDisabled`: la PROVA dalle impostazioni, che
 * vale anche per un webhook spento.
 */
export async function sendableWebhook(db: DbOrTx, id: string, encryptionKey: Buffer, opts: { includeDisabled?: boolean } = {}): Promise<SendableWebhook | null> {
  const [row] = await db
    .select()
    .from(outgoingWebhooks)
    .where(and(eq(outgoingWebhooks.id, id), ...(opts.includeDisabled ? [] : [eq(outgoingWebhooks.enabled, true)])));
  if (!row) return null;
  return { id: row.id, url: row.url, format: row.format, secret: row.secretEncrypted ? decrypt(row.secretEncrypted, encryptionKey) : null };
}

/**
 * I webhook accesi che hanno scelto un evento coperto da `kind`: quelli che
 * ricevono una consegna. Nessuno per un kind senza evento (personale, posta).
 */
export async function webhookIdsForKind(db: DbOrTx, kind: string): Promise<string[]> {
  const events = webhookEventsOfKind(kind);
  if (events.length === 0) return [];
  const rows = await db
    .select({ id: outgoingWebhooks.id })
    .from(outgoingWebhooks)
    .where(and(eq(outgoingWebhooks.enabled, true), sql`${outgoingWebhooks.events} && ${`{${events.join(",")}}`}::text[]`));
  return rows.map((r) => r.id);
}

/** L'evento d'esempio di un evento del catalogo (anteprima e prova), o null se non ha ancora una notifica viva. */
export function sampleEventFor(event: OutgoingWebhookEvent, baseUrl: string): NotificationEvent | null {
  const kinds = OUTGOING_WEBHOOK_EVENTS.find((e) => e.id === event)?.kinds ?? [];
  const samples = sampleEvents(baseUrl);
  for (const kind of kinds) {
    const sample = samples.find((s) => s.kind === kind);
    if (sample) return sample;
  }
  return null;
}

/** La lingua dei contenuti dell'istanza (i testi dei template). */
export async function contentLanguageOf(db: DbOrTx): Promise<"en" | "it"> {
  const [row] = await db.select({ contentLanguage: instanceSettings.contentLanguage }).from(instanceSettings).limit(1);
  return row?.contentLanguage ?? "en";
}
