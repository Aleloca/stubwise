import { backlogItems, milestones, projects, type Db } from "@stubwise/db";
import { PROJECT_PULSES_TASK_CAP, pulseOf } from "@stubwise/shared";
import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isAllProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { requestsToConvertConditions } from "../routes/requests.js";
import { listAgentSessions } from "./agent-sessions.js";
import { listClaudeDecisions } from "./claude-decisions.js";
import { listDecisions } from "./decisions.js";
import { loadTaskViews, serverToday, stallsOf, taskFilterConditions } from "./task-view.js";

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
 * (`listDecisions`), le richieste nuove da trasformare
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

  const [loaded, decisions, toConvert, claudeWaiting, sessions, open] = await Promise.all([
    loadTaskViews(db, viewer, taskFilterConditions({ projectIds: ids, families: ["todo", "active"] }, today, viewer.id), PROJECT_PULSES_TASK_CAP + 1),
    listDecisions(db, viewer, { askedOfId: "me", open: true }),
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
  const truncated = loaded.length > PROJECT_PULSES_TASK_CAP;
  const tasks = loaded.slice(0, PROJECT_PULSES_TASK_CAP);
  const stalls = await stallsOf(db, viewer, tasks, today);
  const convertOf = new Map(toConvert.map((r) => [r.projectId, r.n]));
  const working = new Set(
    sessions.live.flatMap((s) => (s.kind === "ai_job" && (s.state === "working" || s.state === "queued") && s.projectId ? [s.projectId] : [])),
  );

  return ids.map((projectId) => {
    const mine = tasks.filter((t) => t.view.projectId === projectId && t.family !== "closed");
    const waiting = {
      decisionsForMe: decisions.filter((d) => d.projectId === projectId).length,
      requestsToConvert: convertOf.get(projectId) ?? 0,
      claudeWaitingForMe: claudeWaiting.filter((d) => d.projectId === projectId).length,
    };
    const pulse = pulseOf({
      projectId,
      tasks: mine.map((t) => ({ family: t.family, stalled: stalls.has(t.view.id) })),
      milestones: open.filter((m) => m.projectId === projectId).map((m) => ({ row: m, dueDate: m.dueDate!.toISOString(), closed: false })),
      ...waiting,
      claudeWorking: working.has(projectId),
    });
    return { ...pulse, nextMilestone: pulse.nextMilestone?.row ?? null, waiting, truncated };
  });
}
