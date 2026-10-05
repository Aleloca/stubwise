import {
  agentQuestions,
  aiJobs,
  prCorrections,
  prReviews,
  projectDecisions,
  ticketEvents,
  ticketRepositories,
  users,
  type Db,
} from "@stubwise/db";
import { buildTicketHistory, type TicketHistoryRows } from "@stubwise/notifications";
import { prNumberFromUrl, type TicketHistory } from "@stubwise/shared";
import { and, eq, isNotNull } from "drizzle-orm";

/**
 * Il tetto della storia restituita da `GET /api/tickets/:id/history`: i 200
 * eventi più recenti. `total` dice quanti erano prima del taglio, così il
 * client non promette «Show all (N)» con un N sbagliato.
 */
export const TICKET_HISTORY_LIMIT = 200;

/** Legge `{ from, to }` di un `status_changed` dal jsonb, tollerando forme vecchie. */
function statusPayload(payload: unknown): { from: string | null; to: string | null } {
  if (payload === null || typeof payload !== "object") return { from: null, to: null };
  const p = payload as Record<string, unknown>;
  return {
    from: typeof p.from === "string" ? p.from : null,
    to: typeof p.to === "string" ? p.to : null,
  };
}

/**
 * Le righe della storia di UN ticket — una query per sorgente, in parallelo,
 * come `/activity` — date al modulo puro `buildTicketHistory`
 * (`@stubwise/notifications`), che decide quali diventano quale evento.
 *
 * Ogni query filtra per `ticket_id` del ticket: le review e le correzioni
 * stanno su una PR, ma una PR di un altro ticket (o una review con un ticket
 * diverso) non deve entrare. La regola su review in attesa/fallite la applica
 * anche il modulo; qui il filtro serve solo a non leggere righe inutili.
 */
export async function loadTicketHistory(db: Db, ticketId: string): Promise<TicketHistory> {
  const [jobs, questions, decisions, reviews, corrections, statusEvents, prs] = await Promise.all([
    db
      .select({
        id: aiJobs.id,
        status: aiJobs.status,
        correctionId: aiJobs.correctionId,
        prUrl: aiJobs.prUrl,
        createdAt: aiJobs.createdAt,
        startedAt: aiJobs.startedAt,
        finishedAt: aiJobs.finishedAt,
        requesterName: users.email,
      })
      .from(aiJobs)
      .leftJoin(users, eq(users.id, aiJobs.requestedByUserId))
      .where(eq(aiJobs.ticketId, ticketId)),
    db
      .select({
        id: agentQuestions.id,
        askedAt: agentQuestions.askedAt,
        answeredAt: agentQuestions.answeredAt,
        answeredByName: users.email,
      })
      .from(agentQuestions)
      .leftJoin(users, eq(users.id, agentQuestions.answeredByUserId))
      .where(eq(agentQuestions.ticketId, ticketId)),
    db
      .select({
        id: projectDecisions.id,
        sourceRef: projectDecisions.sourceRef,
        decidedAt: projectDecisions.decidedAt,
        decidedByName: users.email,
      })
      .from(projectDecisions)
      .leftJoin(users, eq(users.id, projectDecisions.decidedByUserId))
      .where(
        and(eq(projectDecisions.ticketId, ticketId), eq(projectDecisions.source, "plan_review")),
      ),
    db
      .select({
        id: prReviews.id,
        repositoryId: prReviews.repositoryId,
        prNumber: prReviews.prNumber,
        prUrl: prReviews.prUrl,
        verdict: prReviews.verdict,
        status: prReviews.status,
        createdAt: prReviews.createdAt,
        startedAt: prReviews.startedAt,
        finishedAt: prReviews.finishedAt,
      })
      .from(prReviews)
      .where(
        and(
          eq(prReviews.ticketId, ticketId),
          eq(prReviews.status, "completed"),
          isNotNull(prReviews.startedAt),
        ),
      ),
    db
      .select({
        id: prCorrections.id,
        repositoryId: prCorrections.repositoryId,
        prNumber: prCorrections.prNumber,
        trigger: prCorrections.trigger,
        status: prCorrections.status,
        createdAt: prCorrections.createdAt,
        updatedAt: prCorrections.updatedAt,
        userEmail: users.email,
        providerLogin: prCorrections.requestedByProviderLogin,
      })
      .from(prCorrections)
      .leftJoin(users, eq(users.id, prCorrections.requestedByUserId))
      .where(eq(prCorrections.ticketId, ticketId)),
    db
      .select({
        id: ticketEvents.id,
        payload: ticketEvents.payload,
        actorName: users.email,
        createdAt: ticketEvents.createdAt,
      })
      .from(ticketEvents)
      .leftJoin(users, eq(users.id, ticketEvents.actorId))
      .where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.kind, "status_changed"))),
    db
      .select({
        repositoryId: ticketRepositories.repositoryId,
        prNumber: ticketRepositories.prNumber,
        prUrl: ticketRepositories.prUrl,
      })
      .from(ticketRepositories)
      .where(and(eq(ticketRepositories.ticketId, ticketId), isNotNull(ticketRepositories.prUrl))),
  ]);

  const rows: TicketHistoryRows = {
    jobs,
    questions,
    decisions,
    reviews,
    corrections,
    statusEvents: statusEvents.map((e) => ({
      id: e.id,
      ...statusPayload(e.payload),
      actorName: e.actorName,
      createdAt: e.createdAt,
    })),
    // Una riga senza `pr_number` (scritta prima della 0081) lo ricava dall'URL,
    // con la regola unica di @stubwise/shared; senza nessuno dei due resta fuori.
    prUrls: prs.flatMap((p) => {
      if (p.prUrl === null) return [];
      const prNumber = p.prNumber ?? prNumberFromUrl(p.prUrl);
      return prNumber === null ? [] : [{ repositoryId: p.repositoryId, prNumber, prUrl: p.prUrl }];
    }),
  };
  return buildTicketHistory(rows, { limit: TICKET_HISTORY_LIMIT });
}
