import { automations, backlogItems, backlogItemTickets, clientProjectLinks, emailMessages, milestones, projectMembers, projects, roles, tickets, type Db } from "@stubwise/db";
import { automationEventFields, automationMailboxOf, automationOwnerInScope, loadPlanWorld, projectPermissionsByProject, projectPermissionsOfUser, type AutomationEventRef } from "@stubwise/notifications";
import {
  checkEventFields,
  clientKeyOf,
  evaluate,
  visitSteps,
  type SimulationClientProject,
  type SimulationStartTarget,
  lookup,
  type AutomationFlow,
  type OwnerMailbox,
  type SimulationContext,
  type SimulationContextProject,
  type SimulationExample,
  type SimulationExamplesView,
  type SimulationPerson,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { AutomationError, automationOf, configErrorsOf, mailboxAddresses, managedAutomation, namedBy, seen, sees, seesAutomation, sourcesFor, versionsOf, type Viewer } from "./model.js";

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

/**
 * I progetti da cui prendere gli esempi: quello dell'automazione, oppure (una
 * generale, F4) i progetti che chi prova vede — una generale ascolta gli
 * eventi di ogni progetto che il proprietario vede.
 */
type ExampleScope = { projectId: string } | { visible: "all" | ReadonlySet<string> };

function scopeWhere(column: typeof tickets.projectId | typeof backlogItems.projectId | typeof milestones.projectId, scope: ExampleScope) {
  if ("projectId" in scope) return eq(column, scope.projectId);
  if (scope.visible === "all") return undefined;
  return scope.visible.size > 0 ? inArray(column, [...scope.visible]) : eq(column, "00000000-0000-0000-0000-000000000000");
}

/** Gli oggetti veri più recenti per l'inizio, come eventi. */
async function candidateEvents(db: Db, scope: ExampleScope, flow: AutomationFlow): Promise<{ ref: AutomationEventRef; label: string; code: string | null; at: Date | null }[]> {
  const t = flow.trigger;
  if (t.kind !== "stubwise") return [];
  const LIMIT = 50;
  switch (t.event) {
    case "task_created":
    case "task_closed": {
      const closed = t.event === "task_closed";
      const rows = await db
        .select({ id: tickets.id, projectId: tickets.projectId, code: projects.code, title: tickets.title, number: tickets.number, createdAt: tickets.createdAt, closedAt: tickets.closedAt })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(and(scopeWhere(tickets.projectId, scope), closed ? isNotNull(tickets.closedAt) : undefined))
        .orderBy(desc(closed ? tickets.closedAt : tickets.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: t.event as "task_created", projectId: r.projectId, objectId: r.id, payload: {} }, label: r.title, code: `${r.code}-${r.number}`, at: closed ? r.closedAt : r.createdAt }));
    }
    case "request_created": {
      const rows = await db
        .select({ id: backlogItems.id, projectId: backlogItems.projectId, code: projects.code, title: backlogItems.title, number: backlogItems.number, createdAt: backlogItems.createdAt })
        .from(backlogItems)
        .innerJoin(projects, eq(projects.id, backlogItems.projectId))
        .where(scopeWhere(backlogItems.projectId, scope))
        .orderBy(desc(backlogItems.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "request_created" as const, projectId: r.projectId, objectId: r.id, payload: {} }, label: r.title, code: `${r.code}-R${r.number}`, at: r.createdAt }));
    }
    case "request_converted": {
      const rows = await db
        .select({ id: backlogItems.id, projectId: backlogItems.projectId, code: projects.code, title: backlogItems.title, number: backlogItems.number, createdAt: backlogItems.createdAt, ticketId: backlogItemTickets.ticketId })
        .from(backlogItemTickets)
        .innerJoin(backlogItems, eq(backlogItems.id, backlogItemTickets.itemId))
        .innerJoin(projects, eq(projects.id, backlogItems.projectId))
        .where(and(scopeWhere(backlogItems.projectId, scope), eq(backlogItemTickets.role, "converted_to")))
        .orderBy(desc(backlogItemTickets.createdAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "request_converted" as const, projectId: r.projectId, objectId: r.id, payload: { ticketId: r.ticketId } }, label: r.title, code: `${r.code}-R${r.number}`, at: r.createdAt }));
    }
    case "milestone_reached": {
      const rows = await db
        .select({ id: milestones.id, projectId: milestones.projectId, name: milestones.name, closedAt: milestones.closedAt })
        .from(milestones)
        .where(and(scopeWhere(milestones.projectId, scope), eq(milestones.status, "closed")))
        .orderBy(desc(milestones.closedAt))
        .limit(LIMIT);
      return rows.map((r) => ({ ref: { kind: "milestone_reached" as const, projectId: r.projectId, objectId: r.id, payload: {} }, label: r.name, code: null, at: r.closedAt }));
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

async function examplesOf(db: Db, scope: ExampleScope, flow: AutomationFlow, mailAccountId: string | null): Promise<SimulationExample[]> {
  const t = flow.trigger;
  if (t.kind === "source") {
    // F4: l'esempio incollato da chi gestisce l'integrazione. Gli eventi recenti NO:
    // li vede solo `integrations.manage` (F4-6), e chi prova può non averlo.
    const [source] = await sourcesFor(db, flow);
    const example = source?.sampleEvents[0];
    if (!source || !example) return [];
    const projected = checkEventFields(example, source.fields);
    return [{ label: source.name, code: null, at: null, event: projected.ok ? projected.event : {} }];
  }
  if (t.kind === "manual" || t.kind === "schedule") {
    const today = new Date().toISOString();
    return [{ label: today.slice(0, 10), code: null, at: today, event: { avvio: { data: today.slice(0, 10) } } }];
  }
  if (t.kind === "stubwise" && t.event === "mail_received") {
    const all = await mailExamples(db, mailAccountId);
    return t.filter ? all.filter((e) => evaluate(t.filter!, (key) => lookup(e.event, key))) : all;
  }
  const out: SimulationExample[] = [];
  for (const c of await candidateEvents(db, scope, flow)) {
    const event = await automationEventFields(db, c.ref);
    if (t.kind === "stubwise" && t.filter && !evaluate(t.filter, (key) => lookup(event, key))) continue;
    out.push({ label: c.label, code: c.code, at: c.at?.toISOString() ?? null, event });
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

/**
 * Le persone e i progetti del contesto della prova, per chi prova e per il
 * proprietario che la versione avrebbe (R-G5: un progetto che chi prova non
 * vede non dice niente). `extraProjectIds`: progetti in più da descrivere con
 * le stesse regole (F4: quello che il cliente di un esempio risolve).
 */
async function contextParts(
  db: Db,
  viewer: Viewer,
  a: { projectId: string | null },
  flow: AutomationFlow,
  ownerId: string,
  extraProjectIds: string[] = [],
): Promise<{ people: SimulationPerson[]; projects: SimulationContextProject[] }> {
  const visible = await seen(db, viewer);
  const named = namedBy(flow, a.projectId);
  const scope = { ...named, projectIds: [...new Set([...named.projectIds, ...extraProjectIds])] };
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

  return { people, projects: contextProjects };
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
  const { people, projects: contextProjects } = await contextParts(db, viewer, a, flow, ownerId);
  // La casella che il proprietario che avrebbe userebbe (F2): quella scelta se è lui, altrimenti la sua prima utilizzabile.
  const box = await automationMailboxOf(db, ownerId, ownerId === a.ownerId ? a.mailboxAccountId : null);
  const ownerMailbox: OwnerMailbox = box.ok ? { ok: true, address: box.address } : { ok: false, reason: box.reason === "no_read_scope" ? "no_scope" : box.reason };
  const startTargets = await startTargetsOf(db, viewer, flow, ownerId);
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
    automations: startTargets,
  };
  // La posta solo del proprietario che avrebbe, e solo se è chi prova (R-J13).
  const exampleScope: ExampleScope = a.projectId ? { projectId: a.projectId } : { visible };
  return { items: await examplesOf(db, exampleScope, flow, ownerId === viewer.id && box.ok ? box.accountId : null), context };
}

/**
 * F4: le automazioni nominate dai passi «avvia un'altra», come le vede il
 * proprietario che la versione avrebbe (la regola di `executeStart` nel
 * worker: una generale con il permesso d'istanza, una di progetto con
 * `automations.manage` lì); codice e nome solo se chi prova la vede.
 */
async function startTargetsOf(db: Db, viewer: Viewer, flow: AutomationFlow, ownerId: string): Promise<SimulationStartTarget[]> {
  const ids = new Set<string>();
  visitSteps(flow.steps, (st) => {
    if (st.kind === "startAutomation" && /^[0-9a-f-]{36}$/i.test(st.automationId)) ids.add(st.automationId);
  });
  if (ids.size === 0) return [];
  const rows = await db.select().from(automations).where(inArray(automations.id, [...ids]));
  const ownerGeneral = await automationOwnerInScope(db, ownerId, null);
  const ownerPerms = await projectPermissionsByProject(db, ownerId, rows.flatMap((r) => (r.projectId ? [r.projectId] : [])));
  const visible = await seen(db, viewer);
  return rows.map((r) => {
    const perms = r.projectId ? ownerPerms.get(r.projectId) : null;
    const shown = seesAutomation(visible, viewer, r);
    return {
      id: r.id,
      code: shown ? r.code : "",
      name: shown ? r.name : "",
      status: r.status,
      visibleToOwner: r.projectId === null ? ownerGeneral : perms !== null && perms !== undefined,
      manageableByOwner: r.projectId === null ? ownerGeneral : perms?.has("automations.manage") === true,
    };
  });
}

/**
 * F4, la prova (decisione di 46): il progetto del cliente di un esempio, con
 * la regola del worker (`resolveClientProject`): `clientKeyOf`, la riga della
 * tabella, un progetto che il PROPRIETARIO che la versione avrebbe vede;
 * altrimenti `null`. Solo chi può provare (chi gestisce l'automazione), mai la
 * tabella intera: rivela solo la risoluzione di quel cliente, come farebbe
 * l'esecuzione.
 */
export async function testClientProject(db: Db, viewer: Viewer, code: string, input: { version: number | "draft"; client: string }): Promise<SimulationClientProject> {
  const a = await managedAutomation(db, viewer, code);
  const versions = await versionsOf(db, a.id);
  const last = versions.at(-1)!;
  const v = input.version === "draft" ? (last.publishedAt === null ? last : undefined) : versions.find((x) => x.n === input.version);
  if (!v) throw new AutomationError(400, input.version === "draft" ? "no_draft" : "version", "Unknown version");
  const ownerId = v.publishedAt === null ? viewer.id : (a.ownerId ?? viewer.id);
  const key = clientKeyOf(input.client);
  const [link] = key ? await db.select({ projectId: clientProjectLinks.projectId }).from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, key)) : [];
  if (!link || !(await projectPermissionsOfUser(db, ownerId, link.projectId))) return { project: null, people: [] };
  const parts = await contextParts(db, viewer, a, v.flow as AutomationFlow, ownerId, [link.projectId]);
  return { project: parts.projects.find((p) => p.id === link.projectId) ?? null, people: parts.people };
}
