import { backlogItems, projects, widgetConversations, widgetMessages, type Db } from "@stubwise/db";
import type { ProjectRequestView } from "@stubwise/shared";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";

/**
 * I legami con Support che le altre viste DERIVANO a lettura (area 8, F3,
 * S6): la provenienza di una richiesta (`origin`) e la conversazione da cui il
 * widget ha aperto una task (`supportConversationCode`, «View conversation»,
 * S-9). In blocco, una query per pagina; nessun campo scritto nell'evento o
 * nella riga.
 */

/** Il codice `<PRJ>-S<n>` della conversazione da cui il widget ha aperto ogni task. */
export async function supportCodesForTickets(db: Db, ticketIds: readonly string[]): Promise<Map<string, string>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ ticketId: widgetMessages.ticketId, number: widgetConversations.number, code: projects.code })
    .from(widgetMessages)
    .innerJoin(widgetConversations, eq(widgetConversations.id, widgetMessages.conversationId))
    .innerJoin(projects, eq(projects.id, widgetConversations.projectId))
    .where(and(inArray(widgetMessages.ticketId, [...ticketIds]), isNotNull(widgetMessages.ticketId)));
  return new Map(rows.map((r) => [r.ticketId!, `${r.code}-S${r.number}`]));
}

/** La provenienza da Support di ogni richiesta che ne ha una. */
export async function supportOriginsForRequests(db: Db, itemIds: readonly string[]): Promise<Map<string, NonNullable<ProjectRequestView["origin"]>>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select({
      itemId: backlogItems.id,
      conversationId: widgetConversations.id,
      number: widgetConversations.number,
      channel: widgetConversations.channel,
      customerName: widgetConversations.externalUserName,
      code: projects.code,
    })
    .from(backlogItems)
    .innerJoin(widgetConversations, eq(widgetConversations.id, backlogItems.supportConversationId))
    .innerJoin(projects, eq(projects.id, widgetConversations.projectId))
    .where(inArray(backlogItems.id, [...itemIds]));
  if (rows.length === 0) return new Map();
  const counts = await db
    .select({ conversationId: widgetMessages.conversationId, n: count() })
    .from(widgetMessages)
    .where(inArray(widgetMessages.conversationId, rows.map((r) => r.conversationId)))
    .groupBy(widgetMessages.conversationId);
  const countOf = new Map(counts.map((c) => [c.conversationId, Number(c.n)]));
  return new Map(
    rows.map((r) => [
      r.itemId,
      {
        kind: "support" as const,
        conversationCode: `${r.code}-S${r.number}`,
        channel: r.channel,
        customerName: r.customerName,
        messageCount: countOf.get(r.conversationId) ?? 0,
      },
    ]),
  );
}
