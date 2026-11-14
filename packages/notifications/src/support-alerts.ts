import { backlogItems, projects, supportFollowers, widgetConversations, widgetMessages, type Db } from "@stubwise/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { publishNotification } from "./publish.js";

/**
 * I due avvisi di Support (area 8, F3, S7), nel catalogo: li pubblicano il
 * server («Apri la richiesta», il messaggio del cliente nel widget) e il worker
 * (l'intake che nasce dal ticket di un widget), con UNA forma. Best-effort:
 * `publishNotification` non lancia. Senza radice pubblica il link resta
 * RELATIVO (`/app/#/…`), come gli avvisi dei rilasci.
 */

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const root = (publicUrl: string | null | undefined) => (publicUrl ?? "").replace(/\/+$/, "");

/** `support.request`: una richiesta nata da una conversazione. Nessun obbligatorio (il catalogo: default per `backlog.edit`). */
export async function publishSupportRequestAlert(db: DbOrTx, publicUrl: string | null | undefined, itemId: string): Promise<void> {
  const [row] = await db
    .select({
      projectId: backlogItems.projectId,
      number: backlogItems.number,
      title: backlogItems.title,
      code: projects.code,
      customerName: widgetConversations.externalUserName,
    })
    .from(backlogItems)
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .innerJoin(widgetConversations, eq(widgetConversations.id, backlogItems.supportConversationId))
    .where(eq(backlogItems.id, itemId));
  if (!row) return;
  await publishNotification(
    db as Db,
    {
      kind: "support.request",
      projectId: row.projectId,
      requestCode: `${row.code}-R${row.number}`,
      title: row.title,
      customerName: row.customerName,
      url: `${root(publicUrl)}/app/#/p/${row.code}/requests?request=${itemId}`,
    },
    { projectId: row.projectId },
  );
}

/** Quanto testo del cliente entra nella card (contenuto non fidato, solo mostrato). */
const EXCERPT = 140;

/**
 * `support.customer_replied`: un messaggio del cliente su una conversazione con
 * un ESITO (F3-5 = a: durante il triage risponde l'AI del widget). A chi segue
 * la conversazione da obbligatorio (`follows_conversation`), agli iscritti dal
 * catalogo. Restituisce se la conversazione ha un esito.
 */
export async function publishCustomerRepliedAlert(
  db: DbOrTx,
  publicUrl: string | null | undefined,
  conversationId: string,
  text: string,
): Promise<boolean> {
  const [c] = await db
    .select({ projectId: widgetConversations.projectId, number: widgetConversations.number, customerName: widgetConversations.externalUserName, code: projects.code })
    .from(widgetConversations)
    .innerJoin(projects, eq(projects.id, widgetConversations.projectId))
    .where(eq(widgetConversations.id, conversationId));
  if (!c) return false;
  const [request] = await db.select({ id: backlogItems.id }).from(backlogItems).where(eq(backlogItems.supportConversationId, conversationId)).limit(1);
  const [ticket] = request
    ? [undefined]
    : await db
        .select({ id: widgetMessages.id })
        .from(widgetMessages)
        .where(and(eq(widgetMessages.conversationId, conversationId), isNotNull(widgetMessages.ticketId)))
        .limit(1);
  if (!request && !ticket) return false;
  const followers = await db.select({ userId: supportFollowers.userId }).from(supportFollowers).where(eq(supportFollowers.conversationId, conversationId));
  const code = `${c.code}-S${c.number}`;
  const flat = text.replace(/\s+/g, " ").trim();
  await publishNotification(
    db as Db,
    {
      kind: "support.customer_replied",
      projectId: c.projectId,
      conversationCode: code,
      customerName: c.customerName,
      title: flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat,
      url: `${root(publicUrl)}/app/#/p/${c.code}/support/${code}`,
    },
    { projectId: c.projectId, mandatory: followers.map((f) => ({ userId: f.userId, reason: "follows_conversation" as const })) },
  );
  return true;
}
