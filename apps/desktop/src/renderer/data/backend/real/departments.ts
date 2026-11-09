import { ApiError } from "@stubwise/api-client";
import type { DepartmentView as ServerDepartment } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { AdminRefusal, DepartmentView, PersonRow } from "../../admin/types";
import { appClient } from "./client";
import { countTasks } from "./tasks";

// Amministrazione → Reparti nella build app (integrazione area 2, fetta 1).
// Del prototipo entrano nome, colore e membri (design, «Reparti»), e dalla
// fetta 3 i responsabili della Home (`department.home.manage`, i ruoli di
// reparto, senza riconferma: decisione del maintainer). Sul server un reparto
// non dà permessi di progetto. Le parti del prototipo che giudicano quei
// permessi (anteprima, escalation, «chi non si può aggiungere») qui sono
// neutre, e la pagina non le mostra. Nessuna riconferma: il server non la
// chiede su queste rotte (e un PAT del desktop non potrebbe soddisfarla).

type Admin = typeof Fake.admin;

/** Un rifiuto del server nella forma del prototipo. */
function refusalOf(error: unknown): AdminRefusal {
  if (error instanceof ApiError) {
    if (error.status === 403) return { ok: false, error: "forbidden" };
    if (error.status === 404) return { ok: false, error: "not_found" };
    const reason =
      error.code === "department_name_taken"
        ? "name_taken"
        : error.code === "department_has_tasks"
          ? "move_required"
          : error.code === "department_move_target_invalid"
            ? "target"
            : error.code === "department_is_default"
              ? "default_department"
              : (error.code ?? "invalid");
    if (error.status === 400 || error.status === 409) return { ok: false, error: "invalid", reason };
  }
  throw error;
}

/** I membri di ogni reparto, dalle persone (`departmentIds` di `/api/people`). */
async function membersByDepartment(): Promise<Map<string, string[]>> {
  const people = await appClient().people.list();
  const map = new Map<string, string[]>();
  for (const p of people) for (const d of p.departmentIds) map.set(d, [...(map.get(d) ?? []), p.id]);
  return map;
}

/**
 * `taskCount` non si scarica con l'elenco: lo legge il dialogo
 * dell'eliminazione, all'apertura (`countTasks` filtrato per reparto).
 */
function view(d: ServerDepartment, memberIds: string[], homeManagerIds: string[]): DepartmentView {
  return {
    id: d.id,
    name: d.name,
    colorToken: d.colorToken,
    memberIds,
    homeManagerIds,
    projectPermissions: [],
    taskCount: 0,
    missingToAdd: {},
    reach: "projects",
    notGivable: [],
  };
}

/** Chi gestisce la Home di ogni reparto, dai ruoli di reparto. */
async function homeManagersByDepartment(): Promise<Map<string, string[]>> {
  const roles = await appClient().departments.roles();
  const map = new Map<string, string[]>();
  for (const r of roles) {
    if (r.permissions.includes(HOME_MANAGE)) map.set(r.departmentId, [...(map.get(r.departmentId) ?? []), r.userId]);
  }
  return map;
}

const HOME_MANAGE = "department.home.manage";

const listDepartments: Admin["listDepartments"] = async () => {
  const [rows, members, managers] = await Promise.all([
    appClient().departments.list(),
    membersByDepartment(),
    homeManagersByDepartment(),
  ]);
  return rows.map((d) => view(d as ServerDepartment, members.get(d.id) ?? [], managers.get(d.id) ?? []));
};

const previewDepartment: Admin["previewDepartment"] = async () => ({
  reach: "projects",
  notGivable: [],
  missingToAdd: {},
  missing: [],
});

const createDepartment: Admin["createDepartment"] = async (input) => {
  try {
    const d = await appClient().departments.create({
      name: input.name.trim(),
      colorToken: input.colorToken as ServerDepartment["colorToken"],
    });
    return { ok: true, departmentId: d.id };
  } catch (error) {
    return refusalOf(error);
  }
};

const updateDepartment: Admin["updateDepartment"] = async (id, patch) => {
  try {
    await appClient().departments.update(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.colorToken !== undefined
        ? { colorToken: patch.colorToken as ServerDepartment["colorToken"] }
        : {}),
    });
    return { ok: true };
  } catch (error) {
    return refusalOf(error);
  }
};

/**
 * La bozza (nome, colore, membri) già salvata per un reparto i cui ruoli non
 * sono andati: riprovando la stessa bozza si riscrivono solo i ruoli.
 */
const membersSaved = new Map<string, string>();

/**
 * I ruoli del reparto dopo il salvataggio: quelli letti (un permesso di reparto
 * che questa app non conosce resta), con `department.home.manage` a chi la
 * bozza dice, solo fra i membri (il server rifiuta un non membro).
 */
async function rolesFor(id: string, memberIds: string[], homeManagerIds: string[]) {
  const members = new Set(memberIds);
  const current = (await appClient().departments.roles()).filter((r) => r.departmentId === id);
  const out = new Map<string, string[]>();
  for (const r of current) {
    if (members.has(r.userId)) out.set(r.userId, r.permissions.filter((p) => p !== HOME_MANAGE));
  }
  for (const userId of new Set(homeManagerIds)) {
    if (members.has(userId)) out.set(userId, [...(out.get(userId) ?? []), HOME_MANAGE]);
  }
  return [...out].map(([userId, permissions]) => ({ userId, permissions }));
}

/**
 * Salva la bozza del pannello: nome, colore e membri, poi i responsabili della
 * Home (i ruoli del reparto, fusi con quelli letti). I permessi di progetto
 * dati dal reparto non ci sono nella build app. Se i membri sono salvati e i
 * ruoli no, lo dice (`roles_not_saved`): riprovando, solo i ruoli.
 */
const saveDepartment: Admin["saveDepartment"] = async (id, draft) => {
  const patch = {
    ...(draft.name !== undefined ? { name: draft.name.trim() } : {}),
    ...(draft.colorToken !== undefined
      ? { colorToken: draft.colorToken as ServerDepartment["colorToken"] }
      : {}),
    memberIds: [...new Set(draft.memberIds)],
  };
  const key = JSON.stringify(patch);
  try {
    if (membersSaved.get(id) !== key) await appClient().departments.update(id, patch);
  } catch (error) {
    return refusalOf(error);
  }
  try {
    await appClient().departments.setRoles(id, (await rolesFor(id, patch.memberIds, draft.homeManagerIds)) as never);
    membersSaved.delete(id);
    return { ok: true };
  } catch (error) {
    membersSaved.set(id, key);
    if (error instanceof ApiError && error.status === 400) return refusalOf(error);
    return { ok: false, error: "invalid", reason: "roles_not_saved" };
  }
};

const deleteDepartment: Admin["deleteDepartment"] = async (id, moveTasksTo) => {
  try {
    const moved = moveTasksTo ? (await countTasks({ departmentIds: [id] })).count : 0;
    await appClient().departments.remove(id, moveTasksTo ?? undefined);
    return { ok: true, moved };
  } catch (error) {
    return refusalOf(error);
  }
};

/**
 * Le persone come le legge l'amministrazione (`useAdminPeople`), dalle
 * persone che chi guarda vede: nome, iniziali, reparti, attiva o
 * disattivata. Ruolo d'istanza, progetti e inviti arrivano con
 * l'amministrazione delle persone (in arrivo).
 */
const listPeople: Admin["listPeople"] = async (filter = {}) => {
  const [people, departments] = await Promise.all([
    appClient().people.list(),
    appClient().departments.list(),
  ]);
  const byId = new Map(departments.map((d) => [d.id, d]));
  const q = filter.q?.trim().toLowerCase();
  return people
    .map<PersonRow>((p) => ({
      personId: p.id,
      name: p.name,
      email: p.email,
      avatar: p.initials,
      instanceRole: null,
      departments: p.departmentIds.flatMap((id) => {
        const d = byId.get(id);
        return d ? [{ id: d.id, name: d.name, colorToken: d.colorToken }] : [];
      }),
      projects: [],
      status: p.deactivated ? "deactivated" : "active",
      deactivatedAt: null,
      invite: null,
    }))
    .filter((row) => !filter.statuses || filter.statuses.includes(row.status))
    .filter((row) => !filter.departmentIds || row.departments.some((d) => filter.departmentIds!.includes(d.id)))
    .filter((row) => !q || row.name.toLowerCase().includes(q) || row.email.toLowerCase().includes(q));
};

export const adminDepartments: Partial<Admin> = {
  listDepartments,
  previewDepartment,
  createDepartment,
  updateDepartment,
  saveDepartment,
  deleteDepartment,
  listPeople,
};
