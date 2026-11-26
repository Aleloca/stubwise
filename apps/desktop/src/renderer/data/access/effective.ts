import {
  effectivePermissionsIn,
  instanceRoleIn,
  isActivePersonIn,
  isFullAdminIn,
  projectRoleIn,
  type PermissionSource,
} from "./effectiveCore";
import { accessState, type RoleDef } from "./state";

// I permessi sullo stato degli accessi del prototipo: le versioni di
// `effectiveCore.ts` (il calcolo unico) applicate a `accessState()`.
export * from "./effectiveCore";

/** Il ruolo d'istanza di una persona; `null` per chi non ha accessi (Claude, un id sconosciuto). */
export function instanceRoleOf(personId: string): RoleDef | null {
  return instanceRoleIn(accessState(), personId);
}

/** Vero se la persona ha `instance.full_admin`, dal ruolo d'istanza o da una concessione. */
export function isFullAdmin(personId: string): boolean {
  return isFullAdminIn(accessState(), personId);
}

export const isActivePerson = (personId: string): boolean =>
  isActivePersonIn(accessState(), personId);

/** Una persona che c'è ed è disattivata (una sconosciuta no). */
export const isDeactivated = (personId: string): boolean =>
  accessState().people.some((p) => p.personId === personId && p.status === "deactivated");

/**
 * Se la persona ha un'appartenenza esplicita al progetto. Claude non ne ha
 * (R-L9: è membro implicito di ogni progetto, e lo risolve `can()`).
 */
export function isMember(personId: string, projectId: string): boolean {
  return accessState().memberships.some(
    (m) => m.personId === personId && m.projectId === projectId,
  );
}

/** Il ruolo di progetto di una persona; `null` se non è membro. */
export function projectRoleOf(personId: string, projectId: string): RoleDef | null {
  return projectRoleIn(accessState(), personId, projectId);
}

/** I reparti di cui la persona gestisce la Home (`department.home.manage`). */
export function homeManagedDepartments(personId: string): string[] {
  return accessState()
    .departments.filter((d) => d.homeManagerIds.includes(personId))
    .map((d) => d.departmentId);
}

/**
 * I permessi effettivi di una persona, ognuno con le sue fonti. Con
 * `projectId`: quelli di progetto in quel progetto (ruolo, concessioni,
 * reparto; il full admin li ha tutti, membro o no). Senza: quelli d'istanza.
 * Claude non ha ruoli, appartenenze né reparti: per lui la mappa è vuota, e
 * il suo insieme fisso lo legge `can()` (R-L9, in testa).
 */
export function effectivePermissions(
  personId: string,
  projectId?: string,
): Map<string, PermissionSource[]> {
  return effectivePermissionsIn(accessState(), personId, projectId);
}
