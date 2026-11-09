import {
  agentQuestions,
  aiJobs,
  attachments,
  backlogItemTickets,
  comments,
  decisionRequests,
  projectStatuses,
  projects,
  ticketEvents,
  ticketFollowers,
  ticketLinks,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  WEEK_TIME_ZONE,
  canMove,
  mondayToIsoWeek,
  periodRange,
  sizeFromEffort,
  stallOf,
  uiTypeOf,
  type AiJobStatus,
  type ClaudeWorkStateView,
  type InstancePermission,
  type Stall,
  type StatusFamily,
  type TaskListQuery,
  type TaskViewData,
  type TicketSource,
  type TicketType,
} from "@stubwise/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  inProjects,
  projectIdsWithPermission,
  projectPermissionsMap,
  visibleProjectIds,
} from "../auth/access.js";

/**
 * Le viste delle task nella forma del prototipo (integrazione area 2, fetta
 * 1). Le regole derivate (ferme, stato di Claude, tipi, taglie) le calcola il
 * server qui: il client le legge, non le deduce (`docs/invariants/permissions.md`
 * e la famiglia «si derivano a lettura» in `CLAUDE.md`).
 *
 * Il caricamento è a BATCH: una query per relazione, non una per task.
 */

export interface TaskViewer {
  id: string;
  instancePermissions: ReadonlySet<InstancePermission>;
}

/** Il tetto dell'elenco: il prototipo non pagina. */
export const TASK_LIST_CAP = 2000;

/**
 * La visibilità di `GET /api/tickets`, nella WHERE: i progetti che chi guarda
 * vede, e dentro quelli senza `tickets.view_all` solo le task chieste da sé.
 */
export async function visibleTasksCondition(db: Db, viewer: TaskViewer): Promise<SQL | undefined> {
  const conditions: SQL[] = [];
  const visible = inProjects(tickets.projectId, await visibleProjectIds(db, viewer));
  if (visible) conditions.push(visible);
  const viewAll = await projectIdsWithPermission(db, viewer, "tickets.view_all");
  if (viewAll !== "all") {
    const own = eq(tickets.requestedByUserId, viewer.id);
    conditions.push(viewAll.length > 0 ? or(inArray(tickets.projectId, viewAll), own)! : own);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Oggi del server, come data nel fuso della settimana (`WEEK_TIME_ZONE`,
 * Europe/Rome): lo stesso giorno di `stubwise_current_monday()` nel DB, così
 * «questa settimana», lo slittamento e le ferme non si contraddicono a
 * cavallo della mezzanotte.
 */
export function serverToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: WEEK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * L'intervallo del periodo di una query: assoluto se ci sono gli estremi,
 * altrimenti il preset con `periodRange` di `@stubwise/shared` (lo stesso del
 * finto e dell'app: una regola, un posto).
 */
function queryPeriodRange(q: TaskListQuery, today: string): { from: string; to: string } | null {
  if (q.periodFrom && q.periodTo) return { from: q.periodFrom, to: q.periodTo };
  return q.periodPreset ? periodRange({ kind: "relative", preset: q.periodPreset }, today) : null;
}

const DB_TYPES_FOR_UI: Record<string, TicketType[]> = {
  bug: ["bug"],
  feature: ["feature", "feedback"],
  activity: ["task", "review"],
};

/**
 * La settimana EFFETTIVA (`stubwise_effective_week`: la pianificata, o la
 * corrente se è passata e la task è aperta, o quella di chiusura) in forma
 * SARGABLE (fix della review della fetta 2). Per le task aperte la settimana
 * effettiva è `greatest(planned_week, lunedì corrente)`, quindi la condizione
 * si scrive su `planned_week` nuda — e l'indice
 * `tickets_assignee_planned_week_idx` (sulle aperte) serve; solo le chiuse
 * passano dalla funzione. Il risultato è identico alla funzione
 * (`week-conditions.test.ts`).
 */
export function effectiveWeekIs(monday: string): SQL {
  // In testa una condizione sempre vera (la settimana effettiva non è mai
  // prima della pianificata): porta `planned_week` nella condizione dell'indice.
  return sql`(${tickets.plannedWeek} <= ${monday}::date and (
    (${tickets.closedAt} is null and (
      (${tickets.plannedWeek} = ${monday}::date and ${tickets.plannedWeek} >= stubwise_current_monday())
      or (${tickets.plannedWeek} < stubwise_current_monday() and stubwise_current_monday() = ${monday}::date)
    ))
    or (${tickets.closedAt} is not null
      and stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}) = ${monday}::date)
  ))`;
}

/** La settimana effettiva (lunedì–domenica) si sovrappone a `[from, to]` (date ISO, estremi inclusi). */
export function effectiveWeekOverlaps(from: string, to: string): SQL {
  return sql`(${tickets.plannedWeek} <= ${to}::date and (
    (${tickets.closedAt} is null and (
      (${tickets.plannedWeek} >= stubwise_current_monday()
        and ${tickets.plannedWeek} between (${from}::date - 6) and ${to}::date)
      or (${tickets.plannedWeek} < stubwise_current_monday()
        and stubwise_current_monday() <= ${to}::date and stubwise_current_monday() + 6 >= ${from}::date)
    ))
    or (${tickets.closedAt} is not null
      and stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}) <= ${to}::date
      and stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}) + 6 >= ${from}::date)
  ))`;
}

/** I filtri di `FilterCriteria` che si esprimono in SQL (tutti tranne `stalled`). */
export function taskFilterConditions(q: TaskListQuery, today: string): SQL[] {
  const c: SQL[] = [];
  if (q.projectIds?.length) c.push(inArray(tickets.projectId, q.projectIds));
  if (q.departmentIds?.length) c.push(inArray(tickets.departmentId, q.departmentIds));
  if (q.assigneeIds?.length) {
    const ids = q.assigneeIds.filter((a) => a !== "none");
    const parts: SQL[] = [];
    if (ids.length) parts.push(inArray(tickets.assigneeId, ids));
    if (q.assigneeIds.includes("none")) parts.push(isNull(tickets.assigneeId));
    c.push(or(...parts)!);
  }
  if (q.families?.length) c.push(inArray(projectStatuses.family, q.families));
  if (q.statusIds?.length) c.push(inArray(tickets.statusId, q.statusIds));
  if (q.sizes?.length) {
    const efforts = q.sizes.flatMap((s) => (s === "none" ? [] : [["XS", "S", "M", "L", "XL"].indexOf(s) + 1]));
    const parts: SQL[] = [];
    if (efforts.length) parts.push(inArray(tickets.effort, efforts));
    if (q.sizes.includes("none")) parts.push(isNull(tickets.effort));
    c.push(or(...parts)!);
  }
  if (q.milestoneIds?.length) c.push(inArray(tickets.milestoneId, q.milestoneIds));
  if (q.types?.length) c.push(inArray(tickets.type, q.types.flatMap((t) => DB_TYPES_FOR_UI[t] ?? [])));
  if (q.priorities?.length) c.push(inArray(tickets.priority, q.priorities));
  const text = q.text?.trim().toLowerCase();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    c.push(
      sql`(lower(${tickets.title}) like ${like} or lower(${projects.code} || '-' || ${tickets.number}) like ${like})`,
    );
  }
  if (q.periodField) {
    const range = queryPeriodRange(q, today);
    if (range) {
      if (q.periodField === "created") {
        c.push(gte(sql`(${tickets.createdAt} at time zone 'UTC')::date`, sql`${range.from}::date`));
        c.push(lte(sql`(${tickets.createdAt} at time zone 'UTC')::date`, sql`${range.to}::date`));
      } else if (q.periodField === "closed") {
        c.push(gte(sql`(${tickets.closedAt} at time zone 'UTC')::date`, sql`${range.from}::date`));
        c.push(lte(sql`(${tickets.closedAt} at time zone 'UTC')::date`, sql`${range.to}::date`));
      } else if (q.periodField === "due") {
        c.push(gte(tickets.dueDate, range.from));
        c.push(lte(tickets.dueDate, range.to));
      } else {
        // La settimana (effettiva, cioè con lo slittamento) si sovrappone al periodo.
        c.push(effectiveWeekOverlaps(range.from, range.to));
      }
    }
  }
  return c;
}

const SOURCE: Record<TicketSource, NonNullable<TaskViewData["source"]>> = {
  manual: "manual",
  sdk_error: "sdk",
  sdk_feedback: "sdk",
  api: "api",
  slack: "slack",
  webhook: "webhook",
  widget: "widget",
};

/** Lo stato del lavoro di Claude dall'ultimo job della task. */
export function claudeStateOf(status: AiJobStatus | null): ClaudeWorkStateView {
  switch (status) {
    case null:
      return "none";
    case "queued":
    case "triaging":
    case "fixing":
      return "working";
    case "awaiting_input":
      return "awaiting_answer";
    case "awaiting_plan_approval":
      return "awaiting_approval";
    case "held":
    case "failed":
    case "pr_closed":
      return "stopped";
    case "pr_opened":
    case "pr_merged":
      return "done";
    case "skipped":
      return "none";
  }
}

const LINK_KIND = { blocks: "blocks", relates_to: "relates", parent: "parent" } as const;

export interface LoadedTask {
  view: TaskViewData;
  family: StatusFamily;
}

/**
 * Le viste delle task che chi guarda vede e che rispettano `where`, al più
 * `limit`. La visibilità sta QUI, non nel chiamante: nessuna lettura delle
 * task la dimentica.
 */
export async function loadTaskViews(
  db: Db,
  viewer: TaskViewer,
  where: SQL[],
  limit = TASK_LIST_CAP + 1,
): Promise<LoadedTask[]> {
  const visible = await visibleTasksCondition(db, viewer);
  const lastActivity = sql<Date>`greatest(
    ${tickets.updatedAt},
    coalesce((select max(c.created_at) from ${comments} c where c.ticket_id = ${tickets.id}), ${tickets.updatedAt}),
    coalesce((select max(e.created_at) from ${ticketEvents} e where e.ticket_id = ${tickets.id}), ${tickets.updatedAt})
  )`;
  const rows = await db
    .select({
      t: tickets,
      code: projects.code,
      family: projectStatuses.family,
      lastActivityAt: lastActivity,
      // Lo slittamento DERIVATO (fetta 2): la regola sta nel DB, in UN posto.
      effectiveWeek: sql<string | null>`to_char(stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}), 'YYYY-MM-DD')`,
      slips: sql<number>`(${tickets.slipCount} + stubwise_slip_weeks(${tickets.plannedWeek}, ${tickets.closedAt}))::int`,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
    .where(and(...(visible ? [visible] : []), ...where))
    .orderBy(asc(projects.code), asc(tickets.number))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.t.id);

  const [followers, links, files, jobs, requests, permissionsByProject] = await Promise.all([
    db.select().from(ticketFollowers).where(inArray(ticketFollowers.ticketId, ids)),
    // Solo i collegamenti verso task che chi guarda vede: l'id di una task
    // invisibile non esce nemmeno come riferimento (come in `stallsOf`).
    db
      .select({
        sourceTicketId: ticketLinks.sourceTicketId,
        targetTicketId: ticketLinks.targetTicketId,
        kind: ticketLinks.kind,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(tickets.id, ticketLinks.targetTicketId))
      .where(and(inArray(ticketLinks.sourceTicketId, ids), ...(visible ? [visible] : [])))
      .orderBy(asc(ticketLinks.createdAt)),
    db
      .select({ id: attachments.id, ticketId: attachments.ticketId, name: attachments.filename, sizeBytes: attachments.sizeBytes })
      .from(attachments)
      .where(and(inArray(attachments.ticketId, ids), isNull(attachments.commentId)))
      .orderBy(asc(attachments.createdAt)),
    db
      .selectDistinctOn([aiJobs.ticketId], { ticketId: aiJobs.ticketId, status: aiJobs.status })
      .from(aiJobs)
      .where(inArray(aiJobs.ticketId, ids))
      .orderBy(aiJobs.ticketId, desc(aiJobs.createdAt)),
    db
      .select({ ticketId: backlogItemTickets.ticketId, itemId: backlogItemTickets.itemId })
      .from(backlogItemTickets)
      .where(and(inArray(backlogItemTickets.ticketId, ids), eq(backlogItemTickets.role, "converted_to"))),
    // I permessi di chi guarda per progetto, in UNA query: servono a `canPlan`.
    projectPermissionsMap(db, viewer),
  ]);
  const group = <T extends { ticketId: string }>(items: T[]) => {
    const map = new Map<string, T[]>();
    for (const item of items) map.set(item.ticketId, [...(map.get(item.ticketId) ?? []), item]);
    return map;
  };
  const followersOf = group(followers);
  const linksOf = new Map<string, typeof links>();
  for (const l of links) linksOf.set(l.sourceTicketId, [...(linksOf.get(l.sourceTicketId) ?? []), l]);
  const filesOf = group(files);
  const jobOf = new Map(jobs.map((j) => [j.ticketId, j.status]));
  const requestOf = new Map(requests.map((r) => [r.ticketId, r.itemId]));

  const canPlanOf = (task: { projectId: string; assigneeId: string | null; closedAt: Date | null }) => {
    const perms = new Set(permissionsByProject[task.projectId] ?? []);
    return canMove(
      {
        id: "",
        projectId: task.projectId,
        assigneeId: task.assigneeId,
        size: null,
        plannedWeek: null,
        slipCount: 0,
        closedAt: task.closedAt?.toISOString() ?? null,
      },
      { me: viewer.id, others: perms.has("planning.others"), edit: perms.has("tickets.edit"), members: [] },
    );
  };

  return rows.map(({ t, code, family, lastActivityAt, effectiveWeek, slips }) => ({
    family,
    view: {
      id: t.id,
      ticketId: t.id,
      number: t.number,
      code: `${code}-${t.number}`,
      projectId: t.projectId,
      title: t.title,
      description: t.body,
      statusId: t.statusId,
      departmentId: t.departmentId,
      assigneeId: t.assigneeId,
      createdById: t.requestedByUserId,
      followerIds: (followersOf.get(t.id) ?? []).map((f) => f.userId),
      size: sizeFromEffort(t.effort),
      dueDate: t.dueDate,
      plannedWeek: effectiveWeek ? mondayToIsoWeek(effectiveWeek) : null,
      slipCount: slips,
      milestoneId: t.milestoneId,
      labels: t.labels,
      type: uiTypeOf(t.type),
      priority: t.priority,
      requestId: requestOf.get(t.id) ?? null,
      links: (linksOf.get(t.id) ?? []).map((l) => ({ kind: LINK_KIND[l.kind], taskId: l.targetTicketId })),
      attachments: (filesOf.get(t.id) ?? []).map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes })),
      manualStall:
        t.manualStallReason && t.manualStallSince
          ? {
              reason: t.manualStallReason,
              note: t.manualStallNote ?? "",
              since: t.manualStallSince.toISOString(),
              byId: t.manualStallByUserId,
            }
          : null,
      claude: claudeStateOf(jobOf.get(t.id) ?? null),
      createdAt: t.createdAt.toISOString(),
      closedAt: t.closedAt?.toISOString() ?? null,
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      source: SOURCE[t.source],
      occurrences: t.occurrences,
      technical: null,
      assigneeStatus: t.assigneeId ? "active" : null,
      canPlan: canPlanOf(t),
    },
  }));
}

/**
 * Le ferme delle task date, con `stallOf` di `@stubwise/shared` (la stessa
 * regola del prototipo). Le bloccanti contano solo se chi guarda le vede: una
 * task invisibile non entra nemmeno come motivo.
 */
export async function stallsOf(
  db: Db,
  viewer: TaskViewer,
  tasks: LoadedTask[],
  today: string,
): Promise<Map<string, Stall>> {
  const open = tasks.filter((t) => t.family !== "closed");
  const result = new Map<string, Stall>();
  if (open.length === 0) return result;
  const ids = open.map((t) => t.view.id);
  const visible = await visibleTasksCondition(db, viewer);

  const [decisions, questions, blockers, thresholds] = await Promise.all([
    db
      .select({
        ticketId: decisionRequests.ticketId,
        askedOfId: decisionRequests.askedOfUserId,
        createdAt: decisionRequests.createdAt,
      })
      .from(decisionRequests)
      .where(
        and(
          inArray(decisionRequests.ticketId, ids),
          isNull(decisionRequests.answeredAt),
          isNull(decisionRequests.withdrawnAt),
        ),
      ),
    // La domanda `ask_user` aperta di un job fermo ad aspettarla (la stessa
    // sorgente di `GET /api/tickets/:id/questions`).
    db
      .select({ ticketId: agentQuestions.ticketId, since: sql<Date>`min(${agentQuestions.askedAt})` })
      .from(agentQuestions)
      .innerJoin(aiJobs, eq(aiJobs.id, agentQuestions.jobId))
      .where(
        and(
          inArray(agentQuestions.ticketId, ids),
          isNull(agentQuestions.answeredAt),
          eq(aiJobs.status, "awaiting_input"),
        ),
      )
      .groupBy(agentQuestions.ticketId),
    db
      .select({
        targetId: ticketLinks.targetTicketId,
        id: tickets.id,
        family: projectStatuses.family,
        since: tickets.updatedAt,
      })
      .from(ticketLinks)
      .innerJoin(tickets, eq(tickets.id, ticketLinks.sourceTicketId))
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(and(inArray(ticketLinks.targetTicketId, ids), eq(ticketLinks.kind, "blocks"), ...(visible ? [visible] : [])))
      .orderBy(asc(ticketLinks.createdAt)),
    db
      .select({ id: projects.id, activeDays: projects.stallActiveDays, todoDays: projects.stallTodoDays })
      .from(projects)
      .where(inArray(projects.id, [...new Set(open.map((t) => t.view.projectId))])),
  ]);
  const thresholdsOf = new Map(thresholds.map((p) => [p.id, { activeDays: p.activeDays, todoDays: p.todoDays }]));

  for (const { view, family } of open) {
    const stall = stallOf(
      {
        id: view.id,
        assigneeId: view.assigneeId,
        manualStall: view.manualStall,
        links: view.links,
        lastActivityAt: view.lastActivityAt,
        plannedWeek: view.plannedWeek,
        slipCount: view.slipCount,
      },
      {
        family,
        openDecisions: decisions
          .filter((d) => d.ticketId === view.id)
          .map((d) => ({ askedOfId: d.askedOfId, createdAt: d.createdAt.toISOString() })),
        claudeQuestionSince: (() => {
          const q = questions.find((x) => x.ticketId === view.id);
          return q ? new Date(q.since).toISOString() : null;
        })(),
        blockers: blockers
          .filter((b) => b.targetId === view.id)
          .map((b) => ({ id: b.id, family: b.family, since: b.since.toISOString() })),
        thresholds: thresholdsOf.get(view.projectId) ?? { activeDays: 7, todoDays: 14 },
      },
      today,
    );
    if (stall) result.set(view.id, stall);
  }
  return result;
}
