import { accessState, roleIdOf } from "../access/index";
import "../admin/changeTypes";
import { recordChange } from "../changelog/index";
import { gate } from "../store";
import { createPerson, newPersonInputError } from "./register";

// Il primo avvio (area 9a, Ingresso): su un'istanza vuota si crea il primo
// full admin (ruolo Admin). Come la registrazione, non apre una sessione:
// dopo si entra dal login (`second-factor.md`), e il secondo fattore si
// attiva alla prima azione delicata.

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
  return { ok: true, personId };
}
