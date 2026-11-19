import { ApiError } from "@stubwise/api-client";
import type { DepartmentView as ServerDepartment } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { AdminRefusal, DepartmentView } from "../../admin/types";
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
    // Area 9, F8 (72, 39071e1f8): la riconferma quando si danno accessi, l'escalation
    // coi permessi mancanti, l'ultimo gestore di un progetto, nelle parole del prototipo.
    if (error.code === "reauth_required") return { ok: false, error: "reauth_required" };
    if (error.code === "escalation") {
      const missing = (error.details as { missing?: string[] } | undefined)?.missing ?? [];
      return { ok: false, error: "escalation", missing };
    }
    if (error.code === "last_manager") return { ok: false, error: "invalid", reason: "last_members_manager" };
    if (error.code === "invalid_permission") return { ok: false, error: "invalid", reason: "permission" };
    if (error.code === "not_a_person") return { ok: false, error: "invalid", reason: "person" };
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
/**
 * I permessi di progetto di ogni reparto come li ha letti l'elenco (F8): il
 * salvataggio li manda solo se la bozza li CAMBIA rispetto a qui (decisione
 * di 46). Un reparto mai letto non li manda: una sessione con dati vecchi non
 * cancella i permessi salvati.
 */
const loadedPermissions = new Map<string, string[]>();

/** SOLO TEST: dimentica i permessi letti (ogni test parte da un elenco mai letto). */
export function forgetLoadedDepartmentsForTest(): void {
  loadedPermissions.clear();
}

function view(d: ServerDepartment, memberIds: string[], homeManagerIds: string[]): DepartmentView {
  const projectPermissions = [...((d as { projectPermissions?: string[] }).projectPermissions ?? [])];
  loadedPermissions.set(d.id, projectPermissions);
  return {
    id: d.id,
    name: d.name,
    colorToken: d.colorToken,
    memberIds,
    homeManagerIds,
    projectPermissions,
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

/**
 * L'anteprima di una bozza (F8, F8-2 = a): la calcola il server con la
 * regola di `judgeDraft` del prototipo, per chi guarda; il client non deduce
 * i permessi. La tabella e «Add people» del pannello la leggono come prima.
 */
const previewDepartment: Admin["previewDepartment"] = async (id, draft) => {
  const p = await appClient().departments.preview(id, {
    memberIds: [...draft.memberIds],
    projectPermissions: [...draft.projectPermissions],
  });
  return {
    reach: p.reach === "anywhere" ? "anywhere" : "projects",
    notGivable: [...p.notGivable],
    missingToAdd: Object.fromEntries(Object.entries(p.missingToAdd).map(([k, v]) => [k, [...v]])),
    missing: [...p.missing],
  };
};

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
/** `projectPermissions` nel PATCH solo se la bozza cambia ciò che l'elenco ha letto (F8). */
function permissionsPatch(id: string, draft: readonly string[]): { projectPermissions?: string[] } {
  const loaded = loadedPermissions.get(id);
  const next = [...new Set(draft)];
  if (!loaded) return {};
  const same = next.length === loaded.length && next.every((p) => loaded.includes(p));
  return same ? {} : { projectPermissions: next };
}

const saveDepartment: Admin["saveDepartment"] = async (id, draft) => {
  const patch = {
    ...(draft.name !== undefined ? { name: draft.name.trim() } : {}),
    ...(draft.colorToken !== undefined
      ? { colorToken: draft.colorToken as ServerDepartment["colorToken"] }
      : {}),
    memberIds: [...new Set(draft.memberIds)],
    ...permissionsPatch(id, draft.projectPermissions),
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

export const adminDepartments: Partial<Admin> = {
  listDepartments,
  previewDepartment,
  createDepartment,
  updateDepartment,
  saveDepartment,
  deleteDepartment,
  // `listPeople` dall'area 9, R7: la lettura calcolata di `adminPeople.ts`.
};
