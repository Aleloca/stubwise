import { agentQuestions, agentSessions, aiJobs, projects, tickets, type Db } from "@stubwise/db";
import { actorAllows, stateAllows } from "@stubwise/notifications";
import type { ClaudeDecisionView, ProjectPermission } from "@stubwise/shared";
import { and, eq, isNull } from "drizzle-orm";
import { inProjects, projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * «Da decidere» di Claude (integrazione area 3, fetta 3b): i piani e le
 * domande dei job che aspettano CHI GUARDA. Le regole sono quelle delle
 * scritture, non copie:
 * - un piano lo decide solo chi ha `plans.approve` nel progetto (il gate di
 *   `resolvePlan`, «I due divieti dell'operatore»);
 * - una domanda la risponde chi passa `actorAllows`/`stateAllows`, le stesse
 *   di `answerQuestion` e di `canAnswer` delle sessioni (il richiedente del job
 *   o `plans.approve`);
 * - in entrambi i casi la task deve essere visibile (`tickets.view_all` nel
 *   progetto, o chi l'ha chiesta: `canSeeTicket`).
 * La query restringe ai progetti visibili; i permessi si leggono una volta per
 * progetto.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export async function listClaudeDecisions(db: Db, viewer: Viewer): Promise<ClaudeDecisionView[]> {
  const visible = await visibleProjectIds(db, viewer);
  const ticketColumns = {
    jobId: aiJobs.id,
    status: aiJobs.status,
    jobRequestedBy: aiJobs.requestedByUserId,
    planSummary: aiJobs.planSummary,
    lastActivityAt: aiJobs.lastActivityAt,
    ticketId: tickets.id,
    ticketNumber: tickets.number,
    title: tickets.title,
    ticketRequestedBy: tickets.requestedByUserId,
    projectId: tickets.projectId,
    projectCode: projects.code,
    sessionId: agentSessions.id,
  };
  const [plans, questions] = await Promise.all([
    db
      .select(ticketColumns)
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .leftJoin(agentSessions, eq(agentSessions.aiJobId, aiJobs.id))
      .where(and(eq(aiJobs.status, "awaiting_plan_approval"), inProjects(tickets.projectId, visible))),
    db
      .select({
        ...ticketColumns,
        questionId: agentQuestions.id,
        question: agentQuestions.question,
        options: agentQuestions.options,
        recommendedIndex: agentQuestions.recommendedIndex,
        askedAt: agentQuestions.askedAt,
      })
      .from(agentQuestions)
      .innerJoin(aiJobs, eq(aiJobs.id, agentQuestions.jobId))
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .leftJoin(agentSessions, eq(agentSessions.aiJobId, aiJobs.id))
      .where(
        and(
          isNull(agentQuestions.answeredAt),
          eq(aiJobs.status, "awaiting_input"),
          inProjects(tickets.projectId, visible),
        ),
      ),
  ]);

  const projectIds = [...new Set([...plans, ...questions].map((r) => r.projectId))];
  const permsOf = new Map<string, ReadonlySet<ProjectPermission>>(
    await Promise.all(
      projectIds.map(async (pid) => [pid, (await projectPermissionsFor(db, viewer, pid)) ?? new Set<ProjectPermission>()] as const),
    ),
  );
  const seesTicket = (r: { projectId: string; ticketRequestedBy: string | null }) =>
    permsOf.get(r.projectId)!.has("tickets.view_all") || r.ticketRequestedBy === viewer.id;
  const base = (r: (typeof plans)[number]) => ({
    conversationId: r.sessionId ?? null,
    conversationKind: "task_run" as const,
    title: r.title,
    ownerId: r.jobRequestedBy,
    projectId: r.projectId,
    taskId: r.ticketId,
    requestId: null,
    objectCode: `${r.projectCode}-${r.ticketNumber}`,
    blockedReason: null,
    serverCode: null,
    webHref: `/tickets/${r.ticketId}`,
  });

  const out: ClaudeDecisionView[] = [];
  for (const r of plans) {
    if (!seesTicket(r) || !permsOf.get(r.projectId)!.has("plans.approve")) continue;
    out.push({
      ...base(r),
      id: `${r.jobId}:plan`,
      kind: "plan",
      // Il job si parcheggia sul gate con l'ultima attività: è il momento del piano.
      at: r.lastActivityAt.toISOString(),
      planId: r.jobId,
      summary: r.planSummary ?? "",
    });
  }
  for (const r of questions) {
    const permissions = permsOf.get(r.projectId)!;
    if (!seesTicket(r)) continue;
    if (
      !actorAllows({ kind: "job.awaiting_input", requestedByUserId: r.jobRequestedBy }, "answer", { id: viewer.id, permissions }) ||
      !stateAllows("job.awaiting_input", "answer", r.status)
    ) {
      continue;
    }
    out.push({
      ...base(r),
      id: `${r.jobId}:${r.questionId}`,
      kind: "question",
      at: r.askedAt.toISOString(),
      questionId: r.questionId,
      text: r.question,
      options: r.options.map((o, index) => ({
        label: o.label,
        ...(o.consequence !== undefined ? { consequence: o.consequence } : {}),
        recommended: r.recommendedIndex === index,
      })),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
