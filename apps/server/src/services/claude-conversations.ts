import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { agentSessionInputs, agentSessions, claudeConversations, type Db } from "@stubwise/db";
import {
  AGENT_SESSION_INPUT_CHANNEL,
  CLAUDE_CONVERSATION_CLOSED_CHANNEL,
  conversationTitleFrom,
  type ClaudeConversation,
  type ClaudeConversationContext,
  type ClaudeConversationDetail,
  type CreateClaudeConversationInput,
  type PatchClaudeConversationInput,
} from "@stubwise/shared";
import { freeSessionStates, loadAgentSession, monthlyBudgetExhausted, type SessionViewer } from "./agent-sessions.js";

// La conversazione libera con Claude (chat, fetta 1): una sessione dell'agente
// di kind `free`, a turni, PRIVATA del suo autore. Qui ciò che la sessione non
// ha (titolo, archivio, contesto); messaggi, eventi e stream passano dalle
// rotte delle sessioni (`/api/agent-sessions/:id/…`), con le loro regole. Ogni
// lettura e scrittura filtra per autore nella WHERE: una conversazione di un
// altro risponde come una che non esiste.

type ConversationRow = typeof claudeConversations.$inferSelect;

function toView(row: ConversationRow, session: { state: ClaudeConversation["state"]; lastEventAt: string | null }) {
  return {
    id: row.sessionId,
    title: row.title,
    archived: row.archivedAt !== null,
    context: (row.contextRef as ClaudeConversationContext | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: session.state,
    lastEventAt: session.lastEventAt,
  } satisfies ClaudeConversation;
}

async function ownRow(db: Db, viewer: SessionViewer, id: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(claudeConversations)
    .where(and(eq(claudeConversations.sessionId, id), eq(claudeConversations.ownerId, viewer.id)));
  return row ?? null;
}

/** Il dettaglio: la conversazione e la sua sessione; di un altro (o inesistente) `null`. */
export async function getClaudeConversation(
  db: Db,
  viewer: SessionViewer,
  id: string,
): Promise<ClaudeConversationDetail | null> {
  const row = await ownRow(db, viewer, id);
  if (!row) return null;
  const loaded = await loadAgentSession(db, viewer, id);
  if (!loaded) return null;
  return { ...toView(row, loaded.detail), session: loaded.detail };
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
  opts: { archived: boolean; limit?: number; before?: string },
): Promise<{ items: ClaudeConversation[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), CONVERSATION_PAGE_MAX);
  const cursor = parseCursor(opts.before);
  const rows = await db
    .select()
    .from(claudeConversations)
    .where(
      and(
        eq(claudeConversations.ownerId, viewer.id),
        opts.archived ? isNotNull(claudeConversations.archivedAt) : isNull(claudeConversations.archivedAt),
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
  const items = page.flatMap((row) => {
    const session = states.get(row.sessionId);
    return session ? [toView(row, session)] : [];
  });
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
