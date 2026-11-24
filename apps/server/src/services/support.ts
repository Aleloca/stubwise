import {
  aiJobs,
  backlogItems,
  backlogJobs,
  backlogItemTickets,
  projects,
  releases,
  ticketRepositories,
  tickets,
  widgetConversations,
  widgetMessages,
  widgets,
  type Db,
} from "@stubwise/db";
import {
  customerStatus,
  supportState,
  SUPPORT_STATE_ORDER,
  type CustomerStatus,
  type ProjectPermission,
  type ReleaseStatusKind,
  type SupportConversation,
  type SupportCustomerPreview,
  type SupportMessage,
  type SupportSearchResult,
  type SupportState,
  type SupportStateInput,
} from "@stubwise/shared";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { inProjectsStrict, isAllProjects, projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { likeNeedle, releaseStatusById, SEARCH_LIMIT, SEARCH_MIN_CHARS } from "./releases.js";

/**
 * Support: le conversazioni coi clienti (area 8, F3, S2). Le vede chi vede il
 * progetto; un progetto invisibile risponde come una conversazione che non
 * esiste (R-G5). Lo stato si DERIVA (`supportState` di shared, coi fatti del
 * server: l'esito, il giudizio, i messaggi); ciò che chi guarda PUÒ fare lo
 * calcola qui, una volta, per la vista (il client legge, non deduce).
 *
 * Il ruolo dei messaggi: `user` = il cliente, `assistant` = l'AI del widget
 * (il triage), `team` = una persona (S3, solo canale `mcp`: al cliente del
 * widget il team non scrive mai, maintainer 14 nov 2026). Una conversazione
 * con un esito è CHIUSA: i messaggi dopo vanno nella successiva
 * (`continued_in_id`, S17).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type ConversationRow = typeof widgetConversations.$inferSelect;
type MessageRow = typeof widgetMessages.$inferSelect;

export class SupportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new SupportError(404, "not_found", "Not found");

const FROM: Record<string, SupportMessage["from"]> = { user: "customer", assistant: "triage", team: "team" };

/** Il codice `<PRJ>-S<n>`: progetto e numero; null se non ha quella forma. */
export function parseSupportCode(code: string): { projectCode: string; number: number } | null {
  const m = /^([A-Z][A-Z0-9]{1,9})-S(\d{1,9})$/.exec(code.trim().toUpperCase());
  return m ? { projectCode: m[1]!, number: Number(m[2]) } : null;
}

function messageOf(m: MessageRow, showAuthor: boolean): SupportMessage {
  const from = FROM[m.role] ?? "triage";
  return { id: m.id, from, authorId: from === "team" && showAuthor ? m.authorId : null, body: m.content, at: m.createdAt.toISOString() };
}

/** I fatti per lo stato per il cliente di una task: chiusa, Claude al lavoro, i rilasci delle sue PR. */
/** I fatti delle task che decidono lo stato per il cliente. Esportata per l'API per i siti (area 8). */
export async function taskFacts(db: Db, ticketIds: readonly string[]): Promise<{ tasks: { closed: boolean; claudeActive: boolean }[]; releases: ReleaseStatusKind[] }> {
  if (ticketIds.length === 0) return { tasks: [], releases: [] };
  const rows = await db.select({ id: tickets.id, closedAt: tickets.closedAt }).from(tickets).where(inArray(tickets.id, [...ticketIds]));
  const jobs = await db.selectDistinct({ ticketId: aiJobs.ticketId }).from(aiJobs).where(inArray(aiJobs.ticketId, [...ticketIds]));
  const withJob = new Set(jobs.map((j) => j.ticketId));
  const prs = await db
    .select({ repositoryId: ticketRepositories.repositoryId, prNumber: ticketRepositories.prNumber })
    .from(ticketRepositories)
    .where(and(inArray(ticketRepositories.ticketId, [...ticketIds]), isNotNull(ticketRepositories.prNumber)));
  const kinds: ReleaseStatusKind[] = [];
  for (const pr of prs) {
    const found = await db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.repositoryId, pr.repositoryId), eq(releases.prNumber, pr.prNumber!)));
    for (const r of found) {
      const status = await releaseStatusById(db, r.id);
      if (status) kinds.push(status.kind);
    }
  }
  return { tasks: rows.map((r) => ({ closed: r.closedAt !== null, claudeActive: withJob.has(r.id) })), releases: kinds };
}

interface Outcome {
  request: SupportConversation["request"];
  task: SupportConversation["task"];
}

/** L'esito di una conversazione: la richiesta legata e/o il ticket aperto dal widget, coi loro stati per il cliente. */
async function outcomeOf(db: Db, c: ConversationRow, projectCode: string, ticketId: string | null): Promise<Outcome> {
  let request: Outcome["request"] = null;
  const [item] = await db
    .select({ id: backlogItems.id, number: backlogItems.number, title: backlogItems.title, originContent: backlogItems.originContent, document: backlogItems.document, status: backlogItems.status, mergedIntoId: backlogItems.mergedIntoId })
    .from(backlogItems)
    .where(
      // La voce legata; per il canale `mcp` anche quella su cui è finito il suo
      // job d'intake (una richiesta FUSA in una che c'era non si lega: review F3).
      c.channel === "mcp" && c.intakeJobId
        ? or(
            eq(backlogItems.supportConversationId, c.id),
            eq(backlogItems.id, sql`(select ${backlogJobs.resultItemId} from ${backlogJobs} where ${backlogJobs.id} = ${c.intakeJobId})`),
          )
        : eq(backlogItems.supportConversationId, c.id),
    )
    .orderBy(asc(backlogItems.createdAt))
    .limit(1);
  if (item) {
    const links = await db.select({ ticketId: backlogItemTickets.ticketId }).from(backlogItemTickets).where(and(eq(backlogItemTickets.itemId, item.id), eq(backlogItemTickets.role, "converted_to")));
    const facts = await taskFacts(db, links.map((l) => l.ticketId));
    request = {
      id: item.id,
      code: `${projectCode}-R${item.number}`,
      title: item.title,
      description: item.originContent ?? item.document,
      status: item.status,
      customerStatus: customerStatus({ status: item.status, merged: item.mergedIntoId !== null }, facts.tasks, facts.releases) as CustomerStatus,
    };
  }
  let task: Outcome["task"] = null;
  if (ticketId) {
    const [t] = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId));
    if (t) {
      const facts = await taskFacts(db, [t.id]);
      task = { id: t.id, code: `${projectCode}-${t.number}`, title: t.title, customerStatus: customerStatus(null, facts.tasks, facts.releases) as CustomerStatus };
    }
  }
  return { request, task };
}

function stateInput(c: ConversationRow, messages: readonly SupportMessage[], hasOutcome: boolean): SupportStateInput {
  return {
    hasOutcome,
    judgment: c.triageOutcome && c.triageOutcomeAt ? { outcome: c.triageOutcome, at: c.triageOutcomeAt.toISOString() } : null,
    messages: messages.map((m) => ({ from: m.from, at: m.at })),
  };
}

interface ViewContext {
  viewer: Viewer;
  permissions: ReadonlySet<ProjectPermission>;
  projectCode: string;
}

/** Il codice di una conversazione dello stesso progetto, per id. */
async function codeOf(db: Db, projectCode: string, id: string | null): Promise<{ code: string } | null> {
  if (!id) return null;
  const [r] = await db.select({ number: widgetConversations.number }).from(widgetConversations).where(eq(widgetConversations.id, id));
  return r ? { code: `${projectCode}-S${r.number}` } : null;
}

/** La vista di UNA conversazione per chi guarda; `withMessages` = il dettaglio (l'elenco porta solo l'ultimo). */
async function viewOf(db: Db, c: ConversationRow, ctx: ViewContext, withMessages: boolean): Promise<SupportConversation> {
  const rows = await db.select().from(widgetMessages).where(eq(widgetMessages.conversationId, c.id)).orderBy(asc(widgetMessages.createdAt), asc(widgetMessages.id));
  const messages = rows.map((m) => messageOf(m, true));
  const ticketId = rows.find((m) => m.ticketId !== null)?.ticketId ?? null;
  const outcome = await outcomeOf(db, c, ctx.projectCode, ticketId);
  const input = stateInput(c, messages, outcome.request !== null || outcome.task !== null);
  const state = supportState(input) as SupportState;
  const manage = ctx.permissions.has("support.manage");
  const [widget] = c.widgetId ? await db.select({ name: widgets.name }).from(widgets).where(eq(widgets.id, c.widgetId)) : [];
  const [previous] = await db.select({ id: widgetConversations.id }).from(widgetConversations).where(eq(widgetConversations.continuedInId, c.id)).limit(1);
  return {
    id: c.id,
    code: `${ctx.projectCode}-S${c.number}`,
    projectId: c.projectId,
    projectCode: ctx.projectCode,
    channel: c.channel,
    widgetId: c.widgetId,
    widgetName: widget?.name ?? null,
    customer: { name: c.externalUserName, email: c.externalUserEmail },
    identityVerified: c.identityVerified,
    messages: withMessages ? messages : [],
    lastMessage: messages.at(-1) ?? null,
    state,
    rewrittenWish: null,
    confirmedAt: null,
    triage:
      c.triageOutcome && c.triageOutcomeAt
        ? { outcome: c.triageOutcome, at: c.triageOutcomeAt.toISOString(), byUserId: c.triageOutcomeByUserId }
        : null,
    request: outcome.request,
    task: outcome.task,
    canOpenRequest: state === "not_concluded" && manage && ctx.permissions.has("backlog.create"),
    canMarkNotConcluded: state === "answered" && manage,
    canReplyToCollaborator: c.channel === "mcp" && manage,
    continuedIn: await codeOf(db, ctx.projectCode, c.continuedInId),
    continuedFrom: await codeOf(db, ctx.projectCode, previous?.id ?? null),
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}

/** L'ordine dell'elenco: per gruppo, e nel gruppo la più recente. */
function byGroup(a: SupportConversation, b: SupportConversation): number {
  const ga = SUPPORT_STATE_ORDER.indexOf(a.state as SupportState);
  const gb = SUPPORT_STATE_ORDER.indexOf(b.state as SupportState);
  if (ga !== gb) return ga - gb;
  return b.lastMessageAt.localeCompare(a.lastMessageAt) || a.code.localeCompare(b.code);
}

async function projectCodeOf(db: Db, projectId: string): Promise<string> {
  const [p] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw notFound();
  return p.code;
}

/**
 * Le conversazioni di un progetto, raggruppate per stato. Lo stato si deriva,
 * quindi il filtro per stato si applica dopo (nessuna paginazione: 0–80 per
 * progetto, shape support §5).
 */
export async function listSupportConversations(db: Db, viewer: Viewer, projectId: string, filter: { state?: string } = {}): Promise<SupportConversation[]> {
  const permissions = await projectPermissionsFor(db, viewer, projectId);
  if (!permissions) throw notFound();
  const ctx: ViewContext = { viewer, permissions, projectCode: await projectCodeOf(db, projectId) };
  const rows = await db.select().from(widgetConversations).where(eq(widgetConversations.projectId, projectId)).orderBy(desc(widgetConversations.lastMessageAt));
  const views: SupportConversation[] = [];
  for (const c of rows) {
    const v = await viewOf(db, c, ctx, false);
    if (!filter.state || v.state === filter.state) views.push(v);
  }
  return views.sort(byGroup);
}

/**
 * ⌘K (rimandi, lotto 5): le conversazioni per codice o cliente (nome o
 * email), SOLO nei progetti che chi cerca vede (filtro nella WHERE, come
 * l'elenco); dalla più recente, al più {@link SEARCH_LIMIT}. Lo stato è
 * quello derivato dell'elenco.
 */
export async function searchSupport(db: Db, viewer: Viewer, q: string): Promise<SupportSearchResult[]> {
  if (q.trim().length < SEARCH_MIN_CHARS) return [];
  const scope = await visibleProjectIds(db, viewer);
  if (!isAllProjects(scope) && scope.length === 0) return [];
  const needle = likeNeedle(q);
  const rows = await db
    .select({ c: widgetConversations, projectCode: projects.code })
    .from(widgetConversations)
    .innerJoin(projects, eq(projects.id, widgetConversations.projectId))
    .where(
      and(
        inProjectsStrict(widgetConversations.projectId, scope),
        or(
          sql`(${projects.code} || '-S' || ${widgetConversations.number}) ilike ${needle}`,
          ilike(widgetConversations.externalUserName, needle),
          ilike(widgetConversations.externalUserEmail, needle),
        ),
      ),
    )
    .orderBy(desc(widgetConversations.lastMessageAt))
    .limit(SEARCH_LIMIT);
  const perms = new Map<string, Awaited<ReturnType<typeof projectPermissionsFor>>>();
  const out: SupportSearchResult[] = [];
  for (const { c, projectCode } of rows) {
    if (!perms.has(c.projectId)) perms.set(c.projectId, await projectPermissionsFor(db, viewer, c.projectId));
    const permissions = perms.get(c.projectId);
    if (!permissions) continue;
    const view = await viewOf(db, c, { viewer, permissions, projectCode }, false);
    out.push({ kind: "support", id: c.id, code: view.code, label: c.externalUserName ?? c.externalUserEmail ?? view.code, projectId: c.projectId, projectCode, state: view.state });
  }
  return out;
}

/** La riga e il contesto di una conversazione per codice; 404 se non c'è o il progetto non si vede. */
export async function conversationByCode(db: Db, viewer: Viewer, code: string): Promise<{ row: ConversationRow; ctx: ViewContext }> {
  const parsed = parseSupportCode(code);
  if (!parsed) throw notFound();
  const [found] = await db
    .select({ c: widgetConversations, projectCode: projects.code })
    .from(widgetConversations)
    .innerJoin(projects, eq(projects.id, widgetConversations.projectId))
    .where(and(eq(projects.code, parsed.projectCode), eq(widgetConversations.number, parsed.number)));
  if (!found) throw notFound();
  const permissions = await projectPermissionsFor(db, viewer, found.c.projectId);
  if (!permissions) throw notFound();
  return { row: found.c, ctx: { viewer, permissions, projectCode: found.projectCode } };
}

/** Il dettaglio di una conversazione, coi messaggi. */
export async function getSupportConversation(db: Db, viewer: Viewer, code: string): Promise<SupportConversation> {
  const { row, ctx } = await conversationByCode(db, viewer, code);
  return viewOf(db, row, ctx, true);
}

/** La vista aggiornata di una conversazione già trovata (per le scritture). */
export async function supportView(db: Db, row: ConversationRow, ctx: ViewContext): Promise<SupportConversation> {
  const [fresh] = await db.select().from(widgetConversations).where(eq(widgetConversations.id, row.id));
  return viewOf(db, fresh ?? row, ctx, true);
}

/**
 * «Anteprima del cliente»: ESATTAMENTE ciò che vede lui. I messaggi come
 * `customer` / `us` (il triage, e sul canale `mcp` il team, sono «noi»: mai
 * un nome, una stima, un commento), e lo stato in parole.
 */
export async function supportCustomerPreview(db: Db, viewer: Viewer, code: string): Promise<SupportCustomerPreview> {
  const { row, ctx } = await conversationByCode(db, viewer, code);
  const rows = await db.select().from(widgetMessages).where(eq(widgetMessages.conversationId, row.id)).orderBy(asc(widgetMessages.createdAt), asc(widgetMessages.id));
  const ticketId = rows.find((m) => m.ticketId !== null)?.ticketId ?? null;
  const outcome = await outcomeOf(db, row, ctx.projectCode, ticketId);
  return {
    status: (outcome.request?.customerStatus ?? outcome.task?.customerStatus ?? "received") as SupportCustomerPreview["status"],
    messages: rows.map((m) => ({ from: m.role === "user" ? ("customer" as const) : ("us" as const), body: m.content, at: m.createdAt.toISOString() })),
  };
}
