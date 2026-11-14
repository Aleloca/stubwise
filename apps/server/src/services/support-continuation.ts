import { backlogItems, widgetConversations, widgetMessages, type Db } from "@stubwise/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

/**
 * La conversazione chiusa e la sua successiva (area 8, F3, S17; maintainer,
 * 14 nov 2026). Una conversazione con un ESITO (una richiesta legata o un
 * ticket aperto dal widget) è CHIUSA: il team non scrive al cliente nel
 * widget, e un messaggio nuovo del cliente apre una conversazione nuova, con
 * il suo `S<n>`, legata alla chiusa da `continued_in_id`.
 *
 * - Un widget vecchio continua a scrivere all'id della chiusa: si segue la
 *   catena fino alla prima aperta, quindi i suoi messaggi finiscono nella
 *   STESSA successiva.
 * - Due messaggi insieme sulla chiusa: il lock della sua riga ne fa aprire
 *   una sola.
 * - La proprietà (progetto, widget, `userId`) la controlla il chiamante PRIMA:
 *   un id rubato non crea niente.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Quante successive si seguono al più (una catena più lunga è un difetto). */
const MAX_CHAIN = 50;

async function hasOutcome(tx: Tx, conversationId: string): Promise<boolean> {
  const [request] = await tx
    .select({ id: backlogItems.id })
    .from(backlogItems)
    .where(eq(backlogItems.supportConversationId, conversationId))
    .limit(1);
  if (request) return true;
  const [ticket] = await tx
    .select({ id: widgetMessages.id })
    .from(widgetMessages)
    .where(and(eq(widgetMessages.conversationId, conversationId), isNotNull(widgetMessages.ticketId)))
    .limit(1);
  return ticket !== undefined;
}

/**
 * L'id della conversazione in cui scrivere adesso: questa, se è aperta;
 * altrimenti la prima aperta della catena, creata se manca.
 */
export async function openConversationFor(db: Db, conversationId: string): Promise<string> {
  return db.transaction(async (tx) => {
    let id = conversationId;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const [row] = await tx
        .select()
        .from(widgetConversations)
        .where(eq(widgetConversations.id, id))
        .for("update");
      if (!row) return id;
      if (!(await hasOutcome(tx, id))) return id;
      if (row.continuedInId) {
        id = row.continuedInId;
        continue;
      }
      const [next] = await tx
        .insert(widgetConversations)
        .values({
          projectId: row.projectId,
          widgetId: row.widgetId,
          externalUserId: row.externalUserId,
          externalUserEmail: row.externalUserEmail,
          externalUserName: row.externalUserName,
          channel: row.channel,
          lastMessageAt: sql`now()`,
        })
        .returning({ id: widgetConversations.id });
      await tx.update(widgetConversations).set({ continuedInId: next!.id }).where(eq(widgetConversations.id, id));
      return next!.id;
    }
    throw new Error(`catena di conversazioni troppo lunga da ${conversationId}`);
  });
}
