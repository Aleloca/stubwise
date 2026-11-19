import { agentSessionEvents, agentSessions, tickets, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import { stalledProjects } from "./bridge.js";

/** Il segmento degli eventi scritti fuori da un turno del CLI (come le proposte e le domande). */
const EVENT_SEGMENT = "stubwise-claude-actions";
/** I progetti mostrati, come nel prototipo (`stalled.ts`, «5 e Show N more»). */
const SHOWN = 5;

export interface StalledAsideData {
  rows: { projectId: string; count: number; oldest: { ticketId: string; stalledSince: string } }[];
  hypothesis: { ticketId: string; key: "out_of_plan" } | null;
}

/**
 * Area 10, F3 (S2, D-3 = a): l'evento `aside` del lavoro fermo, scritto dal
 * WORKER col polso già letto dal ponte. Porta solo id, numeri e date; i codici
 * e la visibilità li aggiunge il server a lettura. L'ipotesi è UNA, quella del
 * prototipo: la ferma più vecchia del primo progetto mostrato non è
 * pianificata in nessuna settimana («fuori piano»). Niente righe, niente evento.
 */
export async function writeStalledAside(db: Db, sessionId: string, pulse: unknown, path: string): Promise<StalledAsideData | null> {
  const [session] = await db.select({ kind: agentSessions.kind }).from(agentSessions).where(eq(agentSessions.id, sessionId));
  if (session?.kind !== "free") return null;
  const shown = stalledProjects(pulse, path).slice(0, SHOWN);
  if (shown.length === 0) return null;
  const rows = shown.map((p) => ({ projectId: p.projectId, count: p.stalled.length, oldest: { ticketId: p.stalled[0]!.ticketId, stalledSince: p.stalled[0]!.stalledSince } }));
  const first = rows[0]!.oldest.ticketId;
  const [t] = await db.select({ plannedWeek: tickets.plannedWeek }).from(tickets).where(eq(tickets.id, first));
  const data: StalledAsideData = { rows, hypothesis: t && t.plannedWeek === null ? { ticketId: first, key: "out_of_plan" } : null };
  await db.insert(agentSessionEvents).values({ sessionId, segmentId: EVENT_SEGMENT, type: "aside", data: data as unknown as Record<string, unknown> });
  await db.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`).catch(() => undefined);
  return data;
}
