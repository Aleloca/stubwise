import {
  backlogItemRequesters,
  backlogItemTickets,
  backlogItems,
  departmentMembers,
  departments,
  milestones,
  projectStatuses,
  projects,
  ticketEvents,
  ticketFollowers,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  effortFromSize,
  compareWeeks,
  currentIsoWeek,
  isoWeekToMonday,
  mondayToIsoWeek,
  planBlock,
  planRecipientsOf,
  ticketTypeFor,
  uiTypeOf,
  type NewTaskBody,
  type TaskPatch,
  type TaskViewData,
} from "@stubwise/shared";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { projectViewerIds } from "@stubwise/notifications";
import { projectIdsWithPermission, projectPermissionsFor, projectPermissionsOfUser } from "../auth/access.js";
import { backlogVisibleSql } from "./backlog-visibility.js";
import { closeRefineSessionForItem } from "./backlog-refine.js";
import { createTicket, type Ticket } from "../db/tickets.js";
import { diffTicketEvents, userExists } from "./tickets.js";
import { loadTaskViews, visibleTasksCondition, type TaskViewer } from "./task-view.js";
import { personName } from "./people.js";
import { notifyTaskActivity, notifyTaskPeople } from "./task-notify.js";
import { agentUserId, claudeAssignGuard, startClaudeRuns } from "./claude-assign.js";

/**
 * Le scritture delle task dall'app nuova (integrazione area 2, fetta 1).
 *
 * - Una task creata qui NON passa dall'intake del backlog
 *   (`maybeEnqueueBacklogIntake`): è una task per definizione; le richieste si
 *   mandano da Requests (fetta 4). Web vecchio, MCP e SDK restano come oggi.
 * - Lo stato vero è `status_id`: l'enum lo deriva il trigger
 *   (`docs/invariants/tasks.md`), qui non si scrive mai a mano.
 * - Il tipo si riscrive solo se il tipo MOSTRATO cambia (`feedback` resta
 *   `feedback` finché resta una funzionalità).
 * - Chi crea e chi è assegnato seguono la task (da ora in avanti).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TaskWriteError =
  | "status_not_in_project"
  | "department_not_found"
  | "assignee_not_found"
  | "milestone_cross_project"
  | "request_not_found"
  | "request_not_convertible"
  | "past_week"
  /** Assegnare Claude avvia il lavoro: chiede `runs.start` nel progetto (fetta 3e). */
  | "claude_assign_forbidden";

export type TaskWriteResult = { ok: true; task: TaskViewData } | { ok: false; error: TaskWriteError };

async function viewOf(db: Db, viewer: TaskViewer, ticketId: string): Promise<TaskViewData> {
  const [loaded] = await loadTaskViews(db, viewer, [eq(tickets.id, ticketId)], 1);
  if (!loaded) throw new Error(`task ${ticketId} non visibile dopo la scrittura`);
  return loaded.view;
}

async function statusInProject(db: Db | Tx, statusId: string, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));
  return row !== undefined;
}

async function departmentExists(db: Db | Tx, id: string): Promise<boolean> {
  const [row] = await db.select({ id: departments.id }).from(departments).where(eq(departments.id, id));
  return row !== undefined;
}

async function milestoneInProject(db: Db | Tx, id: string, projectId: string): Promise<boolean> {
  const [row] = await db.select({ projectId: milestones.projectId }).from(milestones).where(eq(milestones.id, id));
  return row?.projectId === projectId;
}

/** Il primo reparto della persona (posizione minima), se ne ha. */
async function firstDepartmentOf(db: Db | Tx, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(eq(departmentMembers.userId, userId))
    .orderBy(asc(departmentMembers.position), asc(departmentMembers.departmentId))
    .limit(1);
  return row?.id;
}

/**
 * La regola di `canSeeTicket` per un utente qualsiasi (non chi chiede):
 * `tickets.view_all` nel progetto della task, oppure è lui ad averla chiesta.
 */
async function canUserSeeTicket(db: Db | Tx, userId: string, ticketId: string): Promise<boolean> {
  // L'utente di sistema «Claude» lavora su ogni task che gli si assegna.
  if (userId === (await agentUserId(db))) return true;
  const [ticket] = await db
    .select({ projectId: tickets.projectId, requestedBy: tickets.requestedByUserId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket) return false;
  const permissions = await projectPermissionsOfUser(db as Db, userId, ticket.projectId);
  return permissions !== null && (permissions.has("tickets.view_all") || ticket.requestedBy === userId);
}

async function follow(db: Db | Tx, ticketId: string, userIds: (string | null | undefined)[]): Promise<void> {
  const agent = await agentUserId(db);
  // Claude non segue niente: non riceve notifiche.
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== agent))];
  if (ids.length === 0) return;
  await db
    .insert(ticketFollowers)
    .values(ids.map((userId) => ({ ticketId, userId })))
    .onConflictDoNothing();
}

/** Le validazioni dei campi che puntano ad altro (stato, reparto, persona, traguardo). */
async function validateRefs(
  db: Db | Tx,
  projectId: string,
  refs: { statusId?: string; departmentId?: string; assigneeId?: string | null; milestoneId?: string | null },
): Promise<TaskWriteError | null> {
  if (refs.statusId && !(await statusInProject(db, refs.statusId, projectId))) return "status_not_in_project";
  if (refs.departmentId && !(await departmentExists(db, refs.departmentId))) return "department_not_found";
  if (typeof refs.assigneeId === "string" && !(await userExists(db, refs.assigneeId))) return "assignee_not_found";
  if (typeof refs.milestoneId === "string" && !(await milestoneInProject(db, refs.milestoneId, projectId))) {
    return "milestone_cross_project";
  }
  return null;
}

export async function createTask(db: Db, viewer: TaskViewer, body: NewTaskBody): Promise<TaskWriteResult> {
  const invalid = (await validateRefs(db, body.projectId, body)) ?? (await claudeAssignGuard(db, viewer, body.projectId, body.assigneeId));
  if (invalid) return { ok: false, error: invalid };
  if (await isPastWeek(db, null, body.plannedWeek)) return { ok: false, error: "past_week" };
  if (body.requestId) {
    // Solo una voce che chi chiede VEDE (la regola di `backlog.view_all`,
    // quella di to-convert): una invisibile risponde come un'inesistente
    // (fix della review della fetta 3), così 400/409/201 non dicono se esiste.
    const visible = backlogVisibleSql(await projectIdsWithPermission(db, viewer, "backlog.view_all"), viewer.id);
    const [item] = await db
      .select({ projectId: backlogItems.projectId, status: backlogItems.status })
      .from(backlogItems)
      .where(and(eq(backlogItems.id, body.requestId), ...(visible ? [visible] : [])));
    if (item?.projectId !== body.projectId) return { ok: false, error: "request_not_found" };
    // Come nel prototipo: una voce già convertita o archiviata non si converte.
    if (item.status === "converted" || item.status === "archived") return { ok: false, error: "request_not_convertible" };
    // Trasformare una richiesta chiede `tickets.create` (lo verifica la
    // rotta): «crea una task da zero o da una richiesta», design dell'area 2.
  }
  const seesAll = body.requestId
    ? ((await projectPermissionsFor(db, viewer, body.projectId))?.has("tickets.view_all") ?? false)
    : false;
  const ticketId = await db.transaction(async (tx) => {
    if (body.requestId) {
      // La richiesta diventa `converted` per PRIMA cosa (fix della fetta 3,
      // la claim di `convertBacklogItem`): due conversioni concorrenti si
      // serializzano sulla riga della voce, e la seconda esce senza aver
      // creato niente. La sua sessione di refinement si chiude.
      const claimed = await tx
        .update(backlogItems)
        .set({ status: "converted" })
        .where(and(eq(backlogItems.id, body.requestId), notInArray(backlogItems.status, ["converted", "archived"])))
        .returning({ id: backlogItems.id });
      if (claimed.length === 0) return null;
      await closeRefineSessionForItem(tx, body.requestId);
    }
    // La task nata da una richiesta eredita il richiedente PIÙ VECCHIO della
    // voce, come `convertBacklogItem` (fix della review della fetta 3); effort
    // e piano no, come nel prototipo. Eccezione: chi converte senza
    // `tickets.view_all` resta richiedente se il più vecchio è un altro,
    // altrimenti non vedrebbe la task che ha appena creato.
    let requestedBy = viewer.id;
    if (body.requestId) {
      const [oldest] = await tx
        .select({ userId: backlogItemRequesters.userId })
        .from(backlogItemRequesters)
        .where(eq(backlogItemRequesters.itemId, body.requestId))
        .orderBy(asc(backlogItemRequesters.requestedAt), asc(backlogItemRequesters.userId))
        .limit(1);
      if (oldest && (oldest.userId === viewer.id || seesAll)) requestedBy = oldest.userId;
    }
    const departmentId = body.departmentId ?? (await firstDepartmentOf(tx, viewer.id));
    const [firstTodo] = await tx
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, body.projectId), eq(projectStatuses.family, "todo")))
      .orderBy(asc(projectStatuses.position))
      .limit(1);
    // `createTicket` apre una transazione sua: dentro `tx` diventa un savepoint.
    const ticket = await createTicket(tx as unknown as Db, {
      projectId: body.projectId,
      title: body.title,
      body: body.description ?? "",
      type: ticketTypeFor(body.type),
      priority: body.priority ?? "medium",
      source: "manual",
      ...(body.assigneeId ? { assigneeId: body.assigneeId } : {}),
      requestedByUserId: requestedBy,
      // Senza reparto il trigger mette il ripiego.
      ...(departmentId ? { departmentId } : {}),
      statusId: body.statusId ?? firstTodo?.id,
      effort: effortFromSize(body.size ?? null),
      milestoneId: body.milestoneId ?? null,
      ...(body.plannedWeek ? { plannedWeek: isoWeekToMonday(body.plannedWeek) } : {}),
    });
    // Chi crea vede la task (l'ha chiesta lui); l'assegnatario segue solo se la vede.
    await follow(tx, ticket.id, [
      viewer.id,
      body.assigneeId && (await canUserSeeTicket(tx, body.assigneeId, ticket.id)) ? body.assigneeId : null,
    ]);
    if (body.requestId) {
      await tx
        .insert(backlogItemTickets)
        .values({ itemId: body.requestId, ticketId: ticket.id, role: "converted_to" })
        .onConflictDoNothing();
    }
    return ticket.id;
  });
  if (ticketId === null) return { ok: false, error: "request_not_convertible" };
  if (body.assigneeId && body.assigneeId === (await agentUserId(db))) {
    await startClaudeRuns(db, viewer, [{ ticketId, projectId: body.projectId }]);
  }
  return { ok: true, task: await viewOf(db, viewer, ticketId) };
}

/** Le colonne che una patch dell'app nuova scrive, già tradotte nel modello del DB. */
function updatesFor(current: Ticket, patch: TaskPatch): Partial<Ticket> {
  const updates: Partial<Ticket> = {};
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.body = patch.description;
  if (patch.statusId !== undefined) updates.statusId = patch.statusId;
  if (patch.departmentId !== undefined) updates.departmentId = patch.departmentId;
  // Uguale a com'è non si scrive (fix della review della fetta 2): un plan o
  // una patch senza cambiamenti non fa l'UPDATE, che sposterebbe `updated_at`
  // (l'inattività delle ferme).
  if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) updates.assigneeId = patch.assigneeId;
  if (patch.size !== undefined) updates.effort = effortFromSize(patch.size);
  if (patch.dueDate !== undefined) updates.dueDate = patch.dueDate;
  // Il lunedì nel DB; il consolidamento dello slittamento lo fa il trigger.
  if (patch.plannedWeek !== undefined) {
    const monday = patch.plannedWeek === null ? null : isoWeekToMonday(patch.plannedWeek);
    if (monday !== current.plannedWeek) updates.plannedWeek = monday;
  }
  if (patch.milestoneId !== undefined) updates.milestoneId = patch.milestoneId;
  if (patch.labels !== undefined) updates.labels = patch.labels;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.type !== undefined && uiTypeOf(current.type) !== patch.type) updates.type = ticketTypeFor(patch.type);
  return updates;
}

/** La settimana EFFETTIVA di una task (slittamento compreso), `YYYY-Www`. */
async function effectiveWeekOf(tx: Db | Tx, ticketId: string): Promise<string | null> {
  const [row] = await tx
    .select({
      week: sql<string | null>`to_char(stubwise_effective_week(${tickets.plannedWeek}, ${tickets.closedAt}), 'YYYY-MM-DD')`,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return row?.week ? mondayToIsoWeek(row.week) : null;
}

/**
 * Una settimana PASSATA non si scrive (fix della review della fetta 2):
 * gonfierebbe `slipCount`, che è un dato mostrato. Eccezione: la settimana
 * EFFETTIVA attuale della task (la corrente di una slittata, quella di
 * chiusura di una chiusa), che per chi guarda è un no-op. Il «passato» è
 * rispetto alla settimana corrente di Europe/Rome (`currentIsoWeek`).
 */
async function isPastWeek(db: Db | Tx, ticketId: string | null, week: string | null | undefined): Promise<boolean> {
  if (!week || compareWeeks(week, currentIsoWeek(new Date())) >= 0) return false;
  return ticketId === null || (await effectiveWeekOf(db, ticketId)) !== week;
}

/**
 * Applica una patch a una task DENTRO `tx`, con gli eventi della timeline.
 * Il cambio di stato scrive lo `status_changed` di oggi (`from`/`to`
 * dell'enum, che leggono storia del ticket e mobile) più gli id degli stati
 * (`fromStatusId`/`toStatusId`), con cui l'attività mostra il nome dello stato
 * anche fra due stati personalizzati della stessa famiglia.
 *
 * Fetta 2: anche settimana (`planned_week_changed`, dalla settimana EFFETTIVA
 * di prima, `YYYY-Www`), reparto (`department_changed`, id) e taglia
 * (`effort_changed`, effort 1–5): sono scritture UMANE, e solo questa
 * funzione le scrive — la riassegnazione d'ufficio quando si elimina un
 * reparto resta fuori dal feed. `task.assigned` va a chi riceve la task da un
 * altro; `planning.changed` (a chi l'aveva) solo con `notifyPlanning`, cioè
 * dalla rotta di pianificazione, come nel prototipo.
 */
export async function applyTaskPatch(
  tx: Tx,
  actorId: string,
  current: Ticket,
  patch: TaskPatch,
  opts: { notifyPlanning?: boolean } = {},
): Promise<Ticket> {
  const updates = updatesFor(current, patch);
  if (Object.keys(updates).length === 0) return current;
  const fromWeek = updates.plannedWeek !== undefined ? await effectiveWeekOf(tx, current.id) : null;
  const [updated] = await tx.update(tickets).set(updates).where(eq(tickets.id, current.id)).returning();
  const events: { kind: (typeof ticketEvents.$inferInsert)["kind"]; payload: Record<string, unknown> }[] =
    diffTicketEvents(current, updates).map((e) => ({ kind: e.kind, payload: e.payload as Record<string, unknown> }));
  if (updates.statusId !== undefined && updates.statusId !== current.statusId) {
    events.push({
      kind: "status_changed",
      payload: {
        from: current.status,
        to: updated!.status,
        fromStatusId: current.statusId,
        toStatusId: updated!.statusId,
      },
    });
  }
  const toWeek = updated!.plannedWeek ? mondayToIsoWeek(updated!.plannedWeek) : null;
  if (updates.plannedWeek !== undefined && fromWeek !== toWeek) {
    events.push({ kind: "planned_week_changed", payload: { from: fromWeek, to: toWeek } });
  }
  if (updates.departmentId !== undefined && updates.departmentId !== current.departmentId) {
    events.push({ kind: "department_changed", payload: { from: current.departmentId, to: updates.departmentId } });
  }
  if (updates.effort !== undefined && updates.effort !== current.effort) {
    events.push({ kind: "effort_changed", payload: { from: current.effort, to: updates.effort } });
  }
  if (events.length > 0) {
    await tx.insert(ticketEvents).values(events.map((e) => ({ ...e, ticketId: current.id, actorId })));
  }
  // Assegnare resta permesso anche a chi non vede la task (lo dice
  // `assigneeWithoutAccess`), ma un follower riceve solo ciò che vede.
  if (updates.assigneeId && (await canUserSeeTicket(tx, updates.assigneeId, current.id))) {
    await follow(tx, current.id, [updates.assigneeId]);
  }

  // Chi riceve gli avvisi personali: la regola del prototipo, una sola.
  const reassigned = updates.assigneeId !== undefined && updates.assigneeId !== current.assigneeId;
  // Senza la settimana nella patch, prima e dopo coincidono: «spostata» no.
  const weekChanged = updates.plannedWeek !== undefined;
  const recipients = planRecipientsOf(
    actorId,
    { assigneeId: current.assigneeId, plannedWeek: weekChanged ? fromWeek : null },
    { assigneeId: updated!.assigneeId, week: weekChanged ? toWeek : null },
  );
  const planningChanged = opts.notifyPlanning ? recipients.planningChanged : [];
  const [person] = updated!.assigneeId
    ? await tx
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, updated!.assigneeId))
    : [];
  if (recipients.assigned) {
    await notifyTaskPeople(tx, {
      kind: "task.assigned",
      ticketId: current.id,
      actorUserId: actorId,
      recipientUserId: recipients.assigned,
    });
  }
  for (const recipientUserId of planningChanged) {
    await notifyTaskPeople(tx, {
      kind: "planning.changed",
      ticketId: current.id,
      actorUserId: actorId,
      recipientUserId,
      fromWeek: weekChanged ? fromWeek : toWeek,
      toWeek,
      fromAssigneeId: current.assigneeId,
      toAssigneeId: updated!.assigneeId,
      toAssigneeName: person ? personName(person) : null,
    });
  }

  // I follower sanno dei cambi UMANI di stato e assegnatario (Task 9). Il
  // `summary` è un dato (nome dello stato, nome della persona), la frase la
  // mette il template della lingua di chi legge.
  if (updates.statusId !== undefined && updates.statusId !== current.statusId) {
    const [status] = await tx
      .select({ name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.id, updated!.statusId));
    await notifyTaskActivity(tx, { ticketId: current.id, actorUserId: actorId, change: "status", summary: status?.name ?? "" });
  }
  if (reassigned) {
    // Chi ha già la card precisa (`task.assigned`, `planning.changed`) non
    // riceve anche l'attività.
    const precise = [...(recipients.assigned ? [recipients.assigned] : []), ...planningChanged];
    await notifyTaskActivity(tx, {
      ticketId: current.id,
      actorUserId: actorId,
      change: "assignee",
      summary: person ? personName(person) : "—",
      ...(precise.length > 0 ? { excludeUserIds: precise } : {}),
    });
  }
  return updated!;
}

export async function updateTask(
  db: Db,
  viewer: TaskViewer,
  ticketId: string,
  patch: TaskPatch,
): Promise<TaskWriteResult> {
  const [current] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!current) throw new Error(`task ${ticketId} assente dopo il controllo d'accesso`);
  const invalid = (await validateRefs(db, current.projectId, patch)) ?? (await claudeAssignGuard(db, viewer, current.projectId, patch.assigneeId));
  if (invalid) return { ok: false, error: invalid };
  if (await isPastWeek(db, current.id, patch.plannedWeek)) return { ok: false, error: "past_week" };
  await db.transaction(async (tx) => {
    await applyTaskPatch(tx, viewer.id, current, patch);
  });
  const agent = await agentUserId(db);
  if (agent && patch.assigneeId === agent && current.assigneeId !== agent) {
    await startClaudeRuns(db, viewer, [{ ticketId, projectId: current.projectId }]);
  }
  return { ok: true, task: await viewOf(db, viewer, ticketId) };
}

export type BulkPatch = Pick<
  TaskPatch,
  "statusId" | "assigneeId" | "milestoneId" | "size" | "departmentId" | "plannedWeek"
>;

export type BulkResult =
  | { ok: true; tasks: TaskViewData[] }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "forbidden"; codes: string[] }
  | { ok: false; error: "status_cross_project" }
  | { ok: false; error: TaskWriteError };

/**
 * Azioni in blocco: `tickets.edit` verificato PER TASK, tutto o niente. Una
 * task che chi agisce non vede rende la richiesta un 404 (come per una sola),
 * così il codice di una task invisibile non esce in un 403.
 */
export async function bulkUpdateTasks(
  db: Db,
  viewer: TaskViewer,
  ids: string[],
  patch: BulkPatch,
): Promise<BulkResult> {
  const unique = [...new Set(ids)];
  const visible = await visibleTasksCondition(db, viewer);
  const rows = await db
    .select({ t: tickets, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(inArray(tickets.id, unique), ...(visible ? [visible] : [])));
  if (rows.length !== unique.length) return { ok: false, error: "not_found" };

  const projectIds = [...new Set(rows.map((r) => r.t.projectId))];
  const canEdit = new Map<string, boolean>();
  for (const pid of projectIds) {
    canEdit.set(pid, (await projectPermissionsFor(db, viewer, pid))?.has("tickets.edit") ?? false);
  }
  const refused = rows.filter((r) => !canEdit.get(r.t.projectId)).map((r) => `${r.code}-${r.t.number}`);
  if (refused.length > 0) return { ok: false, error: "forbidden", codes: refused };

  if (patch.statusId !== undefined && projectIds.length > 1) return { ok: false, error: "status_cross_project" };
  for (const pid of projectIds) {
    const invalid = (await validateRefs(db, pid, patch)) ?? (await claudeAssignGuard(db, viewer, pid, patch.assigneeId));
    if (invalid) return { ok: false, error: invalid };
  }
  for (const { t } of rows) {
    if (await isPastWeek(db, t.id, patch.plannedWeek)) return { ok: false, error: "past_week" };
  }
  await db.transaction(async (tx) => {
    for (const { t } of rows) await applyTaskPatch(tx, viewer.id, t, patch);
  });
  const agent = await agentUserId(db);
  if (agent && patch.assigneeId === agent) {
    await startClaudeRuns(
      db,
      viewer,
      rows.filter(({ t }) => t.assigneeId !== agent).map(({ t }) => ({ ticketId: t.id, projectId: t.projectId })),
    );
  }
  const views = await loadTaskViews(db, viewer, [inArray(tickets.id, unique)]);
  const byId = new Map(views.map((v) => [v.view.id, v.view]));
  return { ok: true, tasks: unique.map((id) => byId.get(id)!) };
}

export async function setManualStall(
  db: Db,
  viewer: TaskViewer,
  ticketId: string,
  stall: { reason: string; note?: string } | null,
): Promise<TaskViewData> {
  await db
    .update(tickets)
    .set(
      stall
        ? {
            manualStallReason: stall.reason,
            manualStallNote: stall.note ?? null,
            manualStallSince: new Date(),
            manualStallByUserId: viewer.id,
          }
        : { manualStallReason: null, manualStallNote: null, manualStallSince: null, manualStallByUserId: null },
    )
    .where(eq(tickets.id, ticketId));
  return viewOf(db, viewer, ticketId);
}

export async function setFollowing(db: Db, userId: string, ticketId: string, following: boolean): Promise<void> {
  if (following) await follow(db, ticketId, [userId]);
  else
    await db
      .delete(ticketFollowers)
      .where(and(eq(ticketFollowers.ticketId, ticketId), eq(ticketFollowers.userId, userId)));
}

export type PlanResult =
  | { ok: true; task: TaskViewData }
  | { ok: false; error: PlanError };

type PlanError = "forbidden" | "invalid_assignee" | "past_week" | "claude_assign_forbidden";

/**
 * Pianificare dal Planning (fetta 2): persona e settimana insieme. Decide
 * `planBlock` di `@stubwise/shared` (la regola del prototipo), coi diritti
 * calcolati QUI: con `planning.others` per chiunque sia membro del progetto
 * (full admin compresi, membri impliciti); senza, solo il proprio — una task
 * già mia, o una non assegnata che prendo per me con `tickets.edit`. PATCH e
 * bulk restano su `tickets.edit`, come `prepareTaskPatch` nel prototipo.
 */
export async function planTask(
  db: Db,
  viewer: TaskViewer,
  ticketId: string,
  plan: { assigneeId: string | null; week: string | null },
): Promise<PlanResult> {
  // La decisione si prende sulla riga BLOCCATA, nella transazione che scrive
  // (fix della review della fetta 2): letta prima, una riassegnazione
  // concorrente passerebbe sotto la regola e verrebbe sovrascritta.
  let claudeRun: { ticketId: string; projectId: string } | null = null;
  const outcome = await db.transaction(async (tx): Promise<PlanError | null> => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for("update");
    if (!current) throw new Error(`task ${ticketId} assente dopo il controllo d'accesso`);
    const permissions = (await projectPermissionsFor(tx, viewer, current.projectId)) ?? new Set();
    // Claude (fetta 3e): pianificarlo vuol dire avviare il lavoro, quindi la
    // regola è `runs.start`, non `planning.others` (che riguarda le PERSONE).
    const agent = await agentUserId(tx);
    if (agent && plan.assigneeId === agent) {
      if (!permissions.has("runs.start")) return "claude_assign_forbidden";
      // Come la PATCH (review dell'area 3, punto 4): assegnare è modificare la
      // task, e un lavoro non parte su una task chiusa.
      if (!permissions.has("tickets.edit") || current.closedAt !== null) return "forbidden";
      if (await isPastWeek(tx, current.id, plan.week)) return "past_week";
      await applyTaskPatch(tx, viewer.id, current, { assigneeId: agent, plannedWeek: plan.week }, { notifyPlanning: true });
      if (current.assigneeId !== agent) claudeRun = { ticketId, projectId: current.projectId };
      return null;
    }
    const members = await projectViewerIds(tx, current.projectId);
    // `assigneeId: null` sulla rotta TOGLIE l'assegnatario (per `planBlock`
    // `null` è la vasca, che tiene la persona): con `planning.others` sempre,
    // anche se chi l'aveva non è più membro; senza, solo dalla propria task.
    const others = permissions.has("planning.others");
    if (plan.assigneeId === null) {
      if (!others && current.assigneeId !== viewer.id) return "forbidden";
      if (await isPastWeek(tx, current.id, plan.week)) return "past_week";
      await applyTaskPatch(tx, viewer.id, current, { assigneeId: null, plannedWeek: plan.week }, { notifyPlanning: true });
      return null;
    }
    const block = planBlock(
      {
        id: current.id,
        projectId: current.projectId,
        assigneeId: current.assigneeId,
        size: null,
        plannedWeek: null,
        slipCount: 0,
        closedAt: current.closedAt?.toISOString() ?? null,
      },
      plan.assigneeId,
      {
        me: viewer.id,
        others,
        edit: permissions.has("tickets.edit"),
        members,
      },
    );
    if (block === "others") return "forbidden";
    if (block === "member") return "invalid_assignee";
    if (await isPastWeek(tx, current.id, plan.week)) return "past_week";
    await applyTaskPatch(
      tx,
      viewer.id,
      current,
      { assigneeId: plan.assigneeId, plannedWeek: plan.week },
      { notifyPlanning: true },
    );
    return null;
  });
  if (outcome) return { ok: false, error: outcome };
  if (claudeRun) await startClaudeRuns(db, viewer, [claudeRun]);
  return { ok: true, task: await viewOf(db, viewer, ticketId) };
}
