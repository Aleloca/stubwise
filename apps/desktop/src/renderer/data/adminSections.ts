import { accessState } from "./access/index";
import "./admin/changeTypes";
import "./instance/changeTypes";
// Area 9c: solo i tipi di voce, per effetto; mai `projectSettings/index.ts`,
// che porta al caveau dei segreti (P5, P6).
import "./projectSettings/changeTypes";
import { MANAGE_PROJECT, readsSomeChanges } from "./changelog/visibility";
import {
  ADMIN_SECTIONS,
  AI_TABS,
  PROJECT_SETTINGS_SECTIONS,
  type AdminSection,
  type ProjectSettingsSection,
} from "./routes";
import { visibleProjectIds } from "./store";
import type { Viewer } from "./types";
import { can, type Permission } from "./viewer";

// Le voci dell'Amministrazione che chi guarda vede (area 9a, design
// «Amministrazione: com'è fatta», shape admin-people.md §3), in UN posto:
// la colonna, la voce del profilo, `/admin` e le rotte delle voci leggono da
// qui. Sta fuori da `viewer.ts` perché la regola del Change log è quella del
// registro (`readsSomeChanges`), che a sua volta legge `viewer.ts`.
//
// - People e Who can?: ogni persona attiva (Claude e «nessuno» no).
// - Departments: `departments.manage`. Roles: `roles.manage`.
// - Change log: `changelog.view`, oppure le voci di ciò che si gestisce.
//
// Le voci dell'istanza (area 9b, tabella delle Global Constraints): chi vede
// una voce senza il permesso di scrittura la legge in sola lettura.
// - AI: `ai_providers.manage` o `settings.manage` (Providers, Models,
//   Automation, Budget & language), `usage.view` (la sola Usage).
// - Git accounts: `git_accounts.view` o `.manage`. Plugins:
//   `plugins.manage`. Google Workspace: `integrations.manage`. Storage e
//   Outgoing webhooks: `settings.manage`.
// - Servers: `monitor.manage`. Repositories: `repos.manage` in almeno un
//   progetto. Instance status: `instance.status.view` o `settings.manage`.

/**
 * Una persona umana e attiva: chi ha una sessione nell'app. Claude e
 * «nessuno» non stanno fra le persone degli accessi (R-L9), quindi non passano.
 */
const isActivePerson = (viewer: Viewer): boolean =>
  accessState().people.some((p) => p.personId === viewer.personId && p.status === "active");

/** I permessi d'istanza del 9b che scrivono (vedi `administersSomething`). */
const INSTANCE_WRITES = [
  "ai_providers.manage",
  "settings.manage",
  "git_accounts.manage",
  "plugins.manage",
  "integrations.manage",
  "monitor.manage",
] as const;

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
    case "ai":
      return aiTabsFor(viewer).length > 0;
    case "git-accounts":
      return can(viewer, "git_accounts.view") || can(viewer, "git_accounts.manage");
    case "plugins":
      return can(viewer, "plugins.manage");
    case "google":
      return can(viewer, "integrations.manage");
    case "storage":
    case "webhooks":
      return can(viewer, "settings.manage");
    case "servers":
      return can(viewer, "monitor.manage");
    case "repositories":
      // Senza progetto: in almeno uno.
      return can(viewer, "repos.manage");
    case "status":
      return can(viewer, "instance.status.view") || can(viewer, "settings.manage");
  }
}

/**
 * Le schede della voce AI che chi guarda vede, nell'ordine della barra:
 * Usage con `usage.view`, le altre con `ai_providers.manage` o
 * `settings.manage`. Nessuna scheda = nessuna voce AI.
 */
export function aiTabsFor(viewer: Viewer): (typeof AI_TABS)[number][] {
  if (!isActivePerson(viewer)) return [];
  const settings = can(viewer, "ai_providers.manage") || can(viewer, "settings.manage");
  const usage = can(viewer, "usage.view");
  return AI_TABS.filter((tab) => (tab === "usage" ? usage : settings));
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
 * (Departments, Roles, Change log), le azioni di People (`users.manage`,
 * `users.invite`) o un permesso di scrittura d'istanza del 9b. Allora la
 * voce del profilo si chiama «Administration»; altrimenti «People», e apre
 * le stesse voci in sola lettura.
 *
 * Del 9b contano solo i permessi che scrivono: `git_accounts.view` (che il
 * preset User dà a tutti), `usage.view`, `instance.status.view` e
 * `repos.manage` (Repositories rimanda a Progetto → Settings) aprono voci in
 * sola lettura, e contarli chiamerebbe «Administration» la voce del profilo
 * di ogni utente.
 *
 * Il registro conta per `changelog.view` o per chi gestisce un progetto, non
 * per ogni voce che si legge: dal 9c chi ha `repos.manage`,
 * `environments.manage` o `widget.manage` legge le voci dei repository dei
 * suoi progetti (e vede «Change log»), ma per la regola qui sopra non
 * amministra. Le voci d'istanza si leggono con un permesso che conta già da
 * sé (`users.manage`, `roles.manage`, quelli di `INSTANCE_WRITES`…).
 */
export function administersSomething(viewer: Viewer): boolean {
  if (!isActivePerson(viewer)) return false;
  return (
    sees(viewer, "departments") ||
    sees(viewer, "roles") ||
    can(viewer, "changelog.view") ||
    MANAGE_PROJECT.some((p) => can(viewer, p)) ||
    can(viewer, "users.manage") ||
    can(viewer, "users.invite") ||
    INSTANCE_WRITES.some((p) => can(viewer, p))
  );
}

/** Cosa chi guarda può fare in una sezione di Progetto → Settings. */
export interface SectionAccess {
  visible: boolean;
  /**
   * Può scrivere. Una sezione senza niente da scrivere (Usage, Change log)
   * vale quanto `visible`: non è mai «in sola lettura».
   */
  canEdit: boolean;
  /** azione di ACTIONS per il «Who?», null se nessuna */
  editAction: string | null;
}

/**
 * Chi vede e chi scrive le sezioni di Progetto → Settings (area 9c, tabella
 * delle Global Constraints del piano), in UN posto: la colonna, la rotta e le
 * pagine leggono da qui, mai `can()` (lezione del 9b).
 *
 * | Sezione | Si vede con | Si scrive con | «Who?» |
 * |---|---|---|---|
 * | General, Statuses, AI, Automations, Plugins | membro | `project.settings.manage` | `manageProjectSettings` |
 * | Members | membro | `project.members.manage` | `manageMembers` |
 * | Repositories | `repos.view` | `repos.manage` | `manageRepos` |
 * | Integration | membro | `project.settings.manage` o `repos.manage` [PS 4] | `manageProjectSettings` |
 * | Usage | `project.usage.view` | — | — |
 * | Change log | `project.settings.manage` o `project.members.manage` (9a) | — | — |
 * | Archive | membro | `project.settings.manage` (Delete: full admin, sul bottone) | `manageProjectSettings` |
 *
 * «Membro» è un progetto che chi guarda vede (`visibleProjectIds`: i full
 * admin vedono tutto); un progetto invisibile o archiviato non ha nessuna
 * sezione. Integration ha due permessi: la sezione è scrivibile con uno dei
 * due, e i bottoni leggono poi `canRegenerateKey` e
 * `gitWebhooks[].canRegenerate` (Task 4).
 */
export function projectSettingsAccess(
  viewer: Viewer,
  projectId: string,
): Record<ProjectSettingsSection, SectionAccess> {
  const member = visibleProjectIds(viewer.personId).has(projectId);
  const has = (perm: Permission) => member && can(viewer, perm, projectId);
  const settings = has("project.settings.manage");
  const writable = (visible: boolean, canEdit: boolean, editAction: string): SectionAccess => ({
    visible,
    canEdit: visible && canEdit,
    editAction,
  });
  /** Una sezione da leggere soltanto: niente «Who?», mai «in sola lettura». */
  const readOnly = (visible: boolean): SectionAccess => ({
    visible,
    canEdit: visible,
    editAction: null,
  });
  const bySection: Record<ProjectSettingsSection, SectionAccess> = {
    general: writable(member, settings, "manageProjectSettings"),
    statuses: writable(member, settings, "manageProjectSettings"),
    members: writable(member, has("project.members.manage"), "manageMembers"),
    ai: writable(member, settings, "manageProjectSettings"),
    automations: writable(member, settings, "manageProjectSettings"),
    repositories: writable(has("repos.view"), has("repos.manage"), "manageRepos"),
    integration: writable(member, settings || has("repos.manage"), "manageProjectSettings"),
    plugins: writable(member, settings, "manageProjectSettings"),
    usage: readOnly(has("project.usage.view")),
    changelog: readOnly(MANAGE_PROJECT.some((p) => has(p))),
    archive: writable(member, settings, "manageProjectSettings"),
  };
  // Nell'ordine della colonna.
  return Object.fromEntries(
    PROJECT_SETTINGS_SECTIONS.map((s) => [s.id, bySection[s.id]]),
  ) as Record<ProjectSettingsSection, SectionAccess>;
}

/** Se chi guarda vede una sezione di Progetto → Settings: involucro di `projectSettingsAccess`. */
export function canSeeProjectSettingsSection(
  viewer: Viewer,
  projectId: string,
  section: ProjectSettingsSection,
): boolean {
  return projectSettingsAccess(viewer, projectId)[section].visible;
}
