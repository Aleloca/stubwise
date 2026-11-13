import {
  automationRuns,
  automations,
  automationVersions,
  type Db,
} from "@stubwise/db";
import { loadPlanWorld } from "@stubwise/notifications";
import {
  AUTOMATION_F1_AVAILABILITY,
  projectOf,
  validateFlow,
  visitSteps,
  type ApprovalWho,
  type Automation,
  type AutomationFlow,
  type AutomationRow,
  type AutomationVersion,
  type FlowIssue,
  type PlanWorld,
  type Step,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * IL MODELLO DELLE AUTOMATIONS nel server (area 7, fetta 1): dalle righe alle
 * forme di `@stubwise/shared` (`Automation`, `AutomationRow`…), con le regole
 * di `data/automations/{visibility,reads}.ts` del prototipo:
 *
 * - un'automazione di progetto la VEDE chi vede il progetto e la GESTISCE chi
 *   ha `automations.manage` lì; nascosta e inesistente rispondono uguale (404,
 *   R-G5);
 * - un progetto FISSO che chi guarda non vede, dentro un flusso, resta senza
 *   id e col segno `unavailable` (`flowFor`);
 * - gli errori di configurazione sono quelli di `validateFlow` (con la
 *   disponibilità della fetta 1) visti dal proprietario, più l'approvatore
 *   per persona che non vede un progetto del passo (R-J11).
 */

export type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AutomationRecord = typeof automations.$inferSelect;
type VersionRecord = typeof automationVersions.$inferSelect;

/** Un errore delle Automations, nelle parole che il client mappa (`code`). */
export class AutomationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = () => new AutomationError(404, "not_found", "Not found");
export const forbidden = (what = "automations.manage") => new AutomationError(403, "forbidden", `You need ${what} in this project`);

/** I progetti che `viewer` vede (`"all"` per un full admin). */
export async function seen(db: Db | Tx, viewer: Viewer): Promise<"all" | ReadonlySet<string>> {
  const v = await visibleProjectIds(db as Db, viewer);
  return v === "all" ? "all" : new Set(v);
}
export const sees = (visible: "all" | ReadonlySet<string>, projectId: string) => visible === "all" || visible.has(projectId);

export async function canManage(db: Db | Tx, viewer: Viewer, projectId: string): Promise<boolean> {
  return (await projectPermissionsFor(db as Db, viewer, projectId))?.has("automations.manage") === true;
}

/** Un'automazione per codice, se chi guarda la vede; altrimenti 404. */
export async function visibleAutomation(db: Db | Tx, viewer: Viewer, code: string): Promise<AutomationRecord> {
  const [a] = await db.select().from(automations).where(eq(automations.code, code.toUpperCase()));
  if (!a || !sees(await seen(db, viewer), a.projectId)) throw notFound();
  return a;
}

/** Un'automazione che chi guarda GESTISCE: 404 se non la vede, 403 senza `automations.manage`. */
export async function managedAutomation(db: Db | Tx, viewer: Viewer, code: string): Promise<AutomationRecord> {
  const a = await visibleAutomation(db, viewer, code);
  if (!(await canManage(db, viewer, a.projectId))) throw forbidden();
  return a;
}

export async function versionsOf(db: Db | Tx, automationId: string): Promise<VersionRecord[]> {
  return db.select().from(automationVersions).where(eq(automationVersions.automationId, automationId)).orderBy(asc(automationVersions.n));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function versionOf(v: VersionRecord): AutomationVersion {
  return {
    n: v.n,
    flow: v.flow as AutomationFlow,
    publishedAt: iso(v.publishedAt),
    publishedById: v.publishedBy,
    savedAt: iso(v.savedAt),
    savedById: v.savedBy,
    rev: v.rev,
    testedRev: v.testedRev,
  };
}

/** L'automazione nella forma condivisa, coi flussi come li legge chi guarda (R-G5). */
export function automationOf(a: AutomationRecord, versions: VersionRecord[], visible: "all" | ReadonlySet<string>): Automation {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    description: a.description,
    projectId: a.projectId,
    ownerId: a.ownerId,
    status: a.status,
    versions: versions.map((v) => ({ ...versionOf(v), flow: flowFor(visible, v.flow as AutomationFlow) })),
    createdAt: a.createdAt.toISOString(),
    createdById: a.createdBy,
    pausedById: a.pausedBy,
    pausedAt: iso(a.pausedAt),
    ...(a.createdVia === "claude" ? { createdVia: "claude" as const } : {}),
  };
}

type FixedStep = Step & { project: { mode: "fixed"; projectId: string; unavailable?: true } };

function fixedSteps(flow: AutomationFlow): FixedStep[] {
  const out: FixedStep[] = [];
  visitSteps(flow.steps, (s) => {
    if (projectOf(s)?.mode === "fixed") out.push(s as FixedStep);
  });
  return out;
}

/** R-G5: un progetto fisso che chi guarda non vede resta senza id, col segno `unavailable`. */
export function flowFor(visible: "all" | ReadonlySet<string>, flow: AutomationFlow): AutomationFlow {
  const out = structuredClone(flow);
  for (const s of fixedSteps(out)) {
    if (s.project.projectId !== "" && sees(visible, s.project.projectId)) continue;
    if (s.project.projectId === "" && !s.project.unavailable) continue;
    s.project = { mode: "fixed", projectId: "", unavailable: true };
  }
  return out;
}

/**
 * Il rovescio per chi salva un flusso letto con {@link flowFor}: un passo che
 * aveva un progetto fisso che chi salva non vede, e che torna senza id, lo
 * riprende dalla versione di prima (per id del passo).
 */
export function keepHiddenProjects(visible: "all" | ReadonlySet<string>, prev: AutomationFlow, next: AutomationFlow): void {
  const before = new Map(fixedSteps(prev).map((s) => [s.id, s.project.projectId]));
  for (const s of fixedSteps(next)) {
    const old = before.get(s.id);
    if (s.project.projectId === "" && old && !sees(visible, old)) s.project.projectId = old;
    if (s.project.projectId !== "") delete s.project.unavailable;
  }
}

/** Le persone, i reparti e i progetti che un flusso nomina (il mondo li carica). */
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

function approversIn(world: PlanWorld, ownerId: string, who: ApprovalWho, projectId: string | null): string[] {
  const ids = "owner" in who ? [ownerId] : "personId" in who ? (who.personId ? [who.personId] : []) : projectId ? world.holdersOfRole(projectId, who.projectRole) : [];
  return ids.filter((id) => !world.isDeactivated(id) && (projectId === null || world.canSeeProject(id, projectId)));
}

/**
 * Gli errori di configurazione di un flusso, visti da `ownerId` (per una
 * bozza mai accesa, chi la accenderebbe): `validateFlow` con la disponibilità
 * della fetta 1, più R-J11 per un approvatore per persona.
 */
export async function configErrorsOf(db: Db | Tx, a: Pick<AutomationRecord, "projectId">, flow: AutomationFlow, ownerId: string): Promise<FlowIssue[]> {
  const scope = namedBy(flow, a.projectId);
  const world = await loadPlanWorld(db, { ownerId, ...scope, personIds: [ownerId, ...scope.personIds] });
  const issues = validateFlow(flow, {
    sources: [],
    projectId: a.projectId,
    canApprove: (who, projectId) => approversIn(world, ownerId, who, projectId ?? a.projectId).length > 0,
    departmentSees: (departmentId, projectId) => world.departmentRecipients(departmentId, projectId).length > 0,
    available: AUTOMATION_F1_AVAILABILITY,
  });
  visitSteps(flow.steps, (step, path) => {
    if (!("approval" in step) || step.approval.mode !== "ask") return;
    const who = step.approval.who;
    if (!("personId" in who) || !who.personId) return;
    const t = projectOf(step);
    const candidate = t?.mode === "fixed" ? t.projectId : a.projectId;
    if (!candidate || world.canSeeProject(who.personId, candidate)) return;
    if (issues.some((i) => i.path === path && i.code === "approver_cant_see")) return;
    issues.push({ path, code: "approver_cant_see", message: "Chi deve approvare non vede uno dei progetti in cui il passo può agire." });
  });
  return issues;
}

const OPEN = ["running", "waiting_approval", "waiting_project", "suspended"] as const;
const WAITING = ["waiting_approval", "waiting_project"] as const;

/** Le righe dell'elenco, coi permessi e i conteggi calcolati (una query per i conteggi). */
export async function automationRows(db: Db, viewer: Viewer, records: AutomationRecord[]): Promise<AutomationRow[]> {
  if (records.length === 0) return [];
  const visible = await seen(db, viewer);
  const ids = records.map((a) => a.id);
  const versions = await db.select().from(automationVersions).where(inArray(automationVersions.automationId, ids)).orderBy(asc(automationVersions.n));
  const counts = await db
    .select({
      automationId: automationRuns.automationId,
      open: sql<number>`count(*) filter (where ${inArray(automationRuns.status, [...OPEN])})::int`,
      waiting: sql<number>`count(*) filter (where ${inArray(automationRuns.status, [...WAITING])})::int`,
      last: sql<Date | null>`max(${automationRuns.startedAt})`,
    })
    .from(automationRuns)
    .where(inArray(automationRuns.automationId, ids))
    .groupBy(automationRuns.automationId);
  const countOf = new Map(counts.map((c) => [c.automationId, c]));
  const manageable = new Map<string, boolean>();
  const out: AutomationRow[] = [];
  for (const a of records) {
    const mine = versions.filter((v) => v.automationId === a.id);
    const latest = mine.at(-1);
    const live = [...mine].reverse().find((v) => v.publishedAt !== null);
    if (!manageable.has(a.projectId)) manageable.set(a.projectId, await canManage(db, viewer, a.projectId));
    const owner = a.ownerId ?? viewer.id;
    const c = countOf.get(a.id);
    out.push({
      ...automationOf(a, mine, visible),
      permissions: { manage: manageable.get(a.projectId)! },
      openRuns: c?.open ?? 0,
      waitingRuns: c?.waiting ?? 0,
      lastRunAt: c?.last ? new Date(c.last).toISOString() : null,
      hasDraft: latest?.publishedAt === null,
      configErrorCount: latest ? (await configErrorsOf(db, a, latest.flow as AutomationFlow, owner)).length : 0,
      liveErrorCount: live ? (await configErrorsOf(db, a, live.flow as AutomationFlow, owner)).length : 0,
    });
  }
  return out;
}

/** L'elenco: le automazioni dei progetti che chi guarda vede, filtrate nella WHERE. */
export async function listAutomations(
  db: Db,
  viewer: Viewer,
  q: { project?: string; status?: "draft" | "active" | "paused"; owner?: string; mine?: boolean },
): Promise<AutomationRow[]> {
  const visible = await seen(db, viewer);
  if (visible !== "all" && visible.size === 0) return [];
  const records = await db
    .select()
    .from(automations)
    .where(
      and(
        visible === "all" ? undefined : inArray(automations.projectId, [...visible]),
        q.project ? eq(automations.projectId, q.project) : undefined,
        q.status ? eq(automations.status, q.status) : undefined,
        q.owner ? eq(automations.ownerId, q.owner) : undefined,
        q.mine ? eq(automations.ownerId, viewer.id) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${automations.name})`), asc(automations.code))
    .limit(500);
  return automationRows(db, viewer, records);
}

export async function latestVersion(db: Db | Tx, automationId: string): Promise<VersionRecord | null> {
  const [v] = await db.select().from(automationVersions).where(eq(automationVersions.automationId, automationId)).orderBy(desc(automationVersions.n)).limit(1);
  return v ?? null;
}

export async function publishedVersion(db: Db | Tx, automationId: string): Promise<VersionRecord | null> {
  const [v] = await db
    .select()
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, automationId), sql`${automationVersions.publishedAt} is not null`))
    .orderBy(desc(automationVersions.n))
    .limit(1);
  return v ?? null;
}
