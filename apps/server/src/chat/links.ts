import { chatMessageLinks, chatMessages, type Db } from "@stubwise/db";
import { eq, sql } from "drizzle-orm";
import { channelAccess, visibleChannel, type ChatViewer } from "./access.js";
import { CHAT_CHANNEL_NOTIFY } from "./notify.js";

/**
 * Dal messaggio a Stubwise («Create task», «Create request»): le due funzioni
 * che le scritture delle task e delle richieste usano. Stanno in un modulo
 * FOGLIA, che non importa `service.ts` né gli allegati né lo storage: il
 * catalogo delle azioni di Claude arriva qui da `task-writes.ts`, e da qui non
 * deve poter uscire (`claude-actions-effects.test.ts`, «solo `effects.ts` può
 * uscire»). `service.ts` le ri-esporta, così nessun import esistente cambia.
 */

/**
 * Il messaggio da cui nasce una task o una richiesta: chi la crea lo deve
 * LEGGERE, e non dev'essere eliminato (`createTaskFromMessage` del prototipo).
 * `false` risponde come un messaggio che non c'è.
 */
export async function messageLinkable(db: Db, viewer: ChatViewer, messageId: string): Promise<boolean> {
  const [message] = await db.select({ channelId: chatMessages.channelId, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!message || message.deletedAt !== null) return false;
  const channel = await visibleChannel(db, viewer, message.channelId);
  if (!channel) return false;
  return (await channelAccess(db, viewer, channel)).canRead;
}

/**
 * Lega al messaggio ciò che ne è nato («→ AUD-14»), nella transazione di chi
 * lo crea; il messaggio avanza (`updated_at`) così lo stream lo rimanda. Lo
 * stesso oggetto una volta sola.
 */
export async function linkMessage(
  tx: Pick<Db, "insert" | "update" | "execute">,
  input: { messageId: string; ticketId?: string; backlogItemId?: string; createdBy: string | null },
): Promise<void> {
  await tx
    .insert(chatMessageLinks)
    .values({
      messageId: input.messageId,
      ticketId: input.ticketId ?? null,
      backlogItemId: input.backlogItemId ?? null,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .update(chatMessages)
    .set({ updatedAt: sql`now()` })
    .where(eq(chatMessages.id, input.messageId))
    .returning({ channelId: chatMessages.channelId });
  if (row) await tx.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId: row.channelId })})`);
}
