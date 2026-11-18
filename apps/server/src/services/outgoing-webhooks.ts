import { randomBytes } from "node:crypto";
import { encrypt, outgoingWebhooks, type Db } from "@stubwise/db";
import { contentLanguageOf, sampleEventFor, sendableWebhook, sendToWebhook, webhookBody } from "@stubwise/notifications";
import {
  OUTGOING_WEBHOOK_LIMIT,
  type CreateOutgoingWebhookInput,
  type OutgoingWebhookEvent,
  type OutgoingWebhookView,
  type OutgoingWebhookWithSecret,
  type UpdateOutgoingWebhookInput,
} from "@stubwise/shared";
import { asc, count, eq, sql } from "drizzle-orm";
import { changedFields, recordChange } from "./change-log.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F3 (D-10 = b): i webhook in uscita. Il segreto lo genera il server
 * (32 byte), si salva cifrato, si mostra UNA volta (creazione, rigenerazione)
 * e non esce da nessuna lettura, log o voce del registro. L'URL non è un
 * segreto ([IN 4]). Al più `OUTGOING_WEBHOOK_LIMIT` per istanza.
 */

type Actor = { id: string; email: string };
type Row = typeof outgoingWebhooks.$inferSelect;
const LIMIT_LOCK = sql`select pg_advisory_xact_lock(hashtext('outgoing_webhooks_limit'))`;

export function toWebhookView(row: Row): OutgoingWebhookView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    format: row.format,
    enabled: row.enabled,
    events: row.events as OutgoingWebhookEvent[],
    secretSet: row.secretEncrypted !== null,
    secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const webhookObject = (row: { id: string; name: string }) => ({ type: "webhook", id: row.id, label: row.name });
const newSecret = () => randomBytes(32).toString("base64url");
const notFound = () => new RoleRuleError(404, "webhook_not_found", "Webhook not found");

export async function listWebhooks(db: Db): Promise<OutgoingWebhookView[]> {
  return (await db.select().from(outgoingWebhooks).orderBy(asc(outgoingWebhooks.createdAt))).map(toWebhookView);
}

export async function createWebhook(db: Db, key: Buffer, actor: Actor, input: CreateOutgoingWebhookInput): Promise<OutgoingWebhookWithSecret> {
  const secret = newSecret();
  const row = await db.transaction(async (tx) => {
    await tx.execute(LIMIT_LOCK);
    const [{ n }] = (await tx.select({ n: count() }).from(outgoingWebhooks)) as [{ n: number }];
    if (Number(n) >= OUTGOING_WEBHOOK_LIMIT) throw new RoleRuleError(409, "webhook_limit", `At most ${OUTGOING_WEBHOOK_LIMIT} webhooks`);
    const [created] = await tx
      .insert(outgoingWebhooks)
      .values({ ...input, secretEncrypted: encrypt(secret, key), secretRotatedAt: new Date(), createdByUserId: actor.id })
      .returning();
    await recordChange(tx, { type: "webhook.created", actor, projectId: null, data: { object: webhookObject(created!), params: { format: created!.format, events: created!.events } } });
    return created!;
  });
  return { ...toWebhookView(row), secret };
}

export async function updateWebhook(db: Db, actor: Actor, id: string, patch: UpdateOutgoingWebhookInput): Promise<OutgoingWebhookView> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, id)).for("update");
    if (!before) throw notFound();
    // Una patch vuota è una lettura (drizzle rifiuta un update senza colonne).
    if (Object.keys(patch).length === 0) return toWebhookView(before);
    const [after] = await tx.update(outgoingWebhooks).set(patch).where(eq(outgoingWebhooks.id, id)).returning();
    // Come il prototipo (`webhook.ts`, voce `fields`): i soli campi cambiati,
    // l'URL com'è (non è un segreto, [IN 4]), gli eventi come lista di id
    // ordinata. Una modifica che non cambia niente non scrive.
    const fields = (w: Row) => ({ name: w.name, url: w.url, format: w.format, enabled: w.enabled, events: [...w.events].sort() });
    const diff = changedFields(fields(before), fields(after!));
    if (diff) await recordChange(tx, { type: "webhook.updated", actor, projectId: null, data: { object: webhookObject(after!), ...diff } });
    return toWebhookView(after!);
  });
}

export async function rotateWebhookSecret(db: Db, key: Buffer, actor: Actor, id: string): Promise<OutgoingWebhookWithSecret> {
  const secret = newSecret();
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(outgoingWebhooks)
      .set({ secretEncrypted: encrypt(secret, key), secretRotatedAt: new Date() })
      .where(eq(outgoingWebhooks.id, id))
      .returning();
    if (!updated) throw notFound();
    // La voce dice solo «sostituito»: il tipo stesso.
    await recordChange(tx, { type: "webhook.secret_replaced", actor, projectId: null, data: { object: webhookObject(updated) } });
    return updated;
  });
  return { ...toWebhookView(row), secret };
}

export async function deleteWebhook(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(outgoingWebhooks).where(eq(outgoingWebhooks.id, id)).returning();
    if (!gone) throw notFound();
    await recordChange(tx, { type: "webhook.deleted", actor, projectId: null, data: { object: webhookObject(gone) } });
  });
}

/** La prova: un evento d'esempio, col formato e la firma di QUEL webhook (anche se è spento). */
export async function testWebhook(db: Db, key: Buffer, id: string, publicUrl: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const webhook = await sendableWebhook(db, id, key, { includeDisabled: true });
  if (!webhook) throw notFound();
  const event = sampleEventFor("ticket.created", publicUrl)!;
  try {
    const response = await sendToWebhook(webhook, event, await contentLanguageOf(db));
    return { ok: true, status: response.status, error: null };
  } catch (error) {
    const status = /status (\d+)/.exec(String((error as Error).message))?.[1];
    return { ok: false, status: status ? Number(status) : null, error: (error as Error).message };
  }
}

/** L'anteprima: il corpo che arriverebbe, coi template veri e un evento d'esempio. */
export async function previewWebhook(db: Db, format: "slack" | "discord" | "generic", event: OutgoingWebhookEvent, publicUrl: string) {
  const sample = sampleEventFor(event, publicUrl);
  if (!sample) throw new RoleRuleError(422, "event_not_live", "This event has no live notification yet");
  return { format, event, body: webhookBody(format, sample, await contentLanguageOf(db)) };
}
