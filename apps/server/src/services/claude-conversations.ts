import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { agentSessionEvents, agentSessionInputs, agentSessions, claudeConversations, users, type Db } from "@stubwise/db";
import {
  AGENT_SESSION_INPUT_CHANNEL,
  CLAUDE_CONVERSATION_CLOSED_CHANNEL,
  conversationTitleFrom,
  type ClaudeConversation,
  type ClaudeConversationContext,
  type ClaudeConversationDetail,
  type ClaudeVisibilityConfirmation,
  type CreateClaudeConversationInput,
  type PatchClaudeConversationInput,
  type SetClaudeConversationVisibilityInput,
} from "@stubwise/shared";
import { visibleProjectIds } from "../auth/access.js";
import {
  canReadPublic,
  contextProjectId,
  hasToolReads,
  holdOf,
  nextEventId,
  projectViews,
  projectViewsForAuthor,
  touchedProjectIds,
} from "./claude-public.js";
import { personName } from "./people.js";
import { freeSessionStates, loadAgentSession, monthlyBudgetExhausted, type SessionViewer } from "./agent-sessions.js";

// La conversazione libera con Claude (chat, fetta 1): una sessione dell'agente
// di kind `free`, a turni, PRIVATA del suo autore. Qui ciò che la sessione non
// ha (titolo, archivio, contesto); messaggi, eventi e stream passano dalle
// rotte delle sessioni (`/api/agent-sessions/:id/…`), con le loro regole. Ogni
// lettura e scrittura filtra per autore nella WHERE: una conversazione di un
// altro risponde come una che non esiste.

type ConversationRow = typeof claudeConversations.$inferSelect;
type SessionView = { state: ClaudeConversation["state"]; lastEventAt: string | null };

async function namesOf(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((id): id is string => id !== null))];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, personName(r)]));
}

/**
 * La conversazione come la vede CHI GUARDA (fetta 5): l'autore ha tutto; un
 * lettore di una pubblica non ha il seguito privato, i progetti che non vede
 * né il contesto di un progetto che non vede, e nessun comando dell'autore.
 */
async function toView(db: Db, viewer: SessionViewer, row: ConversationRow, session: SessionView): Promise<ClaudeConversation> {
  const isOwner = row.ownerId === viewer.id;
  const archived = row.archivedAt !== null;
  const names = await namesOf(db, [row.ownerId, row.publishedBy]);
  const hold = await holdOf(db, row);
  let context = (row.contextRef as ClaudeConversationContext | null) ?? null;
  if (context && !isOwner) {
    const projectId = await contextProjectId(db, row);
    const visible = projectId ? await visibleProjectIds(db, viewer) : [];
    if (!projectId || (visible !== "all" && !visible.includes(projectId))) context = null;
  }
  const continuesFrom = row.continuesFromSessionId
    ? { id: row.continuesFromSessionId, available: (await readableRow(db, viewer, row.continuesFromSessionId)) !== null }
    : null;
  return {
    id: row.sessionId,
    title: row.title,
    archived,
    context,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: session.state,
    lastEventAt: session.lastEventAt,
    visibility: row.visibility,
    author: { id: row.ownerId, name: names.get(row.ownerId) ?? "" },
    isOwner,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedBy ? { id: row.publishedBy, name: names.get(row.publishedBy) ?? "" } : null,
    publishedProjects: row.visibility === "public" ? await projectViews(db, viewer, row.publishedProjectIds) : [],
    privateTail: !isOwner && hold.held,
    heldProjects: isOwner && hold.newProjectIds.length > 0 ? await projectViews(db, viewer, hold.newProjectIds) : [],
    continuesFrom,
    canPublish: isOwner && !archived,
    canContinue: !isOwner && row.visibility === "public" && !archived && canReadPublic(viewer),
  } satisfies ClaudeConversation;
}

async function ownRow(db: Db, viewer: SessionViewer, id: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(claudeConversations)
    .where(and(eq(claudeConversations.sessionId, id), eq(claudeConversations.ownerId, viewer.id)));
  return row ?? null;
}

/**
 * Una conversazione che chi guarda può LEGGERE: la propria, o una pubblica
 * con `claude.public.view` (fetta 5). Ogni altra è `null`, come una che non
 * esiste: la stessa regola di `visibleTo` nella WHERE.
 */
export async function readableRow(db: Db, viewer: SessionViewer, id: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(claudeConversations)
    .where(
      and(
        eq(claudeConversations.sessionId, id),
        canReadPublic(viewer)
          ? or(eq(claudeConversations.ownerId, viewer.id), eq(claudeConversations.visibility, "public"))
          : eq(claudeConversations.ownerId, viewer.id),
      ),
    );
  return row ?? null;
}

/** Il dettaglio: la conversazione e la sua sessione; di un altro (o inesistente) `null`. */
export async function getClaudeConversation(
  db: Db,
  viewer: SessionViewer,
  id: string,
): Promise<ClaudeConversationDetail | null> {
  const row = await readableRow(db, viewer, id);
  if (!row) return null;
  const loaded = await loadAgentSession(db, viewer, id);
  if (!loaded) return null;
  return { ...(await toView(db, viewer, row, loaded.detail)), session: loaded.detail };
}

/** Quante per pagina, al più (`limit`). */
export const CONVERSATION_PAGE_MAX = 100;

/**
 * Le conversazioni di chi guarda, dalla più recente, attive o archiviate, a
 * pagine: `before` è il cursore della pagina prima (`updatedAt|id`
 * dell'ultima). Due query in tutto, qualunque sia la pagina: le righe e lo
 * stato delle loro sessioni (`freeSessionStates`).
 */
export async function listClaudeConversations(
  db: Db,
  viewer: SessionViewer,
  opts: { archived: boolean; limit?: number; before?: string; scope?: "mine" | "public" },
): Promise<{ items: ClaudeConversation[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), CONVERSATION_PAGE_MAX);
  const cursor = parseCursor(opts.before);
  // «Public» (fetta 5): le pubbliche di ALTRI, non archiviate, con il permesso.
  const publicScope = opts.scope === "public";
  if (publicScope && !canReadPublic(viewer)) return { items: [], nextCursor: null };
  const rows = await db
    .select()
    .from(claudeConversations)
    .where(
      and(
        publicScope
          ? and(eq(claudeConversations.visibility, "public"), ne(claudeConversations.ownerId, viewer.id))
          : eq(claudeConversations.ownerId, viewer.id),
        publicScope || !opts.archived ? isNull(claudeConversations.archivedAt) : isNotNull(claudeConversations.archivedAt),
        cursor
          ? or(
              lt(claudeConversations.updatedAt, cursor.at),
              and(eq(claudeConversations.updatedAt, cursor.at), lt(claudeConversations.sessionId, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(claudeConversations.updatedAt), desc(claudeConversations.sessionId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const states = await freeSessionStates(db, viewer, page.map((r) => r.sessionId));
  const items: ClaudeConversation[] = [];
  for (const row of page) {
    const session = states.get(row.sessionId);
    if (session) items.push(await toView(db, viewer, row, session));
  }
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? `${last.updatedAt.toISOString()}|${last.sessionId}` : null,
  };
}

function parseCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split("|");
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) && id ? { at: date, id } : null;
}

export type CreateClaudeConversationResult =
  | { ok: true; conversation: ClaudeConversation }
  | { ok: false; error: "budget_exhausted" };

/**
 * Una conversazione nuova: la sessione `free`, la sua riga e, col primo
 * messaggio, il primo turno (un input `pending` che lo scheduler del worker
 * prende). Col budget del mese finito non nasce niente.
 */
export async function createClaudeConversation(
  db: Db,
  viewer: SessionViewer,
  input: CreateClaudeConversationInput,
): Promise<CreateClaudeConversationResult> {
  if (await monthlyBudgetExhausted(db)) return { ok: false, error: "budget_exhausted" };
  const title = input.title ?? (input.message ? conversationTitleFrom(input.message) : "");
  const id = await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(agentSessions)
      .values({ ownerKey: `free:${randomUUID()}`, kind: "free", title })
      .returning({ id: agentSessions.id });
    await tx.insert(claudeConversations).values({
      sessionId: session!.id,
      ownerId: viewer.id,
      title,
      contextRef: input.context ?? null,
    });
    if (input.message) {
      await tx
        .insert(agentSessionInputs)
        .values({ sessionId: session!.id, authorUserId: viewer.id, text: input.message, interrupt: false });
      // Al commit: lo scheduler del worker non cerca mai un input che non esiste ancora.
      await tx.execute(
        sql`select pg_notify(${AGENT_SESSION_INPUT_CHANNEL}, ${JSON.stringify({ sessionId: session!.id })})`,
      );
    }
    return session!.id;
  });
  const created = await getClaudeConversation(db, viewer, id);
  return { ok: true, conversation: created! };
}

/** Titolo, archivio, contesto. Archiviarla ferma il turno in corso (il worker lo ascolta). */
export async function patchClaudeConversation(
  db: Db,
  viewer: SessionViewer,
  id: string,
  patch: PatchClaudeConversationInput,
): Promise<ClaudeConversation | null> {
  const row = await ownRow(db, viewer, id);
  if (!row) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(claudeConversations)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? (row.archivedAt ?? new Date()) : null } : {}),
        ...(patch.context !== undefined ? { contextRef: patch.context } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(claudeConversations.sessionId, id));
    if (patch.archived === true && row.archivedAt === null) await notifyClosed(tx, id);
  });
  const updated = await getClaudeConversation(db, viewer, id);
  if (!updated) return null;
  const { session: _session, ...view } = updated;
  void _session;
  return view;
}

/** Eliminare la porta via intera (sessione, eventi, messaggi: CASCADE) e ferma il turno in corso. */
export async function deleteClaudeConversation(db: Db, viewer: SessionViewer, id: string): Promise<boolean> {
  const row = await ownRow(db, viewer, id);
  if (!row) return false;
  await db.transaction(async (tx) => {
    await notifyClosed(tx, id);
    await tx.delete(agentSessions).where(eq(agentSessions.id, id));
  });
  return true;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function notifyClosed(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${CLAUDE_CONVERSATION_CLOSED_CHANNEL}, ${JSON.stringify({ sessionId })})`);
}

export type SetVisibilityResult =
  | { ok: true; conversation: ClaudeConversation }
  | { ok: false; error: "not_found" | "archived" }
  | { ok: false; error: "needs_confirmation"; confirmation: ClaudeVisibilityConfirmation };

const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * «Make public» / «Make private» e la riconferma del seguito privato (fetta
 * 5): solo l'autore. Pubblicare vuole i progetti letti o toccati CONFERMATI,
 * cioè lo stesso insieme di adesso (D2): un elenco diverso o vecchio è
 * `needs_confirmation`, con l'elenco e il fatto che chi legge vedrà anche ciò
 * che Claude ha letto per l'autore (D1). Su una pubblica col seguito privato,
 * la conferma dei progetti NUOVI lo rilascia. «Make private» azzera tutto, e
 * la finestra della potatura riparte da adesso (D5).
 */
export async function setClaudeConversationVisibility(
  db: Db,
  viewer: SessionViewer,
  id: string,
  input: SetClaudeConversationVisibilityInput,
): Promise<SetVisibilityResult> {
  const row = await ownRow(db, viewer, id);
  if (!row) return { ok: false, error: "not_found" };
  if (input.visibility === "private") {
    await db
      .update(claudeConversations)
      .set({
        visibility: "private",
        publishedAt: null,
        publishedBy: null,
        publishedProjectIds: [],
        privateFromEventId: null,
        visibilityChangedAt: sql`now()`,
      })
      .where(eq(claudeConversations.sessionId, id));
    return { ok: true, conversation: (await viewOf(db, viewer, id))! };
  }
  if (row.archivedAt !== null) return { ok: false, error: "archived" };
  const confirmed = input.confirmedProjectIds ?? [];
  const needs = async (ids: Iterable<string>, reconfirm: boolean): Promise<SetVisibilityResult> => ({
    ok: false,
    error: "needs_confirmation",
    confirmation: {
      code: "needs_confirmation",
      message: "Confirm the projects Claude read or touched",
      projects: await projectViewsForAuthor(db, ids),
      includesToolReads: await hasToolReads(db, id),
      reconfirm,
    },
  });
  if (row.visibility === "public") {
    // La riconferma: solo i progetti NUOVI del seguito privato.
    const hold = await holdOf(db, row);
    if (hold.newProjectIds.length === 0) return { ok: true, conversation: (await viewOf(db, viewer, id))! };
    if (!sameSet(confirmed, hold.newProjectIds)) return needs(hold.newProjectIds, true);
    await db
      .update(claudeConversations)
      .set({ publishedProjectIds: [...new Set([...row.publishedProjectIds, ...hold.newProjectIds])] })
      .where(eq(claudeConversations.sessionId, id));
    return { ok: true, conversation: (await viewOf(db, viewer, id))! };
  }
  const touched = await touchedProjectIds(db, row);
  // La conferma è sempre ESPLICITA, anche con un elenco vuoto: dice anche che
  // chi legge vedrà ciò che Claude ha letto per te (D1).
  if (input.confirmedProjectIds === undefined || !sameSet(confirmed, touched)) return needs(touched, false);
  // Un turno in corso alla pubblicazione resta privato finché non è finito.
  const open = await currentTurnStart(db, id);
  await db
    .update(claudeConversations)
    .set({
      visibility: "public",
      publishedAt: sql`now()`,
      publishedBy: viewer.id,
      publishedProjectIds: [...touched],
      privateFromEventId: open,
      visibilityChangedAt: sql`now()`,
    })
    .where(eq(claudeConversations.sessionId, id));
  return { ok: true, conversation: (await viewOf(db, viewer, id))! };
}

/** L'inizio del turno in corso (l'ultimo `input` senza `turn_end`, o un messaggio in coda); null se nessuno. */
async function currentTurnStart(db: Db, sessionId: string): Promise<bigint | null> {
  const [pending] = await db
    .select({ id: agentSessionInputs.id })
    .from(agentSessionInputs)
    .where(and(eq(agentSessionInputs.sessionId, sessionId), eq(agentSessionInputs.status, "pending")))
    .limit(1);
  if (pending) return nextEventId(db);
  const [last] = await db
    .select({ id: agentSessionEvents.id, type: agentSessionEvents.type })
    .from(agentSessionEvents)
    .where(and(eq(agentSessionEvents.sessionId, sessionId), inArray(agentSessionEvents.type, ["input", "turn_end"])))
    .orderBy(desc(agentSessionEvents.id))
    .limit(1);
  return last?.type === "input" ? last.id : null;
}

async function viewOf(db: Db, viewer: SessionViewer, id: string): Promise<ClaudeConversation | null> {
  const detail = await getClaudeConversation(db, viewer, id);
  if (!detail) return null;
  const { session: _session, ...view } = detail;
  void _session;
  return view;
}
