import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  claudeConversationProjects,
  claudeConversations,
  projects,
  roles,
  users,
  type Db,
} from "@stubwise/db";
import { effectiveInstancePermissions } from "@stubwise/shared";
import type { ClaudeConversationProject } from "@stubwise/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Le conversazioni PUBBLICHE con Claude (chat, fetta 5; piano
 * `docs/plans/2026-11-10-integrazione-claude-chat-f5-plan.md`). Il modulo
 * unico di ciò che decide il server per chi LEGGE una conversazione di un
 * altro: chi la vede, quali progetti Claude ha letto o toccato, il seguito
 * privato.
 *
 * - **Chi la vede**: l'autore; e, se è pubblica, chi ha `claude.public.view`
 *   (`publicConversationSql`, nella WHERE di `visibleTo`). Nessun altro, un
 *   full admin compreso (lo ha per costruzione, ma solo sulle pubbliche).
 * - **I progetti letti o toccati** (D2 del maintainer): li sa il SERVER. Si
 *   registrano le letture per codice o per id del token del turno e le azioni
 *   proposte (`recordConversationProjects`). A lettura si aggiungono i codici
 *   citati nelle risposte di Claude e il contesto della pagina. Mai un dato
 *   letto: solo il progetto.
 * - **Il seguito privato**: in una pubblica, il messaggio dell'autore fissa un
 *   confine (`private_from_event_id`). I lettori non ricevono nulla da lì in
 *   poi finché il turno non è finito e non ha toccato progetti nuovi; se ne
 *   ha toccati, finché l'autore non li riconferma. Si DERIVA a lettura
 *   (`holdOf`): nessun job lo scrive.
 * - **Gli eventi dei tool restano** anche per i lettori: decisione del
 *   maintainer del 10 nov 2026 (D1), con la conferma esplicita alla
 *   pubblicazione (`includesToolReads`). Non si «correggono» qui.
 */

export const PUBLIC_VIEW_PERMISSION = "claude.public.view";

type ConversationRow = typeof claudeConversations.$inferSelect;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Chi guarda può leggere le pubbliche (il permesso d'istanza; il full admin lo ha per costruzione). */
export function canReadPublic(viewer: { instancePermissions?: ReadonlySet<string> }): boolean {
  return viewer.instancePermissions?.has(PUBLIC_VIEW_PERMISSION) === true;
}

/** Il prossimo id d'evento: ciò che si scrive dopo ha un id maggiore o uguale. */
export async function nextEventId(db: DbOrTx): Promise<bigint> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${agentSessionEvents.id})::text` })
    .from(agentSessionEvents);
  return BigInt(row?.max ?? "0") + 1n;
}

/** Registra i progetti letti o toccati (solo i nuovi: il primo evento resta quello di prima). */
export async function recordConversationProjects(db: DbOrTx, sessionId: string, projectIds: readonly string[]): Promise<void> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return;
  const first = await nextEventId(db);
  await db
    .insert(claudeConversationProjects)
    .values(ids.map((projectId) => ({ sessionId, projectId, firstEventId: first })))
    .onConflictDoNothing();
}

/** Un codice di task (`AUD-12`) o di richiesta (`AUD-R4`): il prefisso è il codice del progetto. */
const CODE = /\b([A-Z][A-Z0-9]{1,9})-R?\d+\b/g;

function prefixesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CODE)) out.add(m[1]!);
  return out;
}

async function projectIdsByCode(db: DbOrTx, codes: ReadonlySet<string>): Promise<string[]> {
  if (codes.size === 0) return [];
  const rows = await db.select({ id: projects.id }).from(projects).where(inArray(projects.code, [...codes]));
  return rows.map((r) => r.id);
}

/** I progetti citati nelle risposte di Claude (da `from` in poi, se dato). */
async function citedProjectIds(db: DbOrTx, sessionId: string, from?: bigint): Promise<string[]> {
  const rows = await db
    .select({ data: agentSessionEvents.data })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, sessionId),
        eq(agentSessionEvents.type, "assistant_text"),
        from !== undefined ? gte(agentSessionEvents.id, from) : undefined,
      ),
    );
  const codes = new Set<string>();
  for (const r of rows) {
    const text = typeof r.data["text"] === "string" ? r.data["text"] : "";
    for (const c of prefixesOf(text)) codes.add(c);
  }
  return projectIdsByCode(db, codes);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Il progetto del contesto della pagina (un progetto, una task o una richiesta per codice), se esiste. */
export async function contextProjectId(db: DbOrTx, row: ConversationRow): Promise<string | null> {
  const ctx = row.contextRef;
  if (!ctx) return null;
  if (ctx.kind === "project") {
    if (!UUID.test(ctx.id)) return null;
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, ctx.id));
    return p?.id ?? null;
  }
  const [id] = await projectIdsByCode(db, prefixesOf(ctx.id.toUpperCase()));
  return id ?? null;
}

/** I progetti che l'AUTORE vede adesso (i suoi permessi d'istanza dal ruolo). */
async function authorVisibleProjects(db: DbOrTx, ownerId: string): Promise<"all" | Set<string>> {
  const [row] = await db
    .select({ permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.instanceRoleId))
    .where(eq(users.id, ownerId));
  const visible = await visibleProjectIds(db as Db, {
    id: ownerId,
    instancePermissions: effectiveInstancePermissions(row?.permissions ?? []),
  });
  return visible === "all" ? "all" : new Set(visible);
}

/**
 * I progetti letti o toccati (D2): registrati, citati, il contesto; da `from`
 * in poi se dato. I codici citati e il contesto entrano SOLO se l'autore vede
 * quei progetti (review della fetta 5): un codice indovinato non deve far
 * comparire nella conferma un progetto che l'autore non vede («invisibile =
 * inesistente»), e un contesto su un progetto inesistente non deve bloccare
 * la pubblicazione. Le letture registrate dal token del turno restano senza
 * filtro: l'autore le ha davvero lette.
 */
export async function touchedProjectIds(db: DbOrTx, row: ConversationRow, from?: bigint): Promise<Set<string>> {
  const recorded = await db
    .select({ projectId: claudeConversationProjects.projectId })
    .from(claudeConversationProjects)
    .where(
      and(
        eq(claudeConversationProjects.sessionId, row.sessionId),
        from !== undefined ? gte(claudeConversationProjects.firstEventId, from) : undefined,
      ),
    );
  const out = new Set(recorded.map((r) => r.projectId));
  const derived = await citedProjectIds(db, row.sessionId, from);
  const context = await contextProjectId(db, row);
  if (context) derived.push(context);
  if (derived.length > 0) {
    const visible = await authorVisibleProjects(db, row.ownerId);
    for (const id of derived) if (visible === "all" || visible.has(id)) out.add(id);
  }
  return out;
}

/**
 * Un turno è in corso dopo `from`: un messaggio in coda, oppure l'ultimo
 * `input` senza il suo `turn_end` né `segment_end`, con la sessione ancora
 * VIVA. Un turno morto (il segmento chiuso senza `turn_end`, o il worker
 * sparito: niente heartbeat) si considera FINITO (review della fetta 5, punto
 * 7): altrimenti resterebbe trattenuto per sempre senza che l'autore lo
 * sappia. Il suo parziale è un sottoinsieme di ciò che sarebbe uscito a turno
 * finito, e se ha toccato un progetto nuovo resta comunque fermo, coi suoi
 * `heldProjects` davanti all'autore.
 */
async function turnOpen(db: DbOrTx, sessionId: string, from: bigint): Promise<boolean> {
  const [pending] = await db
    .select({ id: agentSessionInputs.id })
    .from(agentSessionInputs)
    .where(and(eq(agentSessionInputs.sessionId, sessionId), eq(agentSessionInputs.status, "pending")))
    .limit(1);
  if (pending) return true;
  const [last] = await db
    .select({ type: agentSessionEvents.type })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, sessionId),
        gte(agentSessionEvents.id, from),
        inArray(agentSessionEvents.type, ["input", "turn_end", "segment_end"]),
      ),
    )
    .orderBy(desc(agentSessionEvents.id))
    .limit(1);
  if (last?.type !== "input") return false;
  const [live] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        sql`cardinality(${agentSessions.liveSegmentIds}) > 0`,
        sql`${agentSessions.heartbeatAt} > now() - make_interval(secs => ${LIVE_SECONDS}::int)`,
      ),
    );
  return live !== undefined;
}

/** Come `LIVE_HEARTBEAT_SECONDS` di `agent-sessions.ts` (non importato: quel modulo importa questo). */
const LIVE_SECONDS = 90;

export interface HoldState {
  /** I lettori NON ricevono gli eventi da `boundary` in poi. */
  held: boolean;
  boundary: bigint | null;
  /** I progetti del seguito non ancora confermati (per l'autore: la riconferma). */
  newProjectIds: string[];
  turnOpen: boolean;
}

const NO_HOLD: HoldState = { held: false, boundary: null, newProjectIds: [], turnOpen: false };

/** Il seguito privato di una pubblica, DERIVATO adesso. */
export async function holdOf(db: DbOrTx, row: ConversationRow): Promise<HoldState> {
  if (row.visibility !== "public" || row.privateFromEventId === null) return NO_HOLD;
  const from = row.privateFromEventId;
  const published = new Set(row.publishedProjectIds);
  const newProjectIds = [...(await touchedProjectIds(db, row, from))].filter((id) => !published.has(id));
  const open = await turnOpen(db, row.sessionId, from);
  return { held: open || newProjectIds.length > 0, boundary: from, newProjectIds, turnOpen: open };
}

/**
 * Al messaggio dell'AUTORE in una pubblica: il suo turno resta privato finché
 * non è finito (e pulito). Un confine ancora attivo non si sposta in avanti:
 * il seguito privato non torna mai pubblico da solo.
 */
export async function holdForOwnerMessage(tx: DbOrTx, sessionId: string): Promise<void> {
  const [row] = await tx.select().from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
  if (!row || row.visibility !== "public") return;
  if (row.privateFromEventId !== null && (await holdOf(tx, row)).held) return;
  await tx
    .update(claudeConversations)
    .set({ privateFromEventId: await nextEventId(tx) })
    .where(eq(claudeConversations.sessionId, sessionId));
}

/** La conversazione di una sessione `free` (null per gli altri kind). */
export async function conversationRow(db: DbOrTx, sessionId: string): Promise<ConversationRow | null> {
  const [row] = await db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
  return row ?? null;
}

/**
 * Il TAGLIO degli eventi per chi guarda: un lettore che non è l'autore non
 * riceve nulla da `boundary` in poi mentre il seguito è privato. `null` =
 * nessun taglio (l'autore, una privata, un seguito rilasciato).
 */
export async function readerCut(db: DbOrTx, viewerId: string, sessionId: string): Promise<bigint | null> {
  const row = await conversationRow(db, sessionId);
  if (!row || row.ownerId === viewerId) return null;
  const hold = await holdOf(db, row);
  return hold.held ? hold.boundary : null;
}

/** Chi guarda è un LETTORE (non l'autore) di questa conversazione libera. */
export async function isConversationReader(db: DbOrTx, viewerId: string, sessionId: string): Promise<boolean> {
  const row = await conversationRow(db, sessionId);
  return row !== null && row.ownerId !== viewerId;
}

/**
 * Tutti i progetti di un elenco, senza filtro di visibilità: SOLO per la
 * conferma dell'autore, che li ha letti con i suoi permessi (anche uno che nel
 * frattempo non vede più va confermato, o la pubblicazione non passerebbe mai).
 */
export async function projectViewsForAuthor(db: DbOrTx, ids: Iterable<string>): Promise<ClaudeConversationProject[]> {
  const list = [...new Set(ids)];
  if (list.length === 0) return [];
  const rows = await db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, list));
  return rows.map((r) => ({ id: r.id, code: r.code ?? "", name: r.name })).sort((a, b) => a.code.localeCompare(b.code));
}

/** I progetti nella forma di chi guarda: solo quelli che vede, con codice e nome. */
export async function projectViews(
  db: Db,
  viewer: Pick<SessionUser, "id" | "instancePermissions">,
  ids: Iterable<string>,
): Promise<ClaudeConversationProject[]> {
  const list = [...new Set(ids)];
  if (list.length === 0) return [];
  const visible = await visibleProjectIds(db, viewer);
  const allowed = visible === "all" ? list : list.filter((id) => visible.includes(id));
  if (allowed.length === 0) return [];
  const rows = await db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, allowed));
  return rows
    .map((r) => ({ id: r.id, code: r.code ?? "", name: r.name }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** La conversazione ha letture dei tool: chi legge le vedrà (D1), e il dialogo lo dice. */
export async function hasToolReads(db: DbOrTx, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessionEvents.id })
    .from(agentSessionEvents)
    .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "tool_use")))
    .limit(1);
  return row !== undefined;
}

/** Le letture per codice del token del turno: il progetto sta nella risposta. */
const BY_CODE_ROUTES = new Set(["/api/tasks/by-code/:code", "/api/requests/by-code/:code"]);

/**
 * Hook `onSend` dell'app (fetta 5, D2): una lettura riuscita del token del
 * turno PER CODICE O PER ID registra il suo progetto fra quelli letti dalla
 * conversazione. Gli elenchi generici (progetti, persone, task senza
 * progetto) no: contano per ciò che la risposta di Claude cita. Mai il dato
 * letto: solo il progetto. Fail-open: un errore non tocca la risposta.
 */
export async function recordChatToolReadProjects(request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<void> {
  const sessionId = request.user?.chatToolSessionId;
  if (sessionId === undefined || request.method !== "GET" || reply.statusCode !== 200) return;
  try {
    const route = request.routeOptions.url ?? "";
    const ids = new Set<string>();
    const params = (request.params ?? {}) as Record<string, unknown>;
    if (typeof params["projectId"] === "string" && UUID.test(params["projectId"])) ids.add(params["projectId"]);
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (route === "/api/tasks" && typeof query["projectIds"] === "string" && UUID.test(query["projectIds"])) {
      ids.add(query["projectIds"]);
    }
    if (BY_CODE_ROUTES.has(route) && typeof payload === "string") {
      const body = JSON.parse(payload) as { projectId?: unknown };
      if (typeof body.projectId === "string" && UUID.test(body.projectId)) ids.add(body.projectId);
    }
    await recordConversationProjects(request.server.db, sessionId, [...ids]);
  } catch (error) {
    request.log.warn({ err: error }, "progetti letti dalla chat non registrati");
  }
}

/**
 * Ciò che un LETTORE sa del momento e del titolo di una pubblica (review
 * della fetta 5): l'ultima attività è quella dell'ultimo evento sotto il
 * taglio, non del seguito privato (l'ordine di «Public» non si muove col
 * seguito); e se nessun messaggio dell'autore è ancora uscito mentre il turno
 * è trattenuto, il titolo (che nasce dal primo messaggio) non esce: vuoto.
 */
export async function readerSnapshot(
  db: DbOrTx,
  row: ConversationRow,
): Promise<{ lastActivityAt: Date; titleHidden: boolean }> {
  const hold = await holdOf(db, row);
  const [last] = await db
    .select({ at: agentSessionEvents.createdAt })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, row.sessionId),
        hold.held && hold.boundary !== null ? lt(agentSessionEvents.id, hold.boundary) : undefined,
      ),
    )
    .orderBy(desc(agentSessionEvents.id))
    .limit(1);
  let titleHidden = false;
  if (hold.held && hold.boundary !== null) {
    const [released] = await db
      .select({ id: agentSessionEvents.id })
      .from(agentSessionEvents)
      .where(
        and(
          eq(agentSessionEvents.sessionId, row.sessionId),
          eq(agentSessionEvents.type, "input"),
          lt(agentSessionEvents.id, hold.boundary),
        ),
      )
      .limit(1);
    titleHidden = released === undefined;
  }
  return { lastActivityAt: last?.at ?? row.publishedAt ?? row.createdAt, titleHidden };
}
