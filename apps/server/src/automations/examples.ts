import { backlogItems, backlogItemTickets, emailMessages, milestones, projectMembers, projects, roles, tickets, type Db } from "@stubwise/db";
import { automationEventFields, automationMailboxOf, loadPlanWorld, projectPermissionsByProject, type AutomationEventRef } from "@stubwise/notifications";
import {
  evaluate,
  lookup,
  projectOf,
  visitSteps,
  type AutomationFlow,
  type OwnerMailbox,
  type SimulationContext,
  type SimulationContextProject,
  type SimulationExample,
  type SimulationExamplesView,
  type SimulationPerson,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { AutomationError, automationOf, configErrorsOf, mailboxAddresses, managedAutomation, seen, sees, versionsOf, type Viewer } from "./model.js";

/**
 * GLI ESEMPI E IL CONTESTO DELLA PROVA (area 7, fetta 1; la specifica è
 * `data/automations/examples.ts` del prototipo e la forma concordata con 94,
 * `SimulationExamplesView`). Sola lettura, per chi GESTISCE l'automazione.
 *
 * - Gli esempi di un inizio di Stubwise sono gli oggetti VERI più recenti del
 *   progetto dell'automazione che corrispondono all'inizio (filtro compreso),
 *   coi campi che ne leggerebbe un'esecuzione (`automationEventFields`, la
 *   stessa funzione del consumatore). Per un avvio a mano, la data di oggi.
 * - Il contesto sono i fatti che i piani della prova leggono, risolti qui per
 *   chi prova e per il proprietario che la versione avrebbe: chi vede ogni
 *   progetto toccato (`seenBy`), cosa il proprietario può creare (`ownerCan`,
 *   solo se lo vede), chi ha ogni ruolo e i membri dei reparti nominati.
 *   R-G5: in un progetto che chi prova non vede, lui non sta in `seenBy` e le
 *   liste restano vuote; le persone sono solo quelle che chi prova incontra
 *   nei progetti che vede, più sé e il proprietario.
 */

const MAX_EXAMPLES = 10;

/** Gli oggetti veri più recenti per l'inizio, come eventi. */
async function candidateEvents(db: Db, projectId: string, flow: AutomationFlow): Promise<{ ref: AutomationEventRef; label: string; code: string | null; at: Date | null }[]> {
  const t = flow.trigger;
  if (t.kind !== "stubwise") return [];
  const [p] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  const code = p?.code ?? "";
  const LIMIT = 50;
  switch (t.event) {
    case "task_created":
    case "task_closed": {
      const closed = t.event === "task_closed";
      const rows = await db
        .select({ id: tickets.id, title: tickets.title, number: tickets.number, createdAt: tickets.createdAt, closedAt: tickets.closedAt })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), closed ? isNotNull(tickets.closedAt) : undefined))
        .orderBy(desc(closed ? tickets.closedAt : tickets.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: t.event as "task_created", projectId, objectId: r.id, payload: {} }, label: r.title, code: `${code}-${r.number}`, at: closed ? r.closedAt : r.createdAt }));
    }
    case "request_created": {
      const rows = await db
        .select({ id: backlogItems.id, title: backlogItems.title, number: backlogItems.number, createdAt: backlogItems.createdAt })
        .from(backlogItems)
        .where(eq(backlogItems.projectId, projectId))
        .orderBy(desc(backlogItems.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "request_created" as const, projectId, objectId: r.id, payload: {} }, label: r.title, code: `${code}-R${r.number}`, at: r.createdAt }));
    }
    case "request_converted": {
      const rows = await db
        .select({ id: backlogItems.id, title: backlogItems.title, number: backlogItems.number, createdAt: backlogItems.createdAt, ticketId: backlogItemTickets.ticketId })
        .from(backlogItemTickets)
        .innerJoin(backlogItems, eq(backlogItems.id, backlogItemTickets.itemId))
        .where(and(eq(backlogItems.projectId, projectId), eq(backlogItemTickets.role, "converted_to")))
        .orderBy(desc(backlogItemTickets.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "request_converted" as const, projectId, objectId: r.id, payload: { ticketId: r.ticketId } }, label: r.title, code: `${code}-R${r.number}`, at: r.createdAt }));
    }
    case "milestone_reached": {
      const rows = await db
        .select({ id: milestones.id, name: milestones.name, closedAt: milestones.closedAt })
        .from(milestones)
        .where(and(eq(milestones.projectId, projectId), eq(milestones.status, "closed")))
        .orderBy(desc(milestones.closedAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "milestone_reached" as const, projectId, objectId: r.id, payload: {} }, label: r.name, code: null, at: r.closedAt }));
    }
    case "mail_received":
      return [];
  }
}

/**
 * Gli esempi di «email in arrivo» (area 7, F2, S8): gli ultimi messaggi della
 * casella, SOLO se chi prova è il proprietario che la versione avrebbe (R-J13,
 * `mailbox_owner`): altrimenti nessun esempio, e l'evento si scrive a mano.
 */
async function mailExamples(db: Db, accountId: string | null): Promise<SimulationExample[]> {
  if (!accountId) return [];
  const rows = await db
    .select({ from: emailMessages.fromAddress, subject: emailMessages.subject, text: emailMessages.textExcerpt, at: emailMessages.receivedAt })
    .from(emailMessages)
    .where(eq(emailMessages.accountId, accountId))
    .orderBy(desc(emailMessages.receivedAt))
    .limit(MAX_EXAMPLES);
  return rows.map((r) => ({ label: r.subject ?? "", code: null, at: r.at.toISOString(), event: { email: { mittente: r.from, oggetto: r.subject ?? "", testo: r.text ?? "" } } }));
}

async function examplesOf(db: Db, projectId: string, flow: AutomationFlow, mailAccountId: string | null): Promise<SimulationExample[]> {
  const t = flow.trigger;
  if (t.kind === "manual" || t.kind === "schedule") {
    const today = new Date().toISOString();
    return [{ label: today.slice(0, 10), code: null, at: today, event: { avvio: { data: today.slice(0, 10) } } }];
  }
  if (t.kind === "stubwise" && t.event === "mail_received") {
    const all = await mailExamples(db, mailAccountId);
    return t.filter ? all.filter((e) => evaluate(t.filter!, (key) => lookup(e.event, key))) : all;
  }
  const out: SimulationExample[] = [];
  for (const c of await candidateEvents(db, projectId, flow)) {
    const event = await automationEventFields(db, c.ref);
    if (t.kind === "stubwise" && t.filter && !evaluate(t.filter, (key) => lookup(event, key))) continue;
    out.push({ label: c.label, code: c.code, at: c.at?.toISOString() ?? null, event });
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

/** Le persone, i reparti e i progetti che i passi nominano. */
function namedBy(flow: AutomationFlow, projectId: string) {
  const projectIds = new Set<string>([projectId]);
  const personIds = new Set<string>();
  const departmentIds = new Set<string>();
  const people = (who: unknown) => {
    if (!who || typeof who !== "object") return;
    if ("personId" in who && typeof who.personId === "string" && who.personId) personIds.add(who.personId);
    if ("departmentId" in who && typeof who.departmentId === "string") departmentIds.add(who.departmentId);
  };
  visitSteps(flow.steps, (s) => {
    const p = projectOf(s);
    if (p?.mode === "fixed" && p.projectId) projectIds.add(p.projectId);
    if ("approval" in s && s.approval.mode === "ask") people(s.approval.who);
    if (s.kind === "createTask") people(s.assignee);
    if (s.kind === "notify") people(s.who);
  });
  return { projectIds: [...projectIds], personIds: [...personIds], departmentIds: [...departmentIds] };
}

export async function simulationExamples(db: Db, viewer: Viewer, code: string, version: number | "draft"): Promise<SimulationExamplesView> {
  const a = await managedAutomation(db, viewer, code);
  const versions = await versionsOf(db, a.id);
  const last = versions.at(-1)!;
  const v = version === "draft" ? (last.publishedAt === null ? last : undefined) : versions.find((x) => x.n === version);
  if (!v) throw new AutomationError(400, version === "draft" ? "no_draft" : "version", "Unknown version");
  const flow = v.flow as AutomationFlow;
  const draft = v.publishedAt === null;
  // Review F1, I3: una versione non pubblicata la pubblicherebbe chi prova, che
  // pubblicando ne diventa il proprietario: è lui il proprietario che avrebbe.
  const ownerId = draft ? viewer.id : (a.ownerId ?? viewer.id);
  const visible = await seen(db, viewer);
  const scope = namedBy(flow, a.projectId);
  const world = await loadPlanWorld(db, { ownerId, ...scope, personIds: [ownerId, viewer.id, ...scope.personIds] });

  // Le persone che chi prova incontra: i membri dei progetti toccati che vede, i nominati che vede, sé e il proprietario.
  const visibleProjects = scope.projectIds.filter((p) => sees(visible, p));
  const members = visibleProjects.length
    ? await db
        .select({ projectId: projectMembers.projectId, userId: projectMembers.userId, presetKey: roles.presetKey, roleId: roles.id })
        .from(projectMembers)
        .innerJoin(roles, eq(roles.id, projectMembers.roleId))
        .where(inArray(projectMembers.projectId, visibleProjects))
    : [];
  const personIds = new Set<string>([viewer.id, ownerId, ...members.map((m) => m.userId)]);
  for (const id of scope.personIds) if (visibleProjects.some((p) => world.canSeeProject(id, p))) personIds.add(id);
  for (const dept of scope.departmentIds) for (const p of visibleProjects) for (const id of world.departmentRecipients(dept, p)) personIds.add(id);
  const people: SimulationPerson[] = [...personIds].flatMap((id) => {
    const p = world.person(id);
    return p ? [{ id: p.id, name: p.name, departmentIds: p.departmentIds, isClaude: p.isClaude === true, deactivated: world.isDeactivated(id), defaultDepartmentId: world.defaultDepartmentOf(id) }] : [];
  });

  const projectRows = scope.projectIds.length ? await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, scope.projectIds)) : [];
  const ownerPerms = await projectPermissionsByProject(db, ownerId, scope.projectIds);
  // I nomi dei traguardi già usati (review del renderer): solo nei progetti che chi prova vede.
  const usedNames = visibleProjects.length
    ? await db.select({ projectId: milestones.projectId, name: milestones.name }).from(milestones).where(inArray(milestones.projectId, visibleProjects)).orderBy(asc(milestones.name))
    : [];
  const contextProjects: SimulationContextProject[] = scope.projectIds.map((pid) => {
    const row = projectRows.find((r) => r.id === pid);
    const viewerSees = sees(visible, pid);
    // Un progetto che chi prova non vede non dice niente, nemmeno del
    // proprietario (chi lo vede, cosa ci può creare, se esiste ancora).
    const seenBy = viewerSees ? [...personIds].filter((id) => world.canSeeProject(id, pid)) : [];
    const ownerSees = seenBy.includes(ownerId);
    const perms = ownerPerms.get(pid);
    const roleHolders: Record<string, string[]> = {};
    const departmentMembers: Record<string, string[]> = {};
    if (viewerSees) {
      for (const key of new Set(members.filter((m) => m.projectId === pid).map((m) => m.presetKey ?? m.roleId))) roleHolders[key] = world.holdersOfRole(pid, key);
      for (const dept of scope.departmentIds) departmentMembers[dept] = world.departmentRecipients(dept, pid);
    }
    return {
      // Un progetto che chi prova non vede: niente codice né nome (R-G5).
      id: pid,
      code: viewerSees ? (row?.code ?? "") : "",
      name: viewerSees ? (row?.name ?? "") : "",
      gone: viewerSees && !row,
      seenBy,
      ownerCan: {
        createTask: ownerSees && perms?.has("tickets.create") === true,
        createMilestone: ownerSees && perms?.has("tickets.edit") === true,
        createRequest: ownerSees && perms?.has("backlog.create") === true,
      },
      roleHolders,
      departmentMembers,
      milestoneNames: viewerSees ? usedNames.filter((m) => m.projectId === pid).map((m) => m.name) : [],
    };
  });

  // La casella che il proprietario che avrebbe userebbe (F2): quella scelta se è lui, altrimenti la sua prima utilizzabile.
  const box = await automationMailboxOf(db, ownerId, ownerId === a.ownerId ? a.mailboxAccountId : null);
  const ownerMailbox: OwnerMailbox = box.ok ? { ok: true, address: box.address } : { ok: false, reason: box.reason === "no_read_scope" ? "no_scope" : box.reason };
  const context: SimulationContext = {
    automation: automationOf(a, versions, visible, await mailboxAddresses(db, [a])),
    version: v.n,
    draft,
    rev: v.rev,
    ownerId,
    configErrors: await configErrorsOf(db, a, flow, ownerId),
    people,
    projects: contextProjects,
    ownerMailbox,
  };
  // La posta solo del proprietario che avrebbe, e solo se è chi prova (R-J13).
  return { items: await examplesOf(db, a.projectId, flow, ownerId === viewer.id && box.ok ? box.accountId : null), context };
}
