import { effectivePermissionsIn, isFullAdminIn } from "../../data/access/effective";
import type { AccessState } from "../../data/access/state";

// Le due cose che restano sempre (area 9a, Global Constraints): un full admin
// attivo nell'istanza e, in ogni progetto, qualcuno che gestisce i membri.
// Ricevono lo stato come argomento e lo leggono con le varianti `…In` del
// calcolo unico (`data/access/effective.ts`): nessuna seconda copia della
// regola, nessuna lettura dello store.

const MEMBERS_MANAGE = "project.members.manage";

const isActive = (state: AccessState, personId: string): boolean =>
  state.people.some((p) => p.personId === personId && p.status === "active");

/**
 * `last_full_admin`: la modifica toglierebbe il full admin (ruolo d'istanza,
 * disattivazione) all'ultimo full admin attivo. Se la persona oggi non lo è,
 * o non è attiva, non c'è niente da proteggere.
 */
export function lastFullAdminBlock(
  state: AccessState,
  change: { personId: string; losesFullAdmin: boolean },
): null | "last_full_admin" {
  if (!change.losesFullAdmin) return null;
  const active = state.people.filter((p) => p.status === "active").map((p) => p.personId);
  const admins = active.filter((id) => isFullAdminIn(state, id));
  if (!admins.includes(change.personId)) return null;
  return admins.length > 1 ? null : "last_full_admin";
}

/**
 * Chi gestisce i membri del progetto: i membri attivi che hanno
 * `project.members.manage` da qualunque fonte (ruolo, concessione, reparto,
 * full admin). Un full admin conta solo se è membro: è così che «un progetto
 * senza full admin membri» resta senza gestori (Review Focus 3).
 */
export function membersManagersOf(state: AccessState, projectId: string): string[] {
  return state.memberships
    .filter((m) => m.projectId === projectId && isActive(state, m.personId))
    .map((m) => m.personId)
    .filter((id) => effectivePermissionsIn(state, id, projectId).has(MEMBERS_MANAGE));
}

/**
 * `last_members_manager`: la modifica (togliere il ruolo, il permesso,
 * l'appartenenza o disattivare) lascerebbe il progetto senza nessuno che
 * gestisce i membri.
 */
export function lastMembersManagerBlock(
  state: AccessState,
  projectId: string,
  change: { personId: string; losesMembersManage: boolean },
): null | "last_members_manager" {
  if (!change.losesMembersManage) return null;
  const managers = membersManagersOf(state, projectId);
  if (!managers.includes(change.personId)) return null;
  return managers.length > 1 ? null : "last_members_manager";
}
