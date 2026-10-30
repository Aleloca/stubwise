import {
  ALL_PROJECT_PERMISSIONS,
  accessState,
  writeAccess,
  type AccessState,
} from "../access/index";
import { recordChange } from "../changelog/index";
import { gate, newId, state } from "../store";
import type { Department } from "../types";
import { writer } from "../writer";
import {
  canI,
  escalationIn,
  invariantRefusal,
  isActive,
  isHumanId,
  missingIn,
  nameOf,
  projectsOf,
  reauthRefusal,
  refuse,
} from "./common";
import type { AdminRefusal, AdminResult, DepartmentView } from "./types";
import "./changeTypes";

// Departments (area 9a), tutto con `departments.manage`. Un reparto ha nome e
// colore (la palette dei reparti di `DESIGN.md`), persone, chi ne gestisce la
// Home e i permessi di progetto che dà ai suoi membri — solo nei progetti di
// cui sono già membri: un reparto non rende membri di niente.
//
// `setDepartmentMembers` è l'unica scrittura di chi sta in un reparto: scrive
// `access.departments`, e `Person.departmentIds` (che leggono le pagine) lo
// riallinea lo store dopo la scrittura (`syncPersonDepartments`), senza
// un'altra strada.
//
// Anti-escalation sul DARE, nei progetti dove il permesso arriva (ruling
// R-M2): chi entra nel reparto ne riceve i permessi in ogni progetto di cui
// è membro, quindi chi agisce li deve avere in ognuno di quei progetti; un
// permesso messo nel reparto arriva in ogni progetto di cui è membro almeno
// una persona del reparto, quindi lì. Togliere una persona o un permesso non
// passa da lì, ma dai blocchi sì (un reparto può portare
// `project.members.manage`).

const DEPARTMENTS_MANAGE = "departments.manage";
/** Le otto tinte dei reparti (`DESIGN.md`). */
export const DEPARTMENT_COLORS: readonly Department["colorToken"][] = [
  "--dept-1",
  "--dept-2",
  "--dept-3",
  "--dept-4",
  "--dept-5",
  "--dept-6",
  "--dept-7",
  "--dept-8",
];

const accessOf = (s: AccessState, id: string) => s.departments.find((d) => d.departmentId === id);
const departmentOf = (id: string) => state.departments.find((d) => d.id === id);
const label = (d: Department) => ({ type: "department", id: d.id, label: d.name });

/** I progetti dove arriva un permesso del reparto: quelli dei suoi membri. */
const reachedBy = (memberIds: readonly string[]): string[] => [
  ...new Set(memberIds.flatMap(projectsOf)),
];

/** Il reparto su cui agire: con il permesso (o `forbidden`), esistente (o `not_found`). */
function managed(me: string, id: string): { department: Department } | { refusal: AdminRefusal } {
  if (!canI(me, DEPARTMENTS_MANAGE)) return { refusal: refuse.forbidden() };
  const department = departmentOf(id);
  if (!department || !accessOf(accessState(), id)) return { refusal: refuse.notFound() };
  return { department };
}

/** I reparti con le loro persone, la Home e i permessi (`departments.manage`). */
export async function listDepartments(): Promise<DepartmentView[]> {
  const me = await gate("admin.listDepartments");
  if (!canI(me, DEPARTMENTS_MANAGE)) throw new Error("forbidden");
  return state.departments.map((d) => {
    const a = accessOf(accessState(), d.id);
    const perms = a?.projectPermissions ?? [];
    const reached = reachedBy(a?.memberIds ?? []);
    const candidates = accessState().people.filter(
      (p) => p.status === "active" && isHumanId(p.personId) && !a?.memberIds.includes(p.personId),
    );
    return {
      id: d.id,
      name: d.name,
      colorToken: d.colorToken,
      memberIds: [...(a?.memberIds ?? [])].sort((x, y) =>
        (nameOf(x) ?? x).localeCompare(nameOf(y) ?? y),
      ),
      homeManagerIds: [...(a?.homeManagerIds ?? [])],
      projectPermissions: [...(a?.projectPermissions ?? [])],
      taskCount: state.tasks.filter((t) => t.departmentId === d.id).length,
      missingToAdd: Object.fromEntries(
        candidates.map((p) => [p.personId, missingIn(me, projectsOf(p.personId), perms)]),
      ),
      // La stessa regola di `setDepartmentPermissions` su ciò che si aggiunge.
      reach: reached.length > 0 ? "projects" : "anywhere",
      notGivable: missingIn(me, reached, ALL_PROJECT_PERMISSIONS),
    };
  });
}

const validName = (name: string, except?: string): string | null => {
  const clean = name.trim();
  if (!clean) return "name";
  const taken = state.departments.some(
    (d) => d.id !== except && d.name.toLowerCase() === clean.toLowerCase(),
  );
  return taken ? "name_taken" : null;
};

/** Crea un reparto vuoto, con nome e colore (`departments.manage`). */
export async function createDepartment(input: {
  name: string;
  colorToken: string;
}): Promise<AdminResult<{ departmentId: string }>> {
  const me = await writer("admin.createDepartment");
  if (!canI(me, DEPARTMENTS_MANAGE)) return refuse.forbidden();
  const bad = validName(input.name);
  if (bad) return refuse.invalid(bad);
  if (!DEPARTMENT_COLORS.includes(input.colorToken as Department["colorToken"]))
    return refuse.invalid("color");
  const department: Department = {
    id: newId("dep"),
    name: input.name.trim(),
    colorToken: input.colorToken as Department["colorToken"],
  };
  state.departments.push(department);
  writeAccess((s) => {
    s.departments.push({
      departmentId: department.id,
      memberIds: [],
      homeManagerIds: [],
      projectPermissions: [],
    });
  });
  recordChange({
    kind: "department.created",
    actorId: me,
    projectId: null,
    object: label(department),
    after: department.name,
  });
  return { ok: true, departmentId: department.id };
}

/** Rinomina o ricolora un reparto (`departments.manage`). */
export async function updateDepartment(
  id: string,
  patch: { name?: string; colorToken?: string },
): Promise<AdminResult> {
  const me = await writer("admin.updateDepartment");
  const m = managed(me, id);
  if ("refusal" in m) return m.refusal;
  const { department } = m;
  if (patch.name !== undefined) {
    const bad = validName(patch.name, id);
    if (bad) return refuse.invalid(bad);
  }
  if (
    patch.colorToken !== undefined &&
    !DEPARTMENT_COLORS.includes(patch.colorToken as Department["colorToken"])
  )
    return refuse.invalid("color");
  const before = `${department.name} ${department.colorToken}`;
  if (patch.name !== undefined) department.name = patch.name.trim();
  if (patch.colorToken !== undefined)
    department.colorToken = patch.colorToken as Department["colorToken"];
  recordChange({
    kind: "department.updated",
    actorId: me,
    projectId: null,
    object: label(department),
    before,
    after: `${department.name} ${department.colorToken}`,
  });
  return { ok: true };
}

/** Chi entra deve essere una persona attiva (niente Claude, niente disattivati). */
const badPeople = (ids: readonly string[], keep: readonly string[]) =>
  ids.some((id) => !isHumanId(id) || (!keep.includes(id) && !isActive(id)));

/**
 * Le persone del reparto (+R): l'insieme intero. Chi entra riceve i
 * permessi del reparto, quindi chi agisce li deve avere; chi esce li perde
 * a lettura.
 */
export async function setDepartmentMembers(id: string, memberIds: string[]): Promise<AdminResult> {
  const me = await writer("admin.setDepartmentMembers");
  const m = managed(me, id);
  if ("refusal" in m) return m.refusal;
  const current = accessOf(accessState(), id)!;
  const next = [...new Set(memberIds)];
  if (badPeople(next, current.memberIds)) return refuse.invalid("person");
  const added = next.filter((p) => !current.memberIds.includes(p));
  const removed = current.memberIds.filter((p) => !next.includes(p));
  if (added.length === 0 && removed.length === 0) return refuse.invalid("unchanged");
  // Chi entra riceve i permessi del reparto in ogni suo progetto.
  const missing = new Set(
    added.flatMap((p) => missingIn(me, projectsOf(p), current.projectPermissions)),
  );
  if (missing.size > 0)
    return {
      ok: false,
      error: "escalation",
      missing: current.projectPermissions.filter((p) => missing.has(p)),
    };
  const mutate = (s: AccessState) => {
    accessOf(s, id)!.memberIds = next;
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.setDepartmentMembers");
  if (reauth) return reauth;
  writeAccess(mutate);
  recordChange({
    kind: "department.members_changed",
    actorId: me,
    projectId: null,
    object: label(m.department),
    params: { added: added.join(","), removed: removed.join(",") },
  });
  return { ok: true };
}

/**
 * Chi gestisce la Home del reparto (`department.home.manage`, +R).
 * `departments.manage` è il permesso che gestisce i reparti, Home compresa:
 * per questo non c'è un confronto d'escalation su `department.home.manage`.
 */
export async function setHomeManagers(id: string, personIds: string[]): Promise<AdminResult> {
  const me = await writer("admin.setHomeManagers");
  const m = managed(me, id);
  if ("refusal" in m) return m.refusal;
  const current = accessOf(accessState(), id)!;
  const next = [...new Set(personIds)];
  if (badPeople(next, current.homeManagerIds)) return refuse.invalid("person");
  const added = next.filter((p) => !current.homeManagerIds.includes(p));
  const removed = current.homeManagerIds.filter((p) => !next.includes(p));
  if (added.length === 0 && removed.length === 0) return refuse.invalid("unchanged");
  const reauth = reauthRefusal(me, "admin.setHomeManagers");
  if (reauth) return reauth;
  writeAccess((s) => {
    accessOf(s, id)!.homeManagerIds = next;
  });
  recordChange({
    kind: "department.home_managers_changed",
    actorId: me,
    projectId: null,
    object: label(m.department),
    params: { added: added.join(","), removed: removed.join(",") },
  });
  return { ok: true };
}

/**
 * I permessi di progetto che il reparto dà (+R). Si controlla ciò che si
 * AGGIUNGE; un permesso che non è di progetto non c'entra con un reparto.
 */
export async function setDepartmentPermissions(
  id: string,
  permissions: string[],
): Promise<AdminResult> {
  const me = await writer("admin.setDepartmentPermissions");
  const m = managed(me, id);
  if ("refusal" in m) return m.refusal;
  const current = accessOf(accessState(), id)!;
  const next = [...new Set(permissions)];
  const added = next.filter((p) => !current.projectPermissions.includes(p));
  const removed = current.projectPermissions.filter((p) => !next.includes(p));
  // Prima l'escalation: chi mette `instance.full_admin` in un reparto senza
  // averlo si sente dire questo, non «non è un permesso di progetto».
  // Un permesso nuovo arriva in ogni progetto di cui è membro una persona del reparto.
  const reached = reachedBy(current.memberIds);
  const escalation = escalationIn(me, reached, added);
  if (escalation) return escalation;
  if (next.some((p) => !ALL_PROJECT_PERMISSIONS.includes(p))) return refuse.invalid("permission");
  if (added.length === 0 && removed.length === 0) return refuse.invalid("unchanged");
  const mutate = (s: AccessState) => {
    accessOf(s, id)!.projectPermissions = next;
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.setDepartmentPermissions");
  if (reauth) return reauth;
  writeAccess(mutate);
  recordChange({
    kind: "department.permissions_changed",
    actorId: me,
    projectId: null,
    object: label(m.department),
    params: { added: added.join(","), removed: removed.join(",") },
  });
  return { ok: true };
}

/**
 * Elimina un reparto (`departments.manage`). Le persone restano (non sono
 * più in quel reparto). Se delle task lo hanno come reparto di pertinenza,
 * `moveTasksTo` dice in quale reparto spostarle: senza, `invalid:
 * move_required` (una task ha sempre un reparto).
 */
export async function deleteDepartment(
  id: string,
  moveTasksTo: string | null,
): Promise<AdminResult<{ moved: number }>> {
  const me = await writer("admin.deleteDepartment");
  const m = managed(me, id);
  if ("refusal" in m) return m.refusal;
  const tasks = state.tasks.filter((t) => t.departmentId === id);
  if (tasks.length > 0) {
    if (moveTasksTo === null) return refuse.invalid("move_required");
    if (moveTasksTo === id || !departmentOf(moveTasksTo)) return refuse.invalid("target");
  }
  const mutate = (s: AccessState) => {
    s.departments = s.departments.filter((d) => d.departmentId !== id);
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  for (const t of tasks) t.departmentId = moveTasksTo!;
  state.departments = state.departments.filter((d) => d.id !== id);
  state.departmentHomes = state.departmentHomes.filter((h) => h.departmentId !== id);
  writeAccess(mutate);
  recordChange({
    kind: "department.deleted",
    actorId: me,
    projectId: null,
    object: label(m.department),
    before: m.department.name,
    params: { moved: String(tasks.length), to: moveTasksTo ?? "" },
  });
  return { ok: true, moved: tasks.length };
}
