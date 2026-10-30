import { accessState } from "./access/index";
import "./admin/changeTypes";
import { MANAGE_PROJECT, readsSomeChanges } from "./changelog/visibility";
import { ADMIN_SECTIONS, type AdminSection, type ProjectSettingsSection } from "./routes";
import type { Viewer } from "./types";
import { can } from "./viewer";

// Le voci dell'Amministrazione che chi guarda vede (area 9a, design
// «Amministrazione: com'è fatta», shape admin-people.md §3), in UN posto:
// la colonna, la voce del profilo, `/admin` e le rotte delle voci leggono da
// qui. Sta fuori da `viewer.ts` perché la regola del Change log è quella del
// registro (`readsSomeChanges`), che a sua volta legge `viewer.ts`.
//
// - People e Who can?: ogni persona attiva (Claude e «nessuno» no).
// - Departments: `departments.manage`. Roles: `roles.manage`.
// - Change log: `changelog.view`, oppure le voci di ciò che si gestisce.

/**
 * Una persona umana e attiva: chi ha una sessione nell'app. Claude e
 * «nessuno» non stanno fra le persone degli accessi (R-L9), quindi non passano.
 */
const isActivePerson = (viewer: Viewer): boolean =>
  accessState().people.some((p) => p.personId === viewer.personId && p.status === "active");

function sees(viewer: Viewer, section: AdminSection): boolean {
  if (!isActivePerson(viewer)) return false;
  switch (section) {
    case "people":
    case "who-can":
      return true;
    case "departments":
      return can(viewer, "departments.manage");
    case "roles":
      return can(viewer, "roles.manage");
    case "changelog":
      return readsSomeChanges(viewer);
  }
}

/** Le voci visibili, nell'ordine della colonna, coi loro gruppi. */
export function adminSections(viewer: Viewer): (typeof ADMIN_SECTIONS)[number][] {
  return ADMIN_SECTIONS.filter((s) => sees(viewer, s.id));
}

export const canSeeAdminSection = (viewer: Viewer, section: AdminSection): boolean =>
  sees(viewer, section);

/** Vero se chi guarda vede almeno una voce: la voce del profilo c'è solo così. */
export function canSeeAdmin(viewer: Viewer): boolean {
  return adminSections(viewer).length > 0;
}

/**
 * Se chi guarda amministra qualcosa [PE 1]: una voce di gestione
 * (Departments, Roles, Change log) o le azioni di People (`users.manage`,
 * `users.invite`). Allora la voce del profilo si chiama «Administration»;
 * altrimenti «People», e apre le stesse voci in sola lettura.
 */
export function administersSomething(viewer: Viewer): boolean {
  if (!isActivePerson(viewer)) return false;
  return (
    sees(viewer, "departments") ||
    sees(viewer, "roles") ||
    sees(viewer, "changelog") ||
    can(viewer, "users.manage") ||
    can(viewer, "users.invite")
  );
}

/**
 * Le sezioni di Progetto → Settings che chi guarda vede (area 9a): tutte,
 * tranne Change log, che è solo di chi gestisce le impostazioni o i membri
 * del progetto (design «Il registro delle modifiche»). La colonna e la rotta
 * leggono da qui.
 */
export function canSeeProjectSettingsSection(
  viewer: Viewer,
  projectId: string,
  section: ProjectSettingsSection,
): boolean {
  if (section !== "changelog") return true;
  return MANAGE_PROJECT.some((p) => can(viewer, p, projectId));
}
