import { backlogItems, backlogItemTickets, projects, widgetConversations, widgetMessages, widgets, type Db } from "@stubwise/db";
import { CUSTOMER_STATUS_LABELS, customerStatus, type CustomerStatus, type SiteRequest, type SiteRequestDetail } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { parseSupportCode, taskFacts } from "./support.js";

/**
 * Area 8, «L'API per i siti» (S4, S4b; piano
 * docs/plans/2026-11-15-integrazione-area8-api-siti-plan.md): ciò che il
 * cliente FIRMATO dal sito vede delle sue richieste e dei suoi ticket. Le
 * regole stanno tutte nella stessa WHERE ({@link conversationsOf}), per
 * l'elenco E per il dettaglio:
 * - il widget autenticato (e il suo progetto): un `sub` è un id del SITO, e
 *   un altro widget, anche dello stesso progetto, è un altro sito;
 * - il canale `widget` (mai `mcp`, i collaboratori interni);
 * - `external_user_id = sub` e `identity_verified` (D-1);
 * - un esito, cioè una richiesta legata o un ticket aperto dal widget (D-7).
 * Ne escono le parole del cliente, il codice della SUA conversazione e lo
 * stato in parole. Mai titoli, codici interni, commenti o persone del team.
 */

type WidgetRow = typeof widgets.$inferSelect;
type ConversationRow = typeof widgetConversations.$inferSelect;

const LABEL_MAX = 140;
const MAX_MERGE_HOPS = 10;
const LIST_LIMIT = 50;

function labelOf(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

const languageOf = (widget: WidgetRow): "it" | "en" => (widget.language === "en" ? "en" : "it");

/**
 * Lo stato per il cliente di una conversazione, o null senza esito. Una
 * richiesta FUSA segue `merged_into_id` fino alla destinazione e ne prende
 * lo STATO; nient'altro della destinazione esce (può essere la richiesta di
 * un altro cliente).
 */
async function outcomeOf(db: Db, conversationId: string, ticketId: string | null): Promise<{ kind: "request" | "ticket"; status: CustomerStatus } | null> {
  const [item] = await db
    .select({ id: backlogItems.id, status: backlogItems.status, mergedIntoId: backlogItems.mergedIntoId })
    .from(backlogItems)
    .where(eq(backlogItems.supportConversationId, conversationId))
    .orderBy(asc(backlogItems.createdAt))
    .limit(1);
  if (item) {
    let current = item;
    for (let hop = 0; hop < MAX_MERGE_HOPS && current.mergedIntoId; hop++) {
      const [next] = await db
        .select({ id: backlogItems.id, status: backlogItems.status, mergedIntoId: backlogItems.mergedIntoId })
        .from(backlogItems)
        .where(eq(backlogItems.id, current.mergedIntoId));
      if (!next) break;
      current = next;
    }
    const links = await db
      .select({ ticketId: backlogItemTickets.ticketId })
      .from(backlogItemTickets)
      .where(and(eq(backlogItemTickets.itemId, current.id), eq(backlogItemTickets.role, "converted_to")));
    const facts = await taskFacts(db, links.map((l) => l.ticketId));
    return { kind: "request", status: customerStatus({ status: current.status, merged: current.mergedIntoId !== null }, facts.tasks, facts.releases) };
  }
  if (ticketId) {
    const facts = await taskFacts(db, [ticketId]);
    return { kind: "ticket", status: customerStatus(null, facts.tasks, facts.releases) };
  }
  return null;
}

/** Le conversazioni di quel cliente su quel widget: la WHERE unica delle regole. */
function conversationsOf(db: Db, widget: WidgetRow, sub: string, number?: number) {
  return db
    .select()
    .from(widgetConversations)
    .where(
      and(
        eq(widgetConversations.projectId, widget.projectId),
        eq(widgetConversations.widgetId, widget.id),
        eq(widgetConversations.channel, "widget"),
        eq(widgetConversations.externalUserId, sub),
        eq(widgetConversations.identityVerified, true),
        ...(number !== undefined ? [eq(widgetConversations.number, number)] : []),
      ),
    )
    .orderBy(desc(widgetConversations.createdAt), desc(widgetConversations.id));
}

/** I messaggi che il cliente può leggere: suoi e dell'AI del widget, mai con un autore del team. */
async function customerMessages(db: Db, conversationIds: readonly string[]) {
  if (conversationIds.length === 0) return [];
  return db
    .select({ conversationId: widgetMessages.conversationId, role: widgetMessages.role, content: widgetMessages.content, ticketId: widgetMessages.ticketId, createdAt: widgetMessages.createdAt })
    .from(widgetMessages)
    .where(and(inArray(widgetMessages.conversationId, [...conversationIds]), inArray(widgetMessages.role, ["user", "assistant"]), isNull(widgetMessages.authorId)))
    .orderBy(asc(widgetMessages.createdAt), asc(widgetMessages.id));
}

/** Il ticket aperto dal widget in una conversazione (il messaggio di conferma lo porta). */
async function ticketOf(db: Db, conversationId: string): Promise<string | null> {
  const [m] = await db
    .select({ ticketId: widgetMessages.ticketId })
    .from(widgetMessages)
    .where(and(eq(widgetMessages.conversationId, conversationId), isNotNull(widgetMessages.ticketId)))
    .orderBy(asc(widgetMessages.createdAt))
    .limit(1);
  return m?.ticketId ?? null;
}

async function rowOf(db: Db, widget: WidgetRow, projectCode: string, c: ConversationRow, firstWords: string | undefined): Promise<SiteRequest | null> {
  const outcome = await outcomeOf(db, c.id, await ticketOf(db, c.id));
  if (!outcome) return null;
  return {
    code: `${projectCode}-S${c.number}`,
    kind: outcome.kind,
    label: labelOf(firstWords),
    status: outcome.status,
    statusLabel: CUSTOMER_STATUS_LABELS[languageOf(widget)][outcome.status],
    openedAt: c.createdAt.toISOString(),
  };
}

async function projectCodeOf(db: Db, projectId: string): Promise<string> {
  const [p] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return p!.code;
}

export async function listSiteRequests(db: Db, widget: WidgetRow, sub: string): Promise<{ items: SiteRequest[]; total: number }> {
  const projectCode = await projectCodeOf(db, widget.projectId);
  const conversations = await conversationsOf(db, widget, sub);
  const messages = await customerMessages(db, conversations.map((c) => c.id));
  const firstWords = new Map<string, string>();
  for (const m of messages) if (m.role === "user" && !firstWords.has(m.conversationId)) firstWords.set(m.conversationId, m.content);
  const rows: SiteRequest[] = [];
  for (const c of conversations) {
    const row = await rowOf(db, widget, projectCode, c, firstWords.get(c.id));
    if (row) rows.push(row);
  }
  return { items: rows.slice(0, LIST_LIMIT), total: rows.length };
}

/**
 * Il dettaglio di UNA richiesta: il codice si cerca SOLO fra le conversazioni
 * di quel cliente. null per «non esiste», «non è tua», «non è verificata»,
 * «non ha un esito» o un codice malformato: la rotta ne fa lo stesso 404.
 */
export async function siteRequestDetail(db: Db, widget: WidgetRow, sub: string, code: string): Promise<SiteRequestDetail | null> {
  const parsed = parseSupportCode(code);
  if (!parsed) return null;
  const projectCode = await projectCodeOf(db, widget.projectId);
  if (parsed.projectCode !== projectCode) return null;
  const [c] = await conversationsOf(db, widget, sub, parsed.number);
  if (!c) return null;
  const messages = await customerMessages(db, [c.id]);
  const row = await rowOf(db, widget, projectCode, c, messages.find((m) => m.role === "user")?.content);
  if (!row) return null;
  return {
    ...row,
    messages: messages.map((m) => ({ from: m.role === "user" ? ("customer" as const) : ("assistant" as const), body: m.content, at: m.createdAt.toISOString() })),
  };
}
