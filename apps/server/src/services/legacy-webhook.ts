import { outgoingWebhooks, type Db } from "@stubwise/db";
import { LEGACY_WEBHOOK_TOGGLES, OUTGOING_WEBHOOK_LIMIT, type LegacyWebhookToggle, type OutgoingWebhookEvent } from "@stubwise/shared";
import { asc, count, sql } from "drizzle-orm";
import { recordChange } from "./change-log.js";
import { changesWebhookUrl, testWebhook, updateWebhook } from "./outgoing-webhooks.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F3 (H-4 = a): la pagina Notifiche del web vecchio lavora sul
 * webhook PIÙ VECCHIO, finché il web vecchio esiste. Gli interruttori sono
 * gli eventi di `LEGACY_WEBHOOK_TOGGLES` (la mappa della 0188); gli eventi
 * che quella pagina non sa mostrare (scelti dall'app nuova) restano com'erano.
 *
 * Due regole che il web vecchio non poteva conoscere:
 * - un URL vuoto SPEGNE il webhook, non lo elimina: eliminare chiede la
 *   riconferma (`DELETE /api/settings/webhooks/:id`), e questa rotta non la
 *   chiede;
 * - un webhook creato da qui nasce SENZA segreto, come quello migrato: il web
 *   vecchio non saprebbe mostrarlo, e un segreto si genera dall'app nuova
 *   (che chiede la riconferma).
 */

type Actor = { id: string; email: string };
type Toggles = Record<LegacyWebhookToggle, boolean>;
export type LegacyWebhookView = { webhookUrl: string | null; format: "slack" | "discord" | "generic"; enabled: boolean } & Toggles;
export type LegacyWebhookInput = { webhookUrl: string; format: "slack" | "discord" | "generic"; enabled: boolean } & Toggles;

const TOGGLES = Object.keys(LEGACY_WEBHOOK_TOGGLES) as LegacyWebhookToggle[];
const LEGACY_EVENTS = new Set<string>(Object.values(LEGACY_WEBHOOK_TOGGLES));

async function oldest(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0]) {
  const [row] = await db.select().from(outgoingWebhooks).orderBy(asc(outgoingWebhooks.createdAt), asc(outgoingWebhooks.id)).limit(1);
  return row ?? null;
}

/** Il salvataggio dal web vecchio porta un URL NUOVO (cambiato, o un webhook creato)? Allora chiede la riconferma. */
export async function legacySaveChangesUrl(db: Db, url: string): Promise<boolean> {
  return changesWebhookUrl((await oldest(db))?.url ?? null, url);
}

export async function loadLegacyWebhook(db: Db): Promise<LegacyWebhookView> {
  const row = await oldest(db);
  const toggles = Object.fromEntries(TOGGLES.map((t) => [t, row ? row.events.includes(LEGACY_WEBHOOK_TOGGLES[t]) : true])) as Toggles;
  return { webhookUrl: row?.url ?? null, format: row?.format ?? "slack", enabled: row?.enabled ?? true, ...toggles };
}

export async function saveLegacyWebhook(db: Db, actor: Actor, input: LegacyWebhookInput): Promise<LegacyWebhookView> {
  const chosen = TOGGLES.filter((t) => input[t]).map((t) => LEGACY_WEBHOOK_TOGGLES[t]);
  const row = await oldest(db);
  if (row) {
    const kept = row.events.filter((e) => !LEGACY_EVENTS.has(e));
    const events = [...kept, ...chosen] as OutgoingWebhookEvent[];
    // Tutto il body si salva, come allora; un URL vuoto spegne e lascia l'URL.
    await updateWebhook(db, actor, row.id, input.webhookUrl === "" ? { format: input.format, enabled: false, events } : { url: input.webhookUrl, format: input.format, enabled: input.enabled, events });
  } else if (input.webhookUrl !== "") {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('outgoing_webhooks_limit'))`);
      const [{ n }] = (await tx.select({ n: count() }).from(outgoingWebhooks)) as [{ n: number }];
      if (Number(n) >= OUTGOING_WEBHOOK_LIMIT) throw new RoleRuleError(409, "webhook_limit", `At most ${OUTGOING_WEBHOOK_LIMIT} webhooks`);
      const [created] = await tx
        .insert(outgoingWebhooks)
        .values({ name: "Webhook", url: input.webhookUrl, format: input.format, enabled: input.enabled, events: chosen, createdByUserId: actor.id })
        .returning();
      await recordChange(tx, { type: "webhook.created", actor, projectId: null, data: { object: { type: "webhook", id: created!.id, label: created!.name }, params: { format: created!.format, events: created!.events } } });
    });
  }
  return loadLegacyWebhook(db);
}

/** La prova del web vecchio, sul webhook più vecchio, con la risposta di allora. */
export async function testLegacyWebhook(db: Db, key: Buffer, publicUrl: string): Promise<{ ok: boolean; detail: string }> {
  const row = await oldest(db);
  if (!row) return { ok: false, detail: "Nessun webhook configurato." };
  const result = await testWebhook(db, key, row.id, publicUrl);
  // Le frasi di allora (`sendTest`), che il web vecchio mostra così come sono.
  if (result.ok) return { ok: true, detail: "Notifica di test inviata correttamente." };
  if (result.status !== null) return { ok: false, detail: `Il webhook ha risposto con stato ${result.status}.` };
  return { ok: false, detail: result.error ?? "Invio non riuscito." };
}
