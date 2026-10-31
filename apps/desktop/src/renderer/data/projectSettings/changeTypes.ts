import { registerChangeTypes, type ChangeType } from "../changelog/index";
import type { ProjectSettingsSection } from "../routes";

// I tipi di voce del registro dell'area 9c, TUTTI qui (Task 1): i Task 2–5
// scrivono solo tipi già registrati. Si importa PER EFFETTO da ogni modulo
// che scrive una di queste voci (`index.ts`, i writer di progetto del Task
// 3) e da `adminSections.ts`, così il filtro «Type» del registro li conosce
// prima della prima scrittura: `recordChange` lancia su un tipo non
// registrato (ruling del controller (pre-flight), P5). La frase sta in
// `changelog.kinds.<kind>`, il gruppo in `changelog.groups.<group>` (il
// test di `Audit.test.tsx` controlla le due lingue).
//
// Il `readPermission` è sempre un permesso di GESTIONE: Claude non ne ha
// nessuno, quindi non legge nessuna di queste voci (test in
// `projectSettings.test.ts`).
// - `project`: le impostazioni del progetto (`project.settings.manage`);
// - `repositories`: repository, file d'ambiente e webhook git
//   (`repos.manage`), ambienti (`environments.manage`) e widget
//   (`widget.manage`). Il nome di una variabile d'ambiente entra nella voce
//   (`params.key`: non è un segreto); il valore mai;
// - `projects`: d'ISTANZA, solo del full admin: un progetto eliminato e un
//   repository senza progetto eliminato. Il nome del progetto da cui
//   vengono si risolve a lettura (Task 5, R-G5).

const project =
  (group: string, readPermission: string) =>
  (kind: string): ChangeType => ({
    kind,
    templateKey: `changelog.kinds.${kind}`,
    readPermission,
    scope: "project",
    group,
  });
const projects = (kind: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission: "instance.full_admin",
  scope: "instance",
  group: "projects",
});

const settings = project("project", "project.settings.manage");
const repos = project("repositories", "repos.manage");
const environments = project("repositories", "environments.manage");
const widget = project("repositories", "widget.manage");

export const PROJECT_CHANGE_TYPES: readonly ChangeType[] = [
  settings("project.renamed"),
  settings("project.description_changed"),
  settings("project.ai_account_changed"),
  settings("project.switch_changed"),
  settings("project.pulse_interval_changed"),
  settings("project.correction_cap_changed"),
  settings("project.statuses_changed"),
  settings("project.stall_thresholds_changed"),
  settings("project.plugins_changed"),
  settings("project.ingestion_key_regenerated"),
  settings("project.archived"),
  settings("project.reopened"),
  repos("repository.created"),
  repos("repository.updated"),
  repos("repository.pr_mode_changed"),
  repos("repository.release_pipeline_changed"),
  repos("repository.webhook_configured"),
  repos("repository.webhook_secret_regenerated"),
  repos("env_file.created"),
  repos("env_file.deleted"),
  repos("env_file.imported"),
  repos("env_var.set"),
  repos("env_var.removed"),
  // Nel progetto di DESTINAZIONE; non nomina il progetto eliminato da cui viene (R-G5).
  repos("repository.linked"),
  environments("environment.created"),
  environments("environment.updated"),
  environments("environment.deleted"),
  widget("widget.created"),
  widget("widget.updated"),
  widget("widget.deleted"),
  projects("project.deleted"),
  // Confermata dal maintainer il 31 ott 2026 (domanda 4 (b)).
  projects("repository.deleted"),
];

/**
 * I parametri che le scritture dei Task 2–5 DEVONO mettere in `params` per
 * questi tipi (le frasi li leggono). Valori stabili, mai parole tradotte:
 * - `project.switch_changed`: `switch`, l'interruttore (`weeklyBrief`);
 * - `repository.updated`: `field`, la chiave del campo (`installCommand`);
 * - `env_file.imported`: `count`, quante variabili, come numero in stringa;
 * - `env_var.set`, `env_var.removed`: `key`, il nome della variabile;
 * - `project.deleted`: `detachedRepositories`, quanti repository restano
 *   senza progetto, come numero in stringa.
 * I prima/dopo seguono `changelog/settingValues.ts` (`SETTING_KINDS`).
 */
export interface ProjectChangeParams {
  "project.switch_changed": { switch: string };
  "repository.updated": { field: string };
  "env_file.imported": { count: string };
  "env_var.set": { key: string };
  "env_var.removed": { key: string };
  "project.deleted": { detachedRepositories: string };
}

/**
 * La sezione di Progetto → Settings in cui sta l'oggetto di una voce di
 * progetto del 9c: il link della voce la apre (`changelog/reads.ts`).
 * Ambienti e widget non stanno nelle impostazioni (sono di Releases e
 * Support): niente link da qui.
 */
export const SECTION_OF_KIND: Readonly<Record<string, ProjectSettingsSection>> = {
  "project.renamed": "general",
  "project.description_changed": "general",
  "project.ai_account_changed": "ai",
  "project.switch_changed": "automations",
  "project.pulse_interval_changed": "automations",
  "project.correction_cap_changed": "automations",
  "project.statuses_changed": "statuses",
  "project.stall_thresholds_changed": "statuses",
  "project.plugins_changed": "plugins",
  "project.ingestion_key_regenerated": "integration",
  "project.archived": "archive",
  "project.reopened": "archive",
  "repository.created": "repositories",
  "repository.updated": "repositories",
  "repository.pr_mode_changed": "repositories",
  "repository.release_pipeline_changed": "repositories",
  "repository.webhook_configured": "repositories",
  "repository.webhook_secret_regenerated": "integration",
  "env_file.created": "repositories",
  "env_file.deleted": "repositories",
  "env_file.imported": "repositories",
  "env_var.set": "repositories",
  "env_var.removed": "repositories",
  "repository.linked": "repositories",
};

registerChangeTypes(PROJECT_CHANGE_TYPES);
