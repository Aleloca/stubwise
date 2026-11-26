import { agentSessionEvents, claudeConversations, claudeTurnCitations, docPageCodes, type Db } from "@stubwise/db";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ChatViewer } from "../chat/access.js";
import { citeablesByCode, citeablesFor, codesIn } from "../chat/citations.js";

/**
 * Lotto 9, voce 1: le CITAZIONI dei messaggi di Claude (Chat r.64, A10
 * r.1396; sblocca r.60, i codici nella prosa).
 *
 * - Si registra ciò che Claude ha LETTO col token del turno, mai ciò che dice
 *   di aver letto: è un fatto del server, come il registro decisioni. L'hook
 *   `onSend` di una lettura riuscita (`recordChatToolCitations`) scrive
 *   `{kind, id}` in `claude_turn_citations`. FAIL-OPEN (vincolo di 46): un
 *   errore non tocca mai la lettura, lascia una riga nel log.
 * - I codici nella PROSA non si registrano: a lettura si estraggono dagli
 *   `assistant_text` del turno (`citeablesFromCodes`, la regola della Chat).
 * - A LETTURA le citazioni di un turno vanno sul suo `turn_end`
 *   (`data.citations`), filtrate per CHI GUARDA (`citeablesFor`, la stessa
 *   visibilità della Chat): un riferimento che non vede si TOGLIE (scelta
 *   (a) di 46, come i contesti), anche all'autore. Eccezione R-H5, solo
 *   all'autore: un file del Drive che non vede più resta col suo codice.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CitationKind = "task" | "request" | "project" | "doc" | "drive";
export interface TurnCitationRef {
  kind: CitationKind;
  id: string;
  /** Solo un file del Drive che l'AUTORE non vede più (R-H5): il codice che aveva. */
  code?: string;
}

/** Gli oggetti di una lettura del token del turno (la rotta, i parametri, la risposta). */
export function citationsOfRead(route: string, params: Record<string, unknown>, body: unknown): { kind: CitationKind; id: string; code: string | null }[] {
  const out: { kind: CitationKind; id: string; code: string | null }[] = [];
  const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const id = typeof obj["id"] === "string" && UUID.test(obj["id"]) ? obj["id"] : null;
  if (route === "/api/tasks/by-code/:code" && id) out.push({ kind: "task", id, code: null });
  if (route === "/api/requests/by-code/:code" && id) out.push({ kind: "request", id, code: null });
  // Una pagina Docs si cita col suo CODICE (`doc_page_codes`, come la Chat): lo risolve chi registra.
  if (route === "/api/drive/files/by-code/:code/content" && id) out.push({ kind: "drive", id, code: typeof obj["code"] === "string" ? obj["code"] : null });
  if (typeof params["projectId"] === "string" && UUID.test(params["projectId"])) out.push({ kind: "project", id: params["projectId"], code: null });
  return out;
}

/** Hook `onSend`: registra ciò che il token del turno di una conversazione ha letto. Fail-open. */
export async function recordChatToolCitations(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<void> {
  const sessionId = request.user?.chatToolSessionId;
  if (sessionId === undefined || request.method !== "GET" || reply.statusCode !== 200) return;
  try {
    const route = request.routeOptions.url ?? "";
    const body = typeof payload === "string" && payload.length > 0 && payload.length < 5_000_000 ? (JSON.parse(payload) as unknown) : null;
    const params = (request.params ?? {}) as Record<string, unknown>;
    const refs = citationsOfRead(route, params, body);
    const db = request.server.db;
    if (route === "/api/repositories/:repositoryId/docs/pages/:slug" && typeof params["repositoryId"] === "string" && UUID.test(params["repositoryId"]) && typeof params["slug"] === "string") {
      const [code] = await db
        .select({ id: docPageCodes.id })
        .from(docPageCodes)
        .where(and(eq(docPageCodes.repositoryId, params["repositoryId"]), eq(docPageCodes.slug, params["slug"])));
      if (code) refs.push({ kind: "doc", id: code.id, code: null });
    }
    if (refs.length === 0) return;
    // Solo le conversazioni con Claude (la Chat ha le sue citazioni).
    const [conv] = await db.select({ id: claudeConversations.sessionId }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
    if (!conv) return;
    const [last] = await db.select({ id: agentSessionEvents.id }).from(agentSessionEvents).where(eq(agentSessionEvents.sessionId, sessionId)).orderBy(desc(agentSessionEvents.id)).limit(1);
    await db
      .insert(claudeTurnCitations)
      .values(refs.map((r) => ({ sessionId, kind: r.kind, refId: r.id, afterEventId: last?.id ?? 0n, code: r.code })))
      .onConflictDoNothing();
  } catch (error) {
    request.log.warn({ err: error }, "citazioni della lettura di Claude non registrate");
  }
}

/**
 * Le citazioni dei turni che finiscono con i `turn_end` dati, come le legge chi
 * guarda: le letture registrate del turno e i codici nella sua prosa, senza
 * doppioni, solo ciò che vede (eccezione R-H5 per l'autore).
 */
export async function turnCitationsFor(db: Db, viewer: ChatViewer, sessionId: string, turnEndIds: readonly bigint[], isAuthor: boolean): Promise<Map<bigint, TurnCitationRef[]>> {
  const out = new Map<bigint, TurnCitationRef[]>();
  if (turnEndIds.length === 0) return out;
  const maxId = turnEndIds.reduce((a, b) => (b > a ? b : a));
  // I confini dei turni: ogni `turn_end` della sessione fino al più recente della pagina.
  const ends = (
    await db
      .select({ id: agentSessionEvents.id })
      .from(agentSessionEvents)
      .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "turn_end"), lte(agentSessionEvents.id, maxId)))
      .orderBy(asc(agentSessionEvents.id))
  ).map((r) => r.id);
  const wanted = new Set(turnEndIds);
  const bounds = new Map<bigint, bigint>();
  ends.forEach((id, i) => {
    if (wanted.has(id)) bounds.set(id, i === 0 ? 0n : ends[i - 1]!);
  });
  if (bounds.size === 0) return out;
  const minFrom = [...bounds.values()].reduce((a, b) => (b < a ? b : a));
  const [reads, texts] = await Promise.all([
    db
      .select()
      .from(claudeTurnCitations)
      .where(and(eq(claudeTurnCitations.sessionId, sessionId), sql`${claudeTurnCitations.afterEventId} >= ${minFrom}`, sql`${claudeTurnCitations.afterEventId} < ${maxId}`))
      .orderBy(asc(claudeTurnCitations.createdAt)),
    db
      .select({ id: agentSessionEvents.id, data: agentSessionEvents.data })
      .from(agentSessionEvents)
      .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "assistant_text"), gt(agentSessionEvents.id, minFrom), lte(agentSessionEvents.id, maxId))),
  ]);
  const visible = await citeablesFor(db, viewer, reads.map((r) => ({ kind: r.kind, id: r.refId })));
  // Revisione 8–9 (I-3): la prosa di TUTTI i turni della pagina si risolve con
  // UNA chiamata; ogni turno prende i suoi codici da lì.
  const proseOf = (from: bigint, end: bigint) =>
    texts
      .filter((e) => e.id > from && e.id < end)
      .map((e) => (typeof e.data["text"] === "string" ? e.data["text"] : ""))
      .join("\n");
  const byCode = await citeablesByCode(db, viewer, [...bounds].map(([end, from]) => proseOf(from, end)).join("\n"));
  for (const [end, from] of bounds) {
    const refs: TurnCitationRef[] = [];
    const has = (kind: string, id: string) => refs.some((r) => r.kind === kind && r.id === id);
    for (const r of reads) {
      if (r.afterEventId < from || r.afterEventId >= end || has(r.kind, r.refId)) continue;
      const seen = visible.get(`${r.kind}:${r.refId}`);
      if (seen) refs.push({ kind: seen.kind as CitationKind, id: seen.id });
      else if (isAuthor && r.kind === "drive" && r.code) refs.push({ kind: "drive", id: r.refId, code: r.code });
    }
    for (const { code } of codesIn(proseOf(from, end))) {
      const c = byCode.get(code);
      if (c && c.kind !== "person" && !has(c.kind, c.id)) refs.push({ kind: c.kind as CitationKind, id: c.id });
    }
    out.set(end, refs);
  }
  return out;
}
