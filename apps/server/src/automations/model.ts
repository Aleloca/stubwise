import {
  automationRuns,
  automations,
  automationSources,
  automationVersions,
  googleAccounts,
  roles,
  users,
  type Db,
} from "@stubwise/db";
import { loadPlanWorld } from "@stubwise/notifications";
import {
  AUTOMATION_F4_AVAILABILITY,
  effectiveInstancePermissions,
  projectOf,
  validateFlow,
  visitSteps,
  type ApprovalWho,
  type Automation,
  type AutomationFlow,
  type AutomationRow,
  type AutomationSource,
  type AutomationVersion,
  type FlowIssue,
  type PlanWorld,
  type Step,
} from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { projectPermissionsFor, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { webhookLimitsView } from "./webhook-limits.js";

/**
 * IL MODELLO DELLE AUTOMATIONS nel server (area 7, fetta 1): dalle righe alle
 * forme di `@stubwise/shared` (`Automation`, `AutomationRow`…), con le regole
 * di `data/automations/{visibility,reads}.ts` del prototipo:
 *
 * - un'automazione di progetto la VEDE chi vede il progetto e la GESTISCE chi
 *   ha `automations.manage` lì; una GENERALE (senza progetto, F4) la vede e la
 *   gestisce solo chi ha `automations.general.manage` d'istanza; nascosta e
 *   inesistente rispondono uguale (404, R-G5);
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

/** Il permesso d'istanza delle generali (F4; il design lo chiamava «`automations.manage` d'istanza»). */
export const GENERAL_PERMISSION = "automations.general.manage";
export const managesGeneral = (viewer: Viewer) => viewer.instancePermissions.has(GENERAL_PERMISSION);

/** I progetti che `viewer` vede (`"all"` per un full admin). */
export async function seen(db: Db | Tx, viewer: Viewer): Promise<"all" | ReadonlySet<string>> {
  const v = await visibleProjectIds(db as Db, viewer);
  return v === "all" ? "all" : new Set(v);
}
export const sees = (visible: "all" | ReadonlySet<string>, projectId: string) => visible === "all" || visible.has(projectId);

/** Chi guarda vede l'automazione? Una generale solo col permesso d'istanza (R-G5). */
export const seesAutomation = (visible: "all" | ReadonlySet<string>, viewer: Viewer, a: Pick<AutomationRecord, "projectId">) =>
  a.projectId === null ? managesGeneral(viewer) : sees(visible, a.projectId);

/** `projectId` null = una generale: la gestisce chi ha il permesso d'istanza. */
export async function canManage(db: Db | Tx, viewer: Viewer, projectId: string | null): Promise<boolean> {
  if (projectId === null) return managesGeneral(viewer);
  return (await projectPermissionsFor(db as Db, viewer, projectId))?.has("automations.manage") === true;
}

/** Un'automazione per codice, se chi guarda la vede; altrimenti 404. */
export async function visibleAutomation(db: Db | Tx, viewer: Viewer, code: string): Promise<AutomationRecord> {
  const [a] = await db.select().from(automations).where(eq(automations.code, code.toUpperCase()));
  if (!a || !seesAutomation(await seen(db, viewer), viewer, a)) throw notFound();
  return a;
}

/** Un'automazione che chi guarda GESTISCE: 404 se non la vede, 403 senza `automations.manage`. */
export async function managedAutomation(db: Db | Tx, viewer: Viewer, code: string): Promise<AutomationRecord> {
  const a = await visibleAutomation(db, viewer, code);
  if (!(await canManage(db, viewer, a.projectId))) throw forbidden(a.projectId === null ? GENERAL_PERMISSION : undefined);
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
/** Gli indirizzi delle caselle scelte, per id (area 7, F2): una query per pagina. */
export async function mailboxAddresses(db: Db | Tx, rows: Pick<AutomationRecord, "mailboxAccountId">[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.mailboxAccountId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const found = await (db as Db).select({ id: googleAccounts.id, email: googleAccounts.email }).from(googleAccounts).where(inArray(googleAccounts.id, ids));
  return new Map(found.map((r) => [r.id, r.email]));
}

export function automationOf(a: AutomationRecord, versions: VersionRecord[], visible: "all" | ReadonlySet<string>, addresses?: ReadonlyMap<string, string>): Automation {
  const mailbox = a.mailboxAccountId ? (addresses?.get(a.mailboxAccountId) ?? null) : null;
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
    pausedReason: a.pausedReason,
    ...(a.createdVia === "claude" ? { createdVia: "claude" as const } : {}),
    // Area 7, F2: la casella scelta all'accensione (l'indirizzo, come nel prototipo, e il suo id).
    mailbox,
    mailboxAccountId: mailbox ? a.mailboxAccountId : null,
    // Area 7, F4 (F4-2 = c): il tetto del webhook, con default e massimo d'istanza.
    webhookLimits: webhookLimitsView(a),
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
export function namedBy(flow: AutomationFlow, projectId: string | null) {
  const projectIds = new Set<string>(projectId ? [projectId] : []);
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
 * della fetta 4 (in più le sorgenti webhook e «avvia un'altra»), le sorgenti
 * vere, più R-J11 per un approvatore per persona.
 */
export async function configErrorsOf(db: Db | Tx, a: Pick<AutomationRecord, "projectId"> & { id?: string }, flow: AutomationFlow, ownerId: string): Promise<FlowIssue[]> {
  const scope = namedBy(flow, a.projectId);
  const world = await loadPlanWorld(db, { ownerId, ...scope, personIds: [ownerId, ...scope.personIds] });
  const issues = validateFlow(flow, {
    sources: await sourcesFor(db, flow),
    projectId: a.projectId,
    canApprove: (who, projectId) => {
      const p = projectId ?? a.projectId;
      // Una generale senza progetto noto prima dell'evento: non si segnala (come il motore).
      if (p === null) return true;
      return approversIn(world, ownerId, who, p).length > 0;
    },
    departmentSees: (departmentId, projectId) => world.departmentRecipients(departmentId, projectId).length > 0,
    available: AUTOMATION_F4_AVAILABILITY,
  });
  await startAutomationIssues(db, a, flow, ownerId, issues);
  visitSteps(flow.steps, (step, path) => {
    if (!("approval" in step) || step.approval.mode !== "ask") return;
    const who = step.approval.who;
    if (!("personId" in who) || !who.personId) return;
    const t = projectOf(step);
    const candidate = t?.mode === "fixed" ? t.projectId : a.projectId;
    // `own` di una generale non esiste (lo dice `validateFlow`), `from_client` non è noto prima.
    if (!candidate || world.canSeeProject(who.personId, candidate)) return;
    if (issues.some((i) => i.path === path && i.code === "approver_cant_see")) return;
    issues.push({ path, code: "approver_cant_see", message: "Chi deve approvare non vede uno dei progetti in cui il passo può agire." });
  });
  return issues;
}

/** Le automazioni avviate da un flusso (passi `startAutomation`). */
function startsOf(flow: AutomationFlow): { path: string; automationId: string }[] {
  const out: { path: string; automationId: string }[] = [];
  visitSteps(flow.steps, (step, path) => {
    if (step.kind === "startAutomation" && step.automationId) out.push({ path, automationId: step.automationId });
  });
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * F4, «avvia un'altra» (la regola di `reads.ts` del prototipo): un passo verso
 * un'automazione che non esiste, che il proprietario non vede o non può
 * gestire (R-J21) è `unknown_ref`; uno che per avvii successivi (sulle
 * versioni PUBBLICATE) torna a questa è `limit` — niente cicli A → … → A.
 * L'esecutore ricontrolla tutto a ogni effetto: qui si ferma la pubblicazione.
 */
async function startAutomationIssues(db: Db | Tx, a: Pick<AutomationRecord, "projectId"> & { id?: string }, flow: AutomationFlow, ownerId: string, issues: FlowIssue[]): Promise<void> {
  const starts = startsOf(flow);
  if (starts.length === 0) return;
  const [owner] = await (db as Db).select({ id: users.id, instanceRolePermissions: roles.permissions }).from(users).innerJoin(roles, eq(roles.id, users.instanceRoleId)).where(eq(users.id, ownerId));
  const asOwner: Viewer | null = owner ? { id: owner.id, instancePermissions: effectiveInstancePermissions(owner.instanceRolePermissions) } : null;
  const visible = asOwner ? await seen(db, asOwner) : new Set<string>();
  const flowOfPublished = async (id: string): Promise<AutomationFlow | null> => ((await publishedVersion(db, id))?.flow as AutomationFlow | undefined) ?? null;
  const reaches = async (toId: string, fromId: string | undefined, seenIds = new Set<string>()): Promise<boolean> => {
    if (fromId !== undefined && toId === fromId) return true;
    if (seenIds.has(toId) || seenIds.size > 50) return false;
    seenIds.add(toId);
    const f = await flowOfPublished(toId);
    if (!f) return false;
    for (const s of startsOf(f)) if (await reaches(s.automationId, fromId, seenIds)) return true;
    return false;
  };
  for (const { path, automationId } of starts) {
    const [target] = UUID.test(automationId) ? await (db as Db).select().from(automations).where(eq(automations.id, automationId)) : [];
    if (!target || !asOwner || !seesAutomation(visible, asOwner, target) || !(await canManage(db, asOwner, target.projectId))) {
      issues.push({ path, code: "unknown_ref", message: "L'automazione da avviare non esiste, o il proprietario non la vede o non può gestirla." });
    } else if (a.id !== undefined && (await reaches(automationId, a.id))) {
      issues.push({ path, code: "limit", message: "Avvierebbe di nuovo questa automazione: una catena di avvii non può tornare indietro." });
    }
  }
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
  const addresses = await mailboxAddresses(db, records);
  for (const a of records) {
    const mine = versions.filter((v) => v.automationId === a.id);
    const latest = mine.at(-1);
    const live = [...mine].reverse().find((v) => v.publishedAt !== null);
    const scopeKey = a.projectId ?? "general";
    if (!manageable.has(scopeKey)) manageable.set(scopeKey, await canManage(db, viewer, a.projectId));
    const owner = a.ownerId ?? viewer.id;
    const c = countOf.get(a.id);
    out.push({
      ...automationOf(a, mine, visible, addresses),
      permissions: { manage: manageable.get(scopeKey)! },
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
  q: { project?: string; general?: boolean; status?: "draft" | "active" | "paused"; owner?: string; mine?: boolean },
): Promise<AutomationRow[]> {
  const visible = await seen(db, viewer);
  const generals = managesGeneral(viewer);
  // Le generali solo a chi ha il permesso d'istanza (R-G5): filtrate nella WHERE.
  if (q.general && !generals) return [];
  if (!q.general && visible !== "all" && visible.size === 0 && !generals) return [];
  const projectScope =
    visible === "all" ? sql`${automations.projectId} is not null` : visible.size > 0 ? inArray(automations.projectId, [...visible]) : sql`false`;
  const scope = q.general ? isNull(automations.projectId) : q.project ? projectScope : generals ? or(projectScope, isNull(automations.projectId)) : projectScope;
  const records = await db
    .select()
    .from(automations)
    .where(
      and(
        scope,
        q.project && !q.general ? eq(automations.projectId, q.project) : undefined,
        q.status ? eq(automations.status, q.status) : undefined,
        q.owner ? eq(automations.ownerId, q.owner) : undefined,
        q.mine ? eq(automations.ownerId, viewer.id) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${automations.name})`), asc(automations.code))
    .limit(500);
  return automationRows(db, viewer, records);
}

/**
 * Le sorgenti che un flusso nomina, nella forma condivisa (per `validateFlow`
 * e i campi dell'inizio): solo webhook (F4). Una sorgente che non c'è resta
 * fuori, e `validateFlow` la segnala.
 */
export async function sourcesFor(db: Db | Tx, flow: AutomationFlow): Promise<AutomationSource[]> {
  if (flow.trigger?.kind !== "source" || !flow.trigger.sourceId) return [];
  const id = flow.trigger.sourceId;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
  const rows = await (db as Db).select().from(automationSources).where(eq(automationSources.id, id));
  return rows.map(sourceShape);
}

/** Una riga di `automation_sources` nella forma condivisa (senza indirizzo: il segreto non esce). */
export function sourceShape(row: typeof automationSources.$inferSelect): AutomationSource {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: "connected",
    connectedById: row.createdBy ?? "",
    sampleEvents: row.example && typeof row.example === "object" ? [row.example as Record<string, unknown>] : [],
    fields: (row.fields ?? []) as AutomationSource["fields"],
    connectedAt: row.createdAt.toISOString(),
  };
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
