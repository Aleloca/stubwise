import { backlogItems, decisionRequests, milestones, projectStatuses, projects, tickets, type Db } from "@stubwise/db";
import { pulseOf } from "@stubwise/shared";
import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { requestsToConvertConditions } from "../routes/requests.js";
import { listAgentSessions } from "./agent-sessions.js";
import { listClaudeDecisions } from "./claude-decisions.js";
import { loadStallTasks, serverToday, stallsOf, taskFilterConditions, visibleTasksCondition } from "./task-view.js";

type MilestoneRow = typeof milestones.$inferSelect;

export interface ProjectPulseRow {
  projectId: string;
  open: { todo: number; active: number };
  stalled: number;
  waitingOnMe: boolean;
  claudeWorking: boolean;
  nextMilestone: MilestoneRow | null;
  waiting: { decisionsForMe: number; requestsToConvert: number; claudeWaitingForMe: number };
  truncated: boolean;
}

/**
 * Lotto 7, voce 4: il polso dei progetti calcolato sul server, con le STESSE
 * regole delle letture che il renderer combinava (`pulsesOf` in
 * `apps/desktop/.../real/overview.ts`) — ognuna è la funzione della sua rotta,
 * non una copia: le task aperte e le ferme (`loadTaskViews`/`stallsOf`, la
 * visibilità delle task), le decisioni aperte rivolte a chi guarda
 * (contate, con le condizioni di `listDecisions`), le richieste nuove da trasformare
 * (`requestsToConvertConditions`), Claude in attesa di chi guarda
 * (`listClaudeDecisions`) e al lavoro (`listAgentSessions`), poi la formula di
 * `pulseOf`. I progetti sono quelli che chi guarda vede (`visibleProjectIds`):
 * un id invisibile non compare (filtrato nella WHERE, come gli elenchi).
 */
export async function projectPulses(db: Db, viewer: SessionUser, wanted?: readonly string[]): Promise<ProjectPulseRow[]> {
  const scope = await visibleProjectIds(db, viewer);
  const visible = isAllProjects(scope)
    ? (await db.select({ id: projects.id }).from(projects).where(isNull(projects.archivedAt))).map((r) => r.id)
    : [...scope];
  const ids = wanted ? visible.filter((id) => wanted.includes(id)) : visible;
  if (ids.length === 0) return [];
  const today = serverToday();
  const openTasks = taskFilterConditions({ projectIds: ids, families: ["todo", "active"] }, today, viewer.id);
  const visibleTasks = await visibleTasksCondition(db, viewer);

  // Revisione I-1 (lotti 6–7): niente viste intere né tetto. Le aperte si
  // CONTANO in SQL (stessa visibilità e stessi filtri dell'elenco), le ferme
  // con la forma ridotta di `stallsOf` (`loadStallTasks`), le decisioni con
  // un conteggio (`listDecisions` ha un tetto di 500).
  const [counts, stallTasks, decisions, toConvert, claudeWaiting, sessions, open] = await Promise.all([
    db
      .select({ projectId: tickets.projectId, family: projectStatuses.family, n: count() })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(and(...(visibleTasks ? [visibleTasks] : []), ...openTasks))
      .groupBy(tickets.projectId, projectStatuses.family),
    loadStallTasks(db, viewer, openTasks),
    // Le stesse condizioni di `listDecisions({ askedOfId: "me", open: true })`, contate.
    db
      .select({ projectId: tickets.projectId, n: count() })
      .from(decisionRequests)
      .innerJoin(tickets, eq(tickets.id, decisionRequests.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(
          ...(visibleTasks ? [visibleTasks] : []),
          eq(decisionRequests.askedOfUserId, viewer.id),
          isNull(decisionRequests.answeredAt),
          isNull(decisionRequests.withdrawnAt),
          inArray(tickets.projectId, ids),
        ),
      )
      .groupBy(tickets.projectId),
    requestsToConvertConditions(db, viewer).then(async (conditions) =>
      conditions
        ? db
            .select({ projectId: backlogItems.projectId, n: count() })
            .from(backlogItems)
            .innerJoin(projects, eq(projects.id, backlogItems.projectId))
            .where(and(...conditions, eq(backlogItems.status, "new"), inArray(backlogItems.projectId, ids)))
            .groupBy(backlogItems.projectId)
        : [],
    ),
    listClaudeDecisions(db, viewer),
    listAgentSessions(db, viewer, {}),
    db
      .select()
      .from(milestones)
      .where(and(inArray(milestones.projectId, ids), eq(milestones.status, "open"), isNotNull(milestones.dueDate)))
      .orderBy(asc(milestones.dueDate), asc(milestones.name)),
  ]);
  const stalls = await stallsOf(db, viewer, stallTasks, today);
  const stalledOf = new Map<string, number>();
  for (const t of stallTasks) if (stalls.has(t.view.id)) stalledOf.set(t.view.projectId, (stalledOf.get(t.view.projectId) ?? 0) + 1);
  const countOf = (projectId: string, family: string) => counts.find((c) => c.projectId === projectId && c.family === family)?.n ?? 0;
  const decisionsOf = new Map(decisions.map((r) => [r.projectId, r.n]));
  const convertOf = new Map(toConvert.map((r) => [r.projectId, r.n]));
  const working = new Set(
    sessions.live.flatMap((s) => (s.kind === "ai_job" && (s.state === "working" || s.state === "queued") && s.projectId ? [s.projectId] : [])),
  );

  return ids.map((projectId) => {
    const waiting = {
      decisionsForMe: decisionsOf.get(projectId) ?? 0,
      requestsToConvert: convertOf.get(projectId) ?? 0,
      claudeWaitingForMe: claudeWaiting.filter((d) => d.projectId === projectId).length,
    };
    // La formula di `pulseOf`, sui conteggi: le famiglie e le ferme vengono dalle letture sopra.
    const pulse = pulseOf({
      projectId,
      tasks: [],
      milestones: open.filter((m) => m.projectId === projectId).map((m) => ({ row: m, dueDate: m.dueDate!.toISOString(), closed: false })),
      ...waiting,
      claudeWorking: working.has(projectId),
    });
    return {
      ...pulse,
      open: { todo: countOf(projectId, "todo"), active: countOf(projectId, "active") },
      stalled: stalledOf.get(projectId) ?? 0,
      nextMilestone: pulse.nextMilestone?.row ?? null,
      waiting,
      truncated: false,
    };
  });
}
