import { mailDrafts, mailOutgoing, type Db } from "@stubwise/db";
import { MAIL_OUTGOING_CHANNEL, type MailDraft, type MailOutgoing } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { listDrafts } from "./mail-drafts.js";

/**
 * L'INVIO TRATTENUTO DAL SERVER (area 6, fetta 3, D6: 10 secondi).
 *
 * Invia = una riga `mail_outgoing` (`queued`, `send_at = now() + 10 s`, chi l'ha
 * chiesto) e la bozza passa a `sending` (lo slot torna libero); il worker la
 * manda allo scadere (`apps/worker/src/google/mail-sender.ts`). Fino ad allora
 * Annulla la riporta indietro. Un invio fallito non si ritenta MAI da solo:
 * Riprova ed Elimina sono gesti della persona.
 *
 * Idempotenza: un secondo Invia sulla stessa bozza (un doppio clic) restituisce
 * l'invio già in coda, non ne crea un altro; Annulla e il worker decidono sulla
 * riga BLOCCATA (`FOR UPDATE`) e ricontrollano stato e scadenza, così un
 * Annulla all'ultimo istante e il worker che parte non mandano e annullano
 * insieme. Tutto è di chi scrive: l'id di chi guarda nella WHERE.
 */

/** Quanto il server trattiene un invio (D6). */
export const MAIL_UNDO_SECONDS = 10;

export type SendError = { error: "not_found" } | { error: "too_late" } | { error: "draft_slot_taken" } | { error: "not_failed" };

function toView(row: typeof mailOutgoing.$inferSelect): MailOutgoing {
  return {
    messageId: row.id,
    threadId: row.gmailThreadId ?? row.threadId,
    state: row.state,
    undoUntil: row.sendAt.toISOString(),
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

/** Invia: in coda per 10 s. Un secondo Invia della stessa bozza restituisce lo stesso invio. */
export async function sendDraftLater(db: Db, userId: string, draftId: string): Promise<MailOutgoing | SendError> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(mailDrafts)
      .where(and(eq(mailDrafts.id, draftId), eq(mailDrafts.userId, userId)))
      .for("update");
    if (!draft) return { error: "not_found" as const };
    if (draft.state === "sending") {
      const [pending] = await tx
        .select()
        .from(mailOutgoing)
        .where(and(eq(mailOutgoing.draftId, draft.id), sql`${mailOutgoing.state} in ('queued', 'sending', 'sent')`));
      if (pending) return toView(pending);
    }
    const [row] = await tx
      .insert(mailOutgoing)
      .values({
        userId,
        accountId: draft.accountId,
        draftId: draft.id,
        gmailDraftId: draft.gmailDraftId,
        threadId: draft.threadId,
        sendAt: sql`now() + make_interval(secs => ${MAIL_UNDO_SECONDS})`,
      })
      .returning();
    await tx.update(mailDrafts).set({ state: "sending" }).where(eq(mailDrafts.id, draft.id));
    await tx.execute(sql`select pg_notify(${MAIL_OUTGOING_CHANNEL}, ${JSON.stringify({ outgoingId: row!.id })})`);
    return toView(row!);
  });
}

/** Lo stato di un invio (per chi aspetta la fine dei 10 s). */
export async function getOutgoing(db: Db, userId: string, id: string): Promise<MailOutgoing | null> {
  const [row] = await db.select().from(mailOutgoing).where(and(eq(mailOutgoing.id, id), eq(mailOutgoing.userId, userId)));
  return row ? toView(row) : null;
}

/** Riporta la bozza fra le attive; se lo slot è occupato da una bozza più nuova, `draft_slot_taken` *(O)*. */
async function restoreDraft(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], userId: string, draftId: string | null) {
  if (!draftId) return null;
  const [draft] = await tx.select().from(mailDrafts).where(and(eq(mailDrafts.id, draftId), eq(mailDrafts.userId, userId)));
  if (!draft) return null;
  // Lo slot occupato da una bozza più nuova si guarda PRIMA: un unique violato
  // dentro la transazione la renderebbe inutilizzabile (Postgres la abortisce).
  const [taken] = await tx
    .select({ id: mailDrafts.id })
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.userId, userId),
        eq(mailDrafts.accountId, draft.accountId),
        eq(mailDrafts.mode, draft.mode),
        eq(mailDrafts.state, "active"),
        sql`coalesce(${mailDrafts.threadId}, '') = coalesce(${draft.threadId}, '')`,
      ),
    );
  if (taken) return "slot_taken" as const;
  const [restored] = await tx.update(mailDrafts).set({ state: "active" }).where(eq(mailDrafts.id, draftId)).returning();
  return restored ?? null;
}

async function draftView(db: Db, userId: string, draftId: string): Promise<MailDraft | null> {
  return (await listDrafts(db, userId)).find((d) => d.id === draftId) ?? null;
}

/** Annulla l'invio, prima che scadano i 10 s: la bozza torna. Dopo, `too_late`. */
export async function undoSend(db: Db, userId: string, id: string): Promise<{ draft: MailDraft | null; droppedAttachments: string[] } | SendError> {
  const out: SendError | { draftId: string | null } = await db.transaction(async (tx): Promise<SendError | { draftId: string | null }> => {
    const [row] = await tx.select().from(mailOutgoing).where(and(eq(mailOutgoing.id, id), eq(mailOutgoing.userId, userId))).for("update");
    if (!row) return { error: "not_found" as const };
    if (row.state !== "queued" || row.sendAt.getTime() <= Date.now()) return { error: "too_late" as const };
    await tx.update(mailOutgoing).set({ state: "cancelled" }).where(eq(mailOutgoing.id, id));
    const restored = await restoreDraft(tx, userId, row.draftId);
    if (restored === "slot_taken") throw new SlotTaken();
    return { draftId: row.draftId };
  }).catch((err: unknown): SendError => {
    if (err instanceof SlotTaken) return { error: "draft_slot_taken" };
    throw err;
  });
  if ("error" in out) return out;
  return { draft: out.draftId ? await draftView(db, userId, out.draftId) : null, droppedAttachments: [] };
}

class SlotTaken extends Error {}

/** Riprova un invio FALLITO: un gesto della persona, mai il worker da solo. Parte subito. */
export async function retrySend(db: Db, userId: string, id: string): Promise<MailOutgoing | SendError> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(mailOutgoing).where(and(eq(mailOutgoing.id, id), eq(mailOutgoing.userId, userId))).for("update");
    if (!row) return { error: "not_found" as const };
    if (row.state !== "failed") return { error: "not_failed" as const };
    const [updated] = await tx.update(mailOutgoing).set({ state: "queued", error: null, sendAt: sql`now()` }).where(eq(mailOutgoing.id, id)).returning();
    await tx.execute(sql`select pg_notify(${MAIL_OUTGOING_CHANNEL}, ${JSON.stringify({ outgoingId: id })})`);
    return toView(updated!);
  });
}

/** Elimina un invio FALLITO: la bozza torna, per correggerla. */
export async function discardFailedSend(db: Db, userId: string, id: string): Promise<{ draft: MailDraft | null; droppedAttachments: string[] } | SendError> {
  const out: SendError | { draftId: string | null } = await db.transaction(async (tx): Promise<SendError | { draftId: string | null }> => {
    const [row] = await tx.select().from(mailOutgoing).where(and(eq(mailOutgoing.id, id), eq(mailOutgoing.userId, userId))).for("update");
    if (!row) return { error: "not_found" as const };
    if (row.state !== "failed") return { error: "not_failed" as const };
    await tx.update(mailOutgoing).set({ state: "cancelled" }).where(eq(mailOutgoing.id, id));
    const restored = await restoreDraft(tx, userId, row.draftId);
    if (restored === "slot_taken") throw new SlotTaken();
    return { draftId: row.draftId };
  }).catch((err: unknown): SendError => {
    if (err instanceof SlotTaken) return { error: "draft_slot_taken" };
    throw err;
  });
  if ("error" in out) return out;
  return { draft: out.draftId ? await draftView(db, userId, out.draftId) : null, droppedAttachments: [] };
}
