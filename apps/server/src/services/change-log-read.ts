import { changeLog, deletedProjectMembers, deletedProjects, departments, projects, roles, users, type Db } from "@stubwise/db";
import {
  CHANGE_LOG_TYPES,
  changeLogTypeOf,
  type ChangeEntry,
  type ChangeLogFilters,
  type ChangeLogPage,
  type ChangeLogType,
} from "@stubwise/shared";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { projectPermissionsFor, projectPermissionsMap } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { adminVisiblePersonIds } from "./admin-people.js";
import { hiddenFor } from "./people-known.js";
import { RoleRuleError } from "./roles.js";

/**
 * Area 9, F2 (D-3; docs/invariants/change-log.md, «La lettura è filtrata
 * nella WHERE»): chi legge cosa, in UN posto, SEMPRE nella WHERE e prima della
 * paginazione (G-3 = a, la regola del prototipo):
 * - una voce d'istanza: `changelog.view`, oppure il `readPermission` del suo
 *   tipo (chi gestisce l'oggetto);
 * - una voce di progetto: il progetto è visibile, E chi guarda ha
 *   `changelog.view`, oppure gestisce il progetto (`project.settings.manage`
 *   o `project.members.manage`), oppure ha lì il `readPermission` del tipo;
 * - una voce che parla di una PERSONA che chi guarda non vede non esiste per
 *   lui; dai `params` che elencano persone si tolgono quelle che non vede, e
 *   dai progetti di un invito quelli che non vede.
 * Il server non compone prosa (G-4 = a).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

/** I permessi di progetto di chi guarda, per ogni progetto che vede (la regola di `/api/auth/me`). */
// Area 9, F6: le voci di un progetto ARCHIVIATO restano nel registro di chi lo
// vedrebbe (il prototipo, `changelog/reads.ts`): il registro lo legge di proposito.
async function projectPermissionsMapFor(db: Db, viewer: Viewer): Promise<Map<string, ReadonlySet<string>>> {
  return new Map(Object.entries(await projectPermissionsMap(db, viewer, { includeArchived: true })).map(([id, perms]) => [id, new Set<string>(perms)]));
}
export const PAGE_SIZE = 50;
const MANAGE_PROJECT = ["project.settings.manage", "project.members.manage"] as const;
const PERSON_SUBJECTS = new Set(["person", "member"]);

export interface ChangeLogFilter {
  person?: string;
  /** Un progetto, o `"instance"` per le sole voci d'istanza. */
  project?: string;
  type?: string;
  group?: string;
  from?: string;
  to?: string;
  withinDays?: number;
  cursor?: string;
  /** Area 9, F7: le sole voci scritte da Claude («By Claude»). */
  via?: "claude";
}

interface Readable {
  where: SQL;
  readableProjects: string[];
  instanceTypes: ChangeLogType[];
  visiblePeople: "all" | string[];
}

/** La condizione di lettura di chi guarda: il cuore della regola. */
async function readableBy(db: Db, viewer: Viewer): Promise<Readable> {
  const instance = viewer.instancePermissions;
  const everything = instance.has("changelog.view") || instance.has("instance.full_admin");
  const instanceTypes = CHANGE_LOG_TYPES.filter((t) => t.scope === "instance" && (everything || instance.has(t.readPermission as never)));
  const perProject = await projectPermissionsMapFor(db, viewer);
  const projectTypes = CHANGE_LOG_TYPES.filter((t) => t.scope === "project");
  const branches: SQL[] = [];
  if (instanceTypes.length) {
    branches.push(and(isNull(changeLog.projectId), inArray(changeLog.type, instanceTypes.map((t) => t.kind)))!);
  }
  const fullProjects: string[] = [];
  const byType = new Map<string, string[]>();
  for (const [projectId, held] of perProject) {
    if (everything || MANAGE_PROJECT.some((p) => held.has(p))) {
      fullProjects.push(projectId);
      continue;
    }
    for (const t of projectTypes) if (held.has(t.readPermission as never)) byType.set(t.kind, [...(byType.get(t.kind) ?? []), projectId]);
  }
  if (fullProjects.length) branches.push(and(inArray(changeLog.projectId, fullProjects), inArray(changeLog.type, projectTypes.map((t) => t.kind)))!);
  for (const [kind, ids] of byType) branches.push(and(eq(changeLog.type, kind), inArray(changeLog.projectId, ids))!);
  const visiblePeople = await adminVisiblePersonIds(db, viewer);
  // Review di F2 (I2): la guardia sulle PERSONE vale per le voci d'istanza su
  // una persona (`person.*`). Una voce di progetto (`member.*`) la protegge già
  // la visibilità del progetto: chi lo gestisce legge anche chi ne è uscito.
  const personTypes = CHANGE_LOG_TYPES.filter((t) => t.kind.startsWith("person.")).map((t) => t.kind);
  const peopleGuard: SQL | undefined =
    visiblePeople === "all"
      ? undefined
      : or(sql`not (${inArray(changeLog.type, personTypes)})`, visiblePeople.length ? inArray(changeLog.subjectId, visiblePeople) : sql`false`);
  const where = branches.length ? and(or(...branches)!, peopleGuard)! : sql`false`;
  return { where, readableProjects: [...perProject.keys()], instanceTypes, visiblePeople };
}

/**
 * Il cursore è l'id dell'ultima voce della pagina: il confronto si fa sulla
 * tupla (`at`, `id`) letta DAL DB, perché `at` ha i microsecondi e un `Date`
 * del JS no (le voci di una stessa transazione hanno lo stesso `at`).
 */
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
function decodeCursor(cursor: string): string | null {
  const id = Buffer.from(cursor, "base64url").toString();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function filterWhere(filter: ChangeLogFilter): SQL[] {
  const out: SQL[] = [];
  if (filter.person) out.push(eq(changeLog.actorUserId, filter.person));
  if (filter.project === "instance") out.push(isNull(changeLog.projectId));
  else if (filter.project) out.push(eq(changeLog.projectId, filter.project));
  if (filter.type) out.push(eq(changeLog.type, filter.type));
  if (filter.group) {
    const kinds = CHANGE_LOG_TYPES.filter((t) => t.group === filter.group).map((t) => t.kind);
    out.push(kinds.length ? inArray(changeLog.type, kinds) : sql`false`);
  }
  if (filter.from) out.push(gte(changeLog.at, new Date(filter.from)));
  if (filter.to) out.push(lte(changeLog.at, new Date(filter.to)));
  if (filter.via === "claude") out.push(isNotNull(changeLog.viaClaudeActionId));
  if (filter.withinDays !== undefined) out.push(gte(changeLog.at, new Date(Date.now() - filter.withinDays * 86_400_000)));
  if (filter.cursor) {
    const id = decodeCursor(filter.cursor);
    if (!id) throw new RoleRuleError(400, "invalid_cursor", "Invalid cursor");
    out.push(sql`(${changeLog.at}, ${changeLog.id}) < (select c.at, c.id from ${changeLog} c where c.id = ${id}::uuid)`);
  }
  return out;
}

/** Le colonne di una voce, per la pagina e per le voci annullate. */
const ENTRY_COLUMNS = {
  id: changeLog.id,
  at: changeLog.at,
  actorUserId: changeLog.actorUserId,
  actorEmail: changeLog.actorEmail,
  actorKind: changeLog.actorKind,
  actorName: users.displayName,
  type: changeLog.type,
  projectId: changeLog.projectId,
  projectCode: projects.code,
  projectArchivedAt: projects.archivedAt,
  subjectKind: changeLog.subjectKind,
  subjectId: changeLog.subjectId,
  data: changeLog.data,
  viaClaudeActionId: changeLog.viaClaudeActionId,
  undoOfActionId: changeLog.undoOfActionId,
};

export async function listChanges(db: Db, viewer: Viewer, filter: ChangeLogFilter): Promise<ChangeLogPage> {
  const readable = await readableBy(db, viewer);
  const rows = await db
    .select(ENTRY_COLUMNS)
    .from(changeLog)
    .leftJoin(users, eq(users.id, changeLog.actorUserId))
    .leftJoin(projects, eq(projects.id, changeLog.projectId))
    .where(and(readable.where, ...filterWhere(filter)))
    .orderBy(desc(changeLog.at), desc(changeLog.id))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  // Area 9, F7: le voci che un «Annulla» annulla, con la STESSA condizione di
  // lettura (chi non legge la voce annullata non la riceve, e `undoOf` è null).
  const undoIds = [...new Set(page.map((r) => r.undoOfActionId).filter((x): x is string => x !== null))];
  const candidates = undoIds.length
    ? await db
        .select(ENTRY_COLUMNS)
        .from(changeLog)
        .leftJoin(users, eq(users.id, changeLog.actorUserId))
        .leftJoin(projects, eq(projects.id, changeLog.projectId))
        .where(and(readable.where, inArray(changeLog.viaClaudeActionId, undoIds)))
        .orderBy(desc(changeLog.at), desc(changeLog.id))
    : [];
  /** La voce annullata: della stessa azione di Claude, sullo stesso oggetto, non dopo (la più recente). */
  const undoneOf = (r: (typeof page)[number]) =>
    r.undoOfActionId === null
      ? undefined
      : candidates.find((c) => c.viaClaudeActionId === r.undoOfActionId && c.subjectKind === r.subjectKind && c.subjectId === r.subjectId && c.at.getTime() <= r.at.getTime() && c.id !== r.id);
  const undone = new Map(page.map((r) => [r.id, undoneOf(r)] as const));
  const existing = await existingObjects(db, [...page, ...[...undone.values()].filter((u) => u !== undefined)]);
  const visibleCodes = new Set(
    readable.readableProjects.length
      ? (await db.select({ code: projects.code }).from(projects).where(inArray(projects.id, readable.readableProjects))).map((p) => p.code)
      : [],
  );
  const allProjectsVisible = viewer.instancePermissions.has("instance.full_admin");
  // Registro, A11 r.1414: chi ha agito e chi guarda non conosce non ha né id né nome (R-G5).
  const hidden = await hiddenFor(db, viewer, [...page, ...[...undone.values()].filter((u) => u !== undefined)].map((r) => r.actorUserId));
  const toEntry = (r: (typeof page)[number]): Omit<ChangeEntry, "undoneEntry"> => {
    const type = changeLogTypeOf(r.type)!;
    const data = r.data as ChangeEntry["data"];
    return {
      id: r.id,
      type: r.type as ChangeEntry["type"],
      at: r.at.toISOString(),
      actor: {
        id: hidden.person(r.actorUserId),
        name:
          r.actorKind === "system"
            ? "Stubwise"
            : r.actorUserId !== null && !hidden.knows(r.actorUserId)
              ? null
              : (r.actorName ?? r.actorEmail.split("@")[0]!),
        kind: r.actorKind,
      },
      projectId: r.projectId,
      projectCode: r.projectCode,
      scope: type.scope,
      group: type.group,
      data: redact(r.type, data, readable.visiblePeople, allProjectsVisible ? null : visibleCodes),
      objectDeleted: !existing.has(`${r.subjectKind}:${r.subjectId}`),
      hidden: false,
      // Area 9, F6: DERIVATO a lettura, mai scritto nella voce. Il client
      // porta le voci di un archiviato alla sua pagina (`/archived/<CODICE>`).
      projectArchived: r.projectArchivedAt !== null,
      // Area 9, F7 (0195): «By Claude». L'id dell'azione non esce.
      via: r.viaClaudeActionId !== null ? "claude" : null,
      undoOf: undone.get(r.id)?.id ?? null,
    };
  };
  const entries: ChangeEntry[] = page.map((r) => {
    const u = undone.get(r.id);
    // Un livello solo: la voce annullata non porta la sua.
    return { ...toEntry(r), undoneEntry: u ? { ...toEntry({ ...u, undoOfActionId: null }), undoOf: null } : null };
  });
  await resolveDeletedProjects(db, viewer, [...entries, ...entries.flatMap((e) => (e.undoneEntry ? [e.undoneEntry as ChangeEntry] : []))]);
  const last = page.at(-1);
  return { entries, nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.id) : null };
}

/**
 * Le persone e i progetti che chi guarda non vede escono dai `params`: dalle
 * liste di un reparto (id e nomi in parallelo) e dai progetti di un invito
 * («CODICE · Ruolo»). Il conteggio non li tradisce: si tolgono, non si contano.
 */
/** I tipi i cui `added`/`removed` sono PERSONE (negli altri sono chiavi, es. i permessi di un ruolo). */
const PEOPLE_LIST_TYPES: ReadonlySet<string> = new Set(["department.members_changed", "department.home_managers_changed"]);

function redact(type: string, data: ChangeEntry["data"], people: "all" | string[], codes: Set<string> | null): ChangeEntry["data"] {
  const params = { ...(data.params ?? {}) };
  if (people !== "all" && PEOPLE_LIST_TYPES.has(type)) {
    for (const side of ["added", "removed"] as const) {
      const ids = params[side];
      const names = params[`${side}Names`];
      if (!Array.isArray(ids)) continue;
      const keep = ids.map((id, i) => ({ id, name: Array.isArray(names) ? names[i] : undefined })).filter((p) => people.includes(p.id));
      params[side] = keep.map((p) => p.id);
      if (Array.isArray(names)) params[`${side}Names`] = keep.map((p) => p.name ?? "");
    }
  }
  if (codes && Array.isArray(params.projects)) {
    params.projects = params.projects.filter((p) => codes.has(p.split(" · ")[0] ?? ""));
  }
  return { ...data, params };
}

/** Quali oggetti esistono ancora: ruoli, reparti, persone (`objectDeleted`). */
async function existingObjects(db: Db, rows: { subjectKind: string; subjectId: string }[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = (kind: string) => [...new Set(rows.filter((r) => r.subjectKind === kind).map((r) => r.subjectId))];
  const uuidish = (xs: string[]) => xs.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const r = uuidish(ids("role"));
  if (r.length) for (const x of await db.select({ id: roles.id }).from(roles).where(inArray(roles.id, r))) out.add(`role:${x.id}`);
  const d = uuidish(ids("department"));
  if (d.length) for (const x of await db.select({ id: departments.id }).from(departments).where(inArray(departments.id, d))) out.add(`department:${x.id}`);
  for (const kind of PERSON_SUBJECTS) {
    const p = uuidish(ids(kind));
    if (p.length) for (const x of await db.select({ id: users.id }).from(users).where(inArray(users.id, p))) out.add(`${kind}:${x.id}`);
  }
  // Gli inviti e il resto non si eliminano come oggetto da aprire: restano «presenti».
  for (const row of rows) if (!["role", "department", ...PERSON_SUBJECTS].includes(row.subjectKind)) out.add(`${row.subjectKind}:${row.subjectId}`);
  return out;
}

/** `GET /api/projects/:projectId/change-log`: invisibile → 404 (lo fa la rotta), senza gestione → 403. */
export async function listProjectChanges(db: Db, viewer: Viewer, projectId: string, filter: Omit<ChangeLogFilter, "project">): Promise<ChangeLogPage> {
  const held = await projectPermissionsFor(db, viewer, projectId);
  if (!held) throw new RoleRuleError(404, "not_found", "Project not found");
  if (!MANAGE_PROJECT.some((p) => held.has(p))) throw new RoleRuleError(403, "forbidden", "Missing permission");
  return listChanges(db, viewer, { ...filter, project: projectId });
}

/** `GET /api/change-log/filters`: le persone e i progetti visibili, i gruppi che si leggono. */
export async function changeLogFilters(db: Db, viewer: Viewer, projectId?: string): Promise<ChangeLogFilters> {
  const readable = await readableBy(db, viewer);
  if (projectId && !readable.readableProjects.includes(projectId)) throw new RoleRuleError(404, "not_found", "Project not found");
  const people = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.isAgent, false), ...(readable.visiblePeople === "all" ? [] : [readable.visiblePeople.length ? inArray(users.id, readable.visiblePeople) : sql`false`])))
    .orderBy(asc(users.email));
  const list = readable.readableProjects.length
    ? await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, readable.readableProjects)).orderBy(asc(projects.code))
    : [];
  const perProject = await projectPermissionsMapFor(db, viewer);
  const everything = viewer.instancePermissions.has("changelog.view") || viewer.instancePermissions.has("instance.full_admin");
  const projectReadable = [...perProject].some(([id, held]) => (!projectId || id === projectId) && (everything || MANAGE_PROJECT.some((p) => held.has(p))));
  const groups = new Set<string>([
    ...(projectId ? [] : readable.instanceTypes.map((t) => t.group)),
    ...(projectReadable ? CHANGE_LOG_TYPES.filter((t) => t.scope === "project").map((t) => t.group) : []),
  ]);
  // Area 9, F7: «By Claude» solo se chi guarda ne legge almeno una (lì, con `projectId`).
  const [claude] = await db
    .select({ id: changeLog.id })
    .from(changeLog)
    .where(and(readable.where, isNotNull(changeLog.viaClaudeActionId), projectId ? eq(changeLog.projectId, projectId) : undefined))
    .limit(1);
  return {
    everything,
    people: people.map((p) => ({ personId: p.id, name: p.displayName ?? p.email.split("@")[0]! })),
    projects: list.map((p) => ({ projectId: p.id, code: p.code, name: p.name })),
    groups: [...groups],
    claude: claude !== undefined,
  };
}


/**
 * Area 9, F6 (R-G5 del prototipo, `changelog/reads.ts`): le voci che nominano
 * un progetto ELIMINATO si risolvono a lettura, dalla sua memoria
 * (`deleted_projects`). Chi lo conosceva (ne era membro, o è full admin)
 * legge `CODICE · Nome` in `project.deleted` e `params.formerProject` (il
 * codice) in `repository.deleted`; gli altri leggono «un progetto che non
 * vedi» (`hidden`, `object.id` = `"hidden"`, etichetta vuota) e nessuna
 * provenienza.
 * `formerProjectId` non esce mai.
 */
async function resolveDeletedProjects(db: Db, viewer: Viewer, entries: ChangeEntry[]): Promise<void> {
  const idOf = (e: ChangeEntry): string | null => {
    if (e.type === "project.deleted") return e.data.object?.id ?? null;
    if (e.type === "repository.deleted") return typeof e.data.params?.formerProjectId === "string" ? e.data.params.formerProjectId : null;
    return null;
  };
  const ids = [...new Set(entries.map(idOf).filter((id): id is string => id !== null && /^[0-9a-f-]{36}$/i.test(id)))];
  const memory = new Map(
    ids.length ? (await db.select().from(deletedProjects).where(inArray(deletedProjects.id, ids))).map((p) => [p.id, p] as const) : [],
  );
  const fullAdmin = viewer.instancePermissions.has("instance.full_admin");
  const known = new Set(
    fullAdmin || ids.length === 0
      ? ids
      : (await db.select({ id: deletedProjectMembers.projectId }).from(deletedProjectMembers).where(and(inArray(deletedProjectMembers.projectId, ids), eq(deletedProjectMembers.userId, viewer.id)))).map((r) => r.id),
  );
  for (const e of entries) {
    const id = idOf(e);
    if (e.type === "repository.deleted") {
      const params = { ...(e.data.params ?? {}) };
      delete params.formerProjectId;
      const p = id ? memory.get(id) : undefined;
      if (p && known.has(p.id)) params.formerProject = p.code;
      e.data = { ...e.data, params };
      continue;
    }
    if (e.type !== "project.deleted") continue;
    const p = id ? memory.get(id) : undefined;
    if (p && known.has(p.id)) {
      e.data = { ...e.data, object: { ...e.data.object!, label: `${p.code} · ${p.name}` } };
    } else {
      e.hidden = true;
      // `object.id` non può essere vuoto (lo schema dei client, anche dei
      // vecchi, lo vuole): un segnaposto che non dice niente.
      e.data = { ...e.data, object: { ...e.data.object!, id: "hidden", label: "" } };
    }
  }
}
