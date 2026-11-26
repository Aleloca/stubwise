import type { Db } from "@stubwise/db";
import { sql } from "drizzle-orm";

/** Il canale Postgres dello stream della Chat (`CHAT_CHANNEL_NOTIFY` del server). */
const CHAT_CHANNEL_NOTIFY = "chat_channel";

/**
 * «Create request» da un messaggio della Chat (area 4, fetta 2): a fine
 * intake la richiesta (nuova o quella in cui è stata fusa) si lega al
 * messaggio da cui è nata, «→ AUD-R7». Il server ha già verificato che chi la
 * chiede legga il messaggio; il codice lo deriva lui a lettura, filtrato per
 * chi guarda.
 *
 * Fail-open: la richiesta è già scritta, e un legame che non si scrive (il
 * canale eliminato nel frattempo) non deve far ripetere l'intake, che
 * creerebbe un doppione. Lo stesso oggetto si lega una volta sola.
 */
export async function linkChatMessage(
  db: Db,
  input: { messageId: string; backlogItemId: string; createdBy: string | null },
): Promise<boolean> {
  const rows = await db.execute<{ channel_id: string }>(sql`
    with linked as (
      insert into chat_message_links (message_id, backlog_item_id, created_by)
      select m.id, ${input.backlogItemId}::uuid, ${input.createdBy}::uuid
      from chat_messages m
      where m.id = ${input.messageId}::uuid
      on conflict do nothing
      returning message_id
    )
    update chat_messages set updated_at = now()
    where id in (select message_id from linked)
    returning channel_id
  `);
  const channelId = [...rows][0]?.channel_id;
  if (!channelId) return false;
  await db.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId })})`);
  return true;
}
