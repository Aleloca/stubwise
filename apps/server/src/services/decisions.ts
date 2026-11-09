import { decisionRequests, projects, tickets, type Db } from "@stubwise/db";
import { publishNotification } from "@stubwise/notifications";
import type { DecisionRequestView } from "@stubwise/shared";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsOfUser } from "../auth/access.js";
import { canSeeTicket } from "../auth/project-resolvers.js";
import { notifyTaskActivity } from "./task-notify.js";
import { visibleTasksCondition, type TaskViewer } from "./task-view.js";

/**
 * Richieste di decisione su una task (integrazione area 2, fetta 1): una
 * persona chiede a un'altra di decidere (domanda, opzioni facoltative,
 * «Altro…»). La risposta entra nell'attività della task e avvisa chi ha
 * chiesto; NON entra nel registro decisioni in automatico. Finché la Home è
 * «in arrivo», chi deve decidere la trova nelle notifiche.
 */

type DecisionRow = typeof decisionRequests.$inferSelect;

export function toDecisionView(row: DecisionRow, projectId?: string): DecisionRequestView {
  return {
    id: row.id,
    taskId: row.ticketId,
    ...(projectId ? { projectId } : {}),
    askedById: row.askedByUserId,
    askedOfId: row.askedOfUserId,
    question: row.question,
    options: row.options,
    createdAt: row.createdAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    answer: row.answeredAt
      ? {
          optionIndex: row.answerOptionIndex,
          text: row.answerText,
          at: row.answeredAt.toISOString(),
          byId: row.answeredByUserId,
        }
      : null,
  };
}

async function ticketRef(db: Db, ticketId: string) {
  const [row] = await db
    .select({ number: tickets.number, projectId: tickets.projectId, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, ticketId));
  return row!;
}

export type AskResult =
  | { ok: true; decision: DecisionRequestView }
  | { ok: false; error: "decision_target_cannot_see" };

export async function askDecision(
  db: Db,
  viewer: TaskViewer,
  ticketId: string,
  input: { askedOfId: string; question: string; options: string[] },
): Promise<AskResult> {
  const ref = await ticketRef(db, ticketId);
  // Chi deve decidere deve poter vedere la task (stessa regola dell'elenco).
  const permissions = await projectPermissionsOfUser(db, input.askedOfId, ref.projectId);
  if (!permissions || !(await canSeeTicket(db, { id: input.askedOfId }, permissions, ticketId))) {
    return { ok: false, error: "decision_target_cannot_see" };
  }
  const decision = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(decisionRequests)
      .values({
        ticketId,
        askedByUserId: viewer.id,
        askedOfUserId: input.askedOfId,
        question: input.question,
        options: input.options,
      })
      .returning();
    await publishNotification(
      tx,
      {
        kind: "decision.requested",
        ticketId,
        ticketNumber: ref.number,
        projectId: ref.projectId,
        projectCode: ref.code,
        decisionId: row!.id,
        question: row!.question,
        askedByUserId: viewer.id,
      },
      { projectId: ref.projectId, ticketId },
    );
    // Chi segue la task lo sa (design: i follower ricevono anche le
    // decisioni), tranne chi deve decidere: ha già `decision.requested`.
    await notifyTaskActivity(tx, {
      ticketId,
      actorUserId: viewer.id,
      change: "decision",
      summary: "requested",
      excludeUserIds: [input.askedOfId],
    });
    return row!;
  });
  return { ok: true, decision: toDecisionView(decision, ref.projectId) };
}

/** La decisione, se chi guarda ne vede la task; altrimenti `null` (→ 404). */
async function visibleDecision(db: Db, viewer: TaskViewer, id: string): Promise<DecisionRow | null> {
  const [row] = await db.select().from(decisionRequests).where(eq(decisionRequests.id, id));
  if (!row) return null;
  const ref = await ticketRef(db, row.ticketId);
  const permissions = await projectPermissionsFor(db, viewer, ref.projectId);
  if (!permissions || !(await canSeeTicket(db, viewer, permissions, row.ticketId))) return null;
  return row;
}

export type CloseResult =
  | { ok: true; decision: DecisionRequestView }
  | { ok: false; error: "not_found" | "forbidden" | "decision_closed" | "option_out_of_range" };

export async function answerDecision(
  db: Db,
  viewer: TaskViewer,
  id: string,
  answer: { optionIndex: number } | { text: string },
): Promise<CloseResult> {
  const row = await visibleDecision(db, viewer, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.askedOfUserId !== viewer.id) return { ok: false, error: "forbidden" };
  if (row.answeredAt || row.withdrawnAt) return { ok: false, error: "decision_closed" };
  const optionIndex = "optionIndex" in answer ? answer.optionIndex : null;
  if (optionIndex !== null && optionIndex >= row.options.length) return { ok: false, error: "option_out_of_range" };
  const text = "text" in answer ? answer.text : null;
  const result = await db.transaction(async (tx) => {
    // La guardia nella WHERE: due risposte concorrenti non chiudono due volte.
    const [updated] = await tx
      .update(decisionRequests)
      .set({ answerOptionIndex: optionIndex, answerText: text, answeredAt: new Date(), answeredByUserId: viewer.id })
      .where(and(eq(decisionRequests.id, id), isNull(decisionRequests.answeredAt), isNull(decisionRequests.withdrawnAt)))
      .returning();
    if (!updated) return null;
    const ref = await ticketRef(db, updated.ticketId);
    await publishNotification(
      tx,
      {
        kind: "decision.answered",
        ticketId: updated.ticketId,
        ticketNumber: ref.number,
        projectId: ref.projectId,
        projectCode: ref.code,
        decisionId: updated.id,
        question: updated.question,
        answerSummary: optionIndex !== null ? (updated.options[optionIndex] ?? "") : (text ?? ""),
        answeredByUserId: viewer.id,
      },
      { projectId: ref.projectId, ticketId: updated.ticketId },
    );
    // I follower, tranne chi aveva chiesto: ha già `decision.answered`.
    await notifyTaskActivity(tx, {
      ticketId: updated.ticketId,
      actorUserId: viewer.id,
      change: "decision",
      summary: "answered",
      ...(updated.askedByUserId ? { excludeUserIds: [updated.askedByUserId] } : {}),
    });
    return updated;
  });
  if (!result) return { ok: false, error: "decision_closed" };
  return { ok: true, decision: toDecisionView(result, (await ticketRef(db, result.ticketId)).projectId) };
}

export async function withdrawDecision(db: Db, viewer: TaskViewer, id: string): Promise<CloseResult> {
  const row = await visibleDecision(db, viewer, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.askedByUserId !== viewer.id) return { ok: false, error: "forbidden" };
  const [updated] = await db
    .update(decisionRequests)
    .set({ withdrawnAt: new Date() })
    .where(and(eq(decisionRequests.id, id), isNull(decisionRequests.answeredAt), isNull(decisionRequests.withdrawnAt)))
    .returning();
  if (!updated) return { ok: false, error: "decision_closed" };
  return { ok: true, decision: toDecisionView(updated, (await ticketRef(db, updated.ticketId)).projectId) };
}

/** Le decisioni delle task che chi guarda vede, filtrate nella WHERE. */
export async function listDecisions(
  db: Db,
  viewer: TaskViewer,
  query: { taskId?: string; askedOfId?: string; open?: boolean },
): Promise<DecisionRequestView[]> {
  const visible = await visibleTasksCondition(db, viewer);
  const conditions: SQL[] = [];
  if (visible) conditions.push(visible);
  if (query.taskId) conditions.push(eq(decisionRequests.ticketId, query.taskId));
  if (query.askedOfId) {
    conditions.push(eq(decisionRequests.askedOfUserId, query.askedOfId === "me" ? viewer.id : query.askedOfId));
  }
  if (query.open) conditions.push(isNull(decisionRequests.answeredAt), isNull(decisionRequests.withdrawnAt));
  const rows = await db
    .select({ d: decisionRequests, projectId: tickets.projectId })
    .from(decisionRequests)
    .innerJoin(tickets, eq(tickets.id, decisionRequests.ticketId))
    .where(and(...conditions))
    .orderBy(asc(decisionRequests.createdAt))
    .limit(500);
  return rows.map((r) => toDecisionView(r.d, r.projectId));
}
