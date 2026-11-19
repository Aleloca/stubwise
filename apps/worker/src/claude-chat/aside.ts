import { agentSessionEvents, agentSessions, type Db } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import { stalledProjects } from "./bridge.js";

/** Il segmento degli eventi scritti fuori da un turno del CLI (come le proposte e le domande). */
const EVENT_SEGMENT = "stubwise-claude-actions";
/** I progetti mostrati, come nel prototipo (`stalled.ts`, «5 e Show N more»). */
const SHOWN = 5;

export interface StalledAsideData {
  rows: { projectId: string; count: number; oldest: { ticketId: string; stalledSince: string; reason: string } }[];
  hypothesis: { ticketId: string; key: "out_of_plan" } | null;
}

/**
 * Area 10, F3 (S2, D-3 = a): l'evento `aside` del lavoro fermo, scritto dal
 * WORKER con le task ferme già lette dal ponte (`GET /api/tasks/stalled`, le
 * soglie dei progetti). Porta solo id, numeri, date e il tipo del motivo; i
 * codici, la soglia e la visibilità li aggiunge il server a lettura. L'ipotesi
 * è UNA, quella del prototipo: la più vecchia del primo progetto è ferma per
 * inattività (`idle`) e non è pianificata in nessuna settimana («fuori
 * piano»). Niente righe, niente evento.
 */
export async function writeStalledAside(db: Db, sessionId: string, stalled: unknown): Promise<StalledAsideData | null> {
  const [session] = await db.select({ kind: agentSessions.kind }).from(agentSessions).where(eq(agentSessions.id, sessionId));
  if (session?.kind !== "free") return null;
  const shown = stalledProjects(stalled).slice(0, SHOWN);
  if (shown.length === 0) return null;
  const rows = shown.map((p) => ({
    projectId: p.projectId,
    count: p.stalled.length,
    oldest: { ticketId: p.stalled[0]!.ticketId, stalledSince: p.stalled[0]!.stalledSince, reason: p.stalled[0]!.reason },
  }));
  const first = shown[0]!.stalled[0]!;
  const data: StalledAsideData = { rows, hypothesis: first.reason === "idle" && first.plannedWeek === null ? { ticketId: first.ticketId, key: "out_of_plan" } : null };
  await db.insert(agentSessionEvents).values({ sessionId, segmentId: EVENT_SEGMENT, type: "aside", data: data as unknown as Record<string, unknown> });
  await db.execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`).catch(() => undefined);
  return data;
}
