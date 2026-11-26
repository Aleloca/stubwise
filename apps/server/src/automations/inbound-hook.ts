import { automationEvents, automations, automationSourceEvents, automationSourceHits, automationSources, automationVersions, type Db } from "@stubwise/db";
import { checkEventFields, type DataField } from "@stubwise/shared";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { hashWebhookSecret } from "./sources.js";
import { effectiveWebhookLimits } from "./webhook-limits.js";

/**
 * IL WEBHOOK IN ARRIVO (area 7, F4, S3; D3 = a): `POST /webhooks/in/:secret`.
 * È una PORTA PUBBLICA: chiunque abbia l'indirizzo scrive i campi, quindi
 *
 * - l'indirizzo si riconosce dall'HASH del segreto (sha256, nessun confronto
 *   sul segreto in chiaro); uno sconosciuto o rigenerato → 404;
 * - il TETTO per indirizzo (al minuto e al giorno, F4-2 = c: scelto per
 *   automazione, mai oltre il massimo d'istanza) si conta in Postgres con
 *   contatori per finestra atomici (`INSERT … ON CONFLICT … RETURNING`),
 *   anche con più processi; oltre → 429, e l'evento non entra;
 * - il corpo è un OGGETTO JSON (al più 256 KB, il `bodyLimit` della rotta:
 *   oltre → 413). Uno che non lo è, o coi tipi sbagliati rispetto ai campi
 *   della sorgente (F4-5 = a), non avvia niente: 422, e compare fra gli
 *   eventi recenti come rifiutato col motivo;
 * - l'evento dell'esecuzione è la PROIEZIONE sui campi dichiarati
 *   (`checkEventFields` di shared): le chiavi in più non entrano nei passi;
 *   resta non fidato (tinto da `taint.ts` come campo di un inizio `source`);
 * - `Idempotency-Key` (al più 200 caratteri) deduplica: una seconda consegna
 *   con la stessa chiave risponde 202 come la prima, senza un'altra
 *   esecuzione (`dedupe_key = src:<sourceId>:<chiave>`).
 *
 * 404, 413 e 429 non si registrano negli eventi recenti: un'inondazione non
 * deve riempire l'elenco. (Un 429 aggiorna però il contatore della finestra,
 * `automation_source_hits`: è il conteggio stesso.) Gli eventi recenti si
 * tengono fino a {@link RECENT_EVENTS_KEPT} per sorgente.
 */

export const RECENT_EVENTS_KEPT = 100;
export const IDEMPOTENCY_KEY_MAX = 200;

export type InboundOutcome =
  | { status: 202; duplicate: boolean }
  | { status: 404 }
  | { status: 422; reason: string }
  | { status: 429; window: "minute" | "day" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * L'automazione (accesa o in pausa) che parte dalla sorgente nella sua ULTIMA
 * versione pubblicata (review F4: come `usersOf` e `sourceFree`; una versione
 * vecchia che la nominava non conta): il suo tetto. Nessuna = i default.
 */
async function capsOf(tx: Tx, sourceId: string) {
  const [a] = await tx
    .select({ webhookPerMinute: automations.webhookPerMinute, webhookPerDay: automations.webhookPerDay })
    .from(automations)
    .innerJoin(automationVersions, eq(automationVersions.automationId, automations.id))
    .where(
      and(
        inArray(automations.status, ["active", "paused"]),
        sql`${automationVersions.publishedAt} is not null`,
        sql`${automationVersions.flow}->'trigger'->>'kind' = 'source'`,
        sql`${automationVersions.flow}->'trigger'->>'sourceId' = ${sourceId}`,
        sql`${automationVersions.n} = (select max(v2.n) from automation_versions v2 where v2.automation_id = ${automations.id} and v2.published_at is not null)`,
      ),
    )
    .limit(1);
  return effectiveWebhookLimits(a ?? { webhookPerMinute: null, webhookPerDay: null });
}

/** Conta un colpo nella finestra e restituisce il totale (atomico). */
async function hit(tx: Tx, sourceId: string, window: "minute" | "day"): Promise<number> {
  const start = sql`date_trunc(${window}, now())`;
  const [row] = await tx
    .insert(automationSourceHits)
    .values({ sourceId, window, windowStart: start as unknown as Date, count: 1 })
    .onConflictDoUpdate({ target: [automationSourceHits.sourceId, automationSourceHits.window, automationSourceHits.windowStart], set: { count: sql`${automationSourceHits.count} + 1` } })
    .returning({ count: automationSourceHits.count });
  return row!.count;
}

/** Il corpo come oggetto JSON, o il motivo per cui non lo è. */
function parseBody(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  return { ok: true, value: value as Record<string, unknown> };
}

export async function receiveWebhook(db: Db, input: { secret: string; body: string; idempotencyKey?: string | undefined }): Promise<InboundOutcome> {
  // Un segreto assurdo non tocca nemmeno il DB per il tetto: 404 come uno sconosciuto.
  if (input.secret.length < 10 || input.secret.length > 200) return { status: 404 };
  const hash = hashWebhookSecret(input.secret);
  // Review F4: il tetto si conta in una transazione A SÉ, prima del parse: un
  // errore dopo (un 500) non annulla il conteggio, e una richiesta conta sempre.
  const gate = await db.transaction(async (tx) => {
    const [source] = await tx.select().from(automationSources).where(eq(automationSources.secretHash, hash));
    if (!source) return { status: 404 } as const;
    const caps = await capsOf(tx, source.id);
    if ((await hit(tx, source.id, "minute")) > caps.perMinute) return { status: 429, window: "minute" } as const;
    if ((await hit(tx, source.id, "day")) > caps.perDay) return { status: 429, window: "day" } as const;
    // I contatori di ieri non servono più.
    await tx.delete(automationSourceHits).where(and(eq(automationSourceHits.sourceId, source.id), lt(automationSourceHits.windowStart, sql`now() - interval '2 days'`)));
    return { status: "ok" as const, source };
  });
  if (gate.status !== "ok") return gate;
  const source = gate.source;
  return db.transaction(async (tx) => {
    const record = async (status: "accepted" | "duplicate" | "rejected", reason: string | null, payload: unknown, eventId: string | null) => {
      await tx.insert(automationSourceEvents).values({ sourceId: source.id, status, reason, payload: payload as never, eventId });
      const keep = tx
        .select({ id: automationSourceEvents.id })
        .from(automationSourceEvents)
        .where(eq(automationSourceEvents.sourceId, source.id))
        .orderBy(desc(automationSourceEvents.receivedAt))
        .limit(RECENT_EVENTS_KEPT);
      await tx.delete(automationSourceEvents).where(and(eq(automationSourceEvents.sourceId, source.id), notInArray(automationSourceEvents.id, keep)));
    };

    const parsed = parseBody(input.body);
    if (!parsed.ok) {
      await record("rejected", "json", null, null);
      return { status: 422, reason: "json" } as const;
    }
    const checked = checkEventFields(parsed.value, (source.fields ?? []) as DataField[]);
    if (!checked.ok) {
      const reason = `${checked.key}: ${checked.expected}`;
      await record("rejected", reason, parsed.value, null);
      return { status: 422, reason } as const;
    }

    const key = input.idempotencyKey?.trim();
    const dedupeKey = key ? `src:${source.id}:${key.slice(0, IDEMPOTENCY_KEY_MAX)}` : null;
    const [event] = await tx
      .insert(automationEvents)
      .values({ kind: "source_event", sourceId: source.id, dedupeKey, payload: { event: checked.event } })
      .onConflictDoNothing()
      .returning({ id: automationEvents.id });
    if (!event) {
      await record("duplicate", null, parsed.value, null);
      return { status: 202, duplicate: true } as const;
    }
    await record("accepted", null, parsed.value, event.id);
    return { status: 202, duplicate: false } as const;
  });
}
