import { accessState, roleIdOf, writeAccess } from "../access/index";
import "../admin/changeTypes";
import { recordChange } from "../changelog/index";
import { gate, newId, state } from "../store";
import { createPerson, newPersonInputError } from "./register";

// Il primo avvio (area 9a, Ingresso): su un'istanza vuota si crea il primo
// full admin (ruolo Admin). Come la registrazione, non apre una sessione:
// dopo si entra dal login (`second-factor.md`), e il secondo fattore si
// attiva alla prima azione delicata.
//
// Nasce anche il primo reparto, «General», con dentro il primo admin: ogni
// task ha un reparto (ossatura), e una task nuova prende il primo reparto di
// chi la crea. L'ultimo reparto non si elimina (`deleteDepartment`).

/** Il nome del reparto che nasce col primo avvio. */
export const FIRST_DEPARTMENT_NAME = "General";

export type FirstAdminResult =
  | { ok: true; personId: string }
  | { ok: false; error: "not_empty" }
  | { ok: false; error: "invalid_input"; reason: "name" | "email" | "password" | "email_taken" };

/** Vuota = nessuna persona tranne Claude (che non è fra le persone degli accessi). */
export const instanceIsEmpty = (): boolean => accessState().people.length === 0;

export async function isInstanceEmpty(): Promise<boolean> {
  await gate("auth.isInstanceEmpty");
  return instanceIsEmpty();
}

/** Crea il primo full admin. Solo su un'istanza vuota: dopo, gli altri arrivano per invito. */
export async function createFirstAdmin(input: {
  name: string;
  email: string;
  password: string;
}): Promise<FirstAdminResult> {
  await gate("auth.createFirstAdmin");
  if (!instanceIsEmpty()) return { ok: false, error: "not_empty" };
  const reason = newPersonInputError(input);
  if (reason) return { ok: false, error: "invalid_input", reason };
  const personId = createPerson({
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    password: input.password,
    instanceRoleId: roleIdOf("admin"),
    projects: [],
  });
  recordChange({
    kind: "instance.first_admin_created",
    actorId: personId,
    projectId: null,
    object: { type: "person", id: personId, label: input.name.trim() },
  });
  const departmentId = newId("dep");
  state.departments.push({ id: departmentId, name: FIRST_DEPARTMENT_NAME, colorToken: "--dept-1" });
  writeAccess((s) => {
    s.departments.push({
      departmentId,
      memberIds: [personId],
      homeManagerIds: [],
      projectPermissions: [],
    });
  });
  recordChange({
    kind: "department.created",
    actorId: personId,
    projectId: null,
    object: { type: "department", id: departmentId, label: FIRST_DEPARTMENT_NAME },
    after: FIRST_DEPARTMENT_NAME,
  });
  return { ok: true, personId };
}
