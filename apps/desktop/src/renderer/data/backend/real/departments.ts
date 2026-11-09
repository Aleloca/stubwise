import { ApiError } from "@stubwise/api-client";
import type { DepartmentView as ServerDepartment } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { AdminRefusal, DepartmentView, PersonRow } from "../../admin/types";
import { appClient } from "./client";
import { countTasks } from "./tasks";

// Amministrazione → Reparti nella build app (integrazione area 2, fetta 1).
// Del prototipo entrano nome, colore e membri (design, «Reparti»): i
// responsabili della Home arrivano con la fetta 3, e sul server un reparto
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
function view(d: ServerDepartment, memberIds: string[]): DepartmentView {
  return {
    id: d.id,
    name: d.name,
    colorToken: d.colorToken,
    memberIds,
    homeManagerIds: [],
    projectPermissions: [],
    taskCount: 0,
    missingToAdd: {},
    reach: "projects",
    notGivable: [],
  };
}

const listDepartments: Admin["listDepartments"] = async () => {
  const [rows, members] = await Promise.all([appClient().departments.list(), membersByDepartment()]);
  return rows.map((d) => view(d as ServerDepartment, members.get(d.id) ?? []));
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

/** Salva la bozza del pannello: nome, colore e membri (il resto non c'è nella build app). */
const saveDepartment: Admin["saveDepartment"] = async (id, draft) => {
  try {
    await appClient().departments.update(id, {
      ...(draft.name !== undefined ? { name: draft.name.trim() } : {}),
      ...(draft.colorToken !== undefined
        ? { colorToken: draft.colorToken as ServerDepartment["colorToken"] }
        : {}),
      memberIds: [...new Set(draft.memberIds)],
    });
    return { ok: true };
  } catch (error) {
    return refusalOf(error);
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
