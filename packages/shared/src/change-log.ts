import { z } from "zod";

/**
 * Area 9, F2 (D-3, D-4; docs/invariants/change-log.md): il catalogo del
 * registro delle modifiche. Un tipo è DICHIARATO qui, con il suo `data`, e
 * ha il suo template nei client (`changelog.kinds.<kind>`): un tipo nuovo è
 * un'aggiunta in questi posti, e i test di parità li tengono allineati.
 *
 * I nomi e la forma sono quelli del prototipo
 * (`apps/desktop/src/renderer/data/admin/changeTypes.ts`, G-1 = a), più
 * `person.email_changed` (il cambio d'email nato in F1).
 */

export interface ChangeLogType {
  kind: string;
  scope: "instance" | "project";
  /** Il gruppo del filtro «Type» (`changelog.groups.<group>`). */
  group: string;
  /**
   * Chi legge la voce oltre a chi ha `changelog.view` (G-3 = a): chi gestisce
   * l'oggetto. Per una voce di progetto vale in quel progetto, dove la legge
   * anche chi gestisce il progetto.
   */
  readPermission: string;
}

const instance = (kind: string, readPermission: string, group: string): ChangeLogType => ({ kind, scope: "instance", group, readPermission });
const project = (kind: string, group = "members", readPermission = "project.members.manage"): ChangeLogType => ({ kind, scope: "project", group, readPermission });
// Area 9, F4: la coda di un progetto (J-1 = a: la gestisce chi gestisce il progetto).
const queue = (kind: string): ChangeLogType => project(kind, "queue", "project.settings.manage");
// Area 9, F5: le impostazioni del progetto (la 9c del prototipo, `projectSettings/changeTypes.ts`).
const settings9c = (kind: string): ChangeLogType => project(kind, "project", "project.settings.manage");
const repos9c = (kind: string): ChangeLogType => project(kind, "repositories", "repos.manage");
const environments9c = (kind: string): ChangeLogType => project(kind, "repositories", "environments.manage");
const widget9c = (kind: string): ChangeLogType => project(kind, "repositories", "widget.manage");

export const CHANGE_LOG_TYPES = [
  instance("person.instance_role_changed", "users.manage", "people"),
  instance("person.password_reset_link_created", "users.manage", "security"),
  instance("person.second_factor_reset", "users.manage", "security"),
  instance("person.git_identity_linked", "users.manage", "people"),
  instance("person.git_identity_unlinked", "users.manage", "people"),
  instance("person.bitbucket_username_set", "users.manage", "people"),
  instance("person.deactivated", "users.manage", "people"),
  instance("person.reactivated", "users.manage", "people"),
  instance("person.email_changed", "users.manage", "security"),
  instance("invite.created", "users.invite", "invites"),
  instance("invite.revoked", "users.invite", "invites"),
  instance("invite.accepted", "users.invite", "invites"),
  instance("instance.first_admin_created", "users.manage", "people"),
  instance("role.created", "roles.manage", "roles"),
  instance("role.updated", "roles.manage", "roles"),
  instance("role.deleted", "roles.manage", "roles"),
  instance("department.created", "departments.manage", "departments"),
  instance("department.updated", "departments.manage", "departments"),
  instance("department.members_changed", "departments.manage", "departments"),
  instance("department.home_managers_changed", "departments.manage", "departments"),
  // F8: il tipo è dichiarato ora, lo scrittore arriva con i permessi dei reparti.
  instance("department.permissions_changed", "departments.manage", "departments"),
  instance("department.deleted", "departments.manage", "departments"),
  // Workspace (0239, lotto 3): la struttura e le persone d'istanza, i progetti
  // anche nel registro del progetto toccato (uno spostamento ne scrive due).
  instance("workspace.created", "workspaces.manage", "workspaces"),
  instance("workspace.updated", "workspaces.manage", "workspaces"),
  instance("workspace.deleted", "workspaces.manage", "workspaces"),
  instance("workspace.member_added", "workspaces.manage", "workspaces"),
  instance("workspace.member_role_changed", "workspaces.manage", "workspaces"),
  instance("workspace.member_removed", "workspaces.manage", "workspaces"),
  project("workspace.project_added"),
  project("workspace.project_removed"),
  project("member.added"),
  project("member.removed"),
  project("member.role_changed"),
  project("member.permission_granted"),
  project("member.permission_revoked"),
  // Area 9, F3: la 9b del prototipo (`instance/changeTypes.ts`).
  instance("provider.created", "ai_providers.manage", "ai"),
  instance("provider.updated", "ai_providers.manage", "ai"),
  instance("provider.reordered", "ai_providers.manage", "ai"),
  instance("provider.credential_replaced", "ai_providers.manage", "ai"),
  instance("provider.deleted", "ai_providers.manage", "ai"),
  instance("model.changed", "settings.manage", "ai"),
  instance("automation.changed", "settings.manage", "ai"),
  instance("budget.changed", "settings.manage", "ai"),
  instance("content_language.changed", "settings.manage", "ai"),
  instance("server_analysis.changed", "settings.manage", "ai"),
  instance("git_account.created", "git_accounts.manage", "integrations"),
  instance("git_account.updated", "git_accounts.manage", "integrations"),
  instance("git_account.token_replaced", "git_accounts.manage", "integrations"),
  instance("git_account.deleted", "git_accounts.manage", "integrations"),
  instance("git_account.default_reviewer_changed", "git_accounts.manage", "integrations"),
  instance("plugin.registered", "plugins.manage", "integrations"),
  instance("plugin.ref_updated", "plugins.manage", "integrations"),
  instance("plugin.smoke_rerun", "plugins.manage", "integrations"),
  instance("plugin.removed", "plugins.manage", "integrations"),
  instance("google_app.created", "integrations.manage", "integrations"),
  instance("google_app.updated", "integrations.manage", "integrations"),
  instance("google_app.secret_replaced", "integrations.manage", "integrations"),
  instance("google_app.deleted", "integrations.manage", "integrations"),
  instance("storage.changed", "settings.manage", "integrations"),
  instance("storage.secret_replaced", "settings.manage", "integrations"),
  // H-3 = a: una voce per azione su UN webhook (il prototipo ne aveva una sola).
  instance("webhook.created", "integrations.manage", "integrations"),
  instance("webhook.updated", "integrations.manage", "integrations"),
  instance("webhook.secret_replaced", "integrations.manage", "integrations"),
  instance("webhook.deleted", "integrations.manage", "integrations"),
  // Area 9, F4: lo Stato dell'istanza (solo la coda di Stubwise, mai un server).
  queue("queue.paused"),
  queue("queue.resumed"),
  queue("job.retried"),
  // Area 9, F5: la 9c (archivio ed eliminazione in F6, task.deleted nell'area 10a).
  settings9c("project.renamed"),
  settings9c("project.description_changed"),
  settings9c("project.docs_toggled"),
  settings9c("project.ai_account_changed"),
  settings9c("project.switch_changed"),
  settings9c("project.pulse_interval_changed"),
  settings9c("project.correction_cap_changed"),
  settings9c("project.statuses_changed"),
  settings9c("project.stall_thresholds_changed"),
  settings9c("project.plugins_changed"),
  settings9c("project.ingestion_key_regenerated"),
  // Area 9, F6 (D-8): l'archivio, di progetto (come nel prototipo).
  settings9c("project.archived"),
  settings9c("project.reopened"),
  repos9c("repository.created"),
  repos9c("repository.updated"),
  repos9c("repository.pr_mode_changed"),
  repos9c("repository.release_pipeline_changed"),
  repos9c("repository.webhook_configured"),
  repos9c("repository.webhook_secret_regenerated"),
  repos9c("env_file.created"),
  repos9c("env_file.deleted"),
  repos9c("env_file.imported"),
  repos9c("env_var.set"),
  repos9c("env_var.removed"),
  // F6: nel progetto di DESTINAZIONE; non nomina il progetto eliminato da cui viene (R-G5).
  repos9c("repository.linked"),
  environments9c("environment.created"),
  environments9c("environment.updated"),
  environments9c("environment.deleted"),
  widget9c("widget.created"),
  widget9c("widget.updated"),
  widget9c("widget.deleted"),
  // F6: d'istanza, come nel prototipo. L'etichetta si risolve a lettura
  // (`CODICE · Nome` per chi conosceva il progetto); `params.detachedRepositories`.
  instance("project.deleted", "instance.full_admin", "projects"),
  // D'istanza come nel prototipo (maintainer, 31 ott 2026, domanda 4 (b)):
  // l'eliminazione da Amministrazione di un repository SENZA progetto (F6:
  // eliminare un progetto stacca i suoi repository, 0193).
  instance("repository.deleted", "instance.full_admin", "projects"),
] as const satisfies readonly ChangeLogType[];

export type ChangeLogKind = (typeof CHANGE_LOG_TYPES)[number]["kind"];
export const CHANGE_LOG_KINDS = CHANGE_LOG_TYPES.map((t) => t.kind) as [ChangeLogKind, ...ChangeLogKind[]];

export function changeLogTypeOf(kind: string): ChangeLogType | undefined {
  return CHANGE_LOG_TYPES.find((t) => t.kind === kind);
}

/** L'oggetto di cui parla una voce; `label` è il nome di ALLORA (resta se l'oggetto sparisce). */
export const changeObjectSchema = z.object({ type: z.string().min(1), id: z.string().min(1), label: z.string() });

/**
 * I valori della frase: nomi fissati, chiavi di permesso, o liste (le persone
 * di un reparto, i permessi di un ruolo). MAI un segreto: per un segreto si
 * scrive solo «sostituito» (`{ secret: "replaced" }`).
 */
const paramValueSchema = z.union([z.string(), z.array(z.string())]);

/** Il `data` di una voce: la forma del prototipo (G-2 = a). */
export const changeDataSchema = z.object({
  object: changeObjectSchema,
  before: z.string().nullable().default(null),
  after: z.string().nullable().default(null),
  params: z.record(z.string(), paramValueSchema).default({}),
});
export type ChangeData = z.infer<typeof changeDataSchema>;

const withParams = (...keys: string[]) =>
  changeDataSchema.superRefine((data, ctx) => {
    for (const key of keys) {
      if (data.params[key] === undefined) ctx.addIssue({ code: "custom", message: `params.${key} mancante`, path: ["params", key] });
    }
  });

/**
 * Lo schema di `data` PER TIPO: la base per tutti, più i `params` che la frase
 * di quel tipo nomina. Lo scrittore lo valida prima di scrivere.
 */
export const CHANGE_DATA_SCHEMAS: Record<ChangeLogKind, z.ZodType<ChangeData>> = {
  "person.instance_role_changed": changeDataSchema,
  "person.password_reset_link_created": changeDataSchema,
  "person.second_factor_reset": changeDataSchema,
  "person.git_identity_linked": withParams("email"),
  "person.git_identity_unlinked": withParams("email"),
  "person.bitbucket_username_set": changeDataSchema,
  "person.deactivated": changeDataSchema,
  "person.reactivated": changeDataSchema,
  "person.email_changed": changeDataSchema,
  "invite.created": changeDataSchema,
  "invite.revoked": changeDataSchema,
  "invite.accepted": changeDataSchema,
  "instance.first_admin_created": changeDataSchema,
  "role.created": changeDataSchema,
  "role.updated": changeDataSchema,
  "role.deleted": changeDataSchema,
  "department.created": changeDataSchema,
  "department.updated": changeDataSchema,
  "department.members_changed": withParams("added", "removed"),
  "department.home_managers_changed": withParams("added", "removed"),
  "department.permissions_changed": changeDataSchema,
  "department.deleted": changeDataSchema,
  "workspace.created": changeDataSchema,
  "workspace.updated": changeDataSchema,
  "workspace.deleted": changeDataSchema,
  "workspace.member_added": withParams("workspaceName", "roleName"),
  "workspace.member_role_changed": withParams("workspaceName"),
  "workspace.member_removed": withParams("workspaceName", "alsoProjects"),
  "workspace.project_added": withParams("workspaceName"),
  "workspace.project_removed": withParams("workspaceName"),
  "member.added": changeDataSchema,
  "member.removed": changeDataSchema,
  "member.role_changed": changeDataSchema,
  "member.permission_granted": withParams("permission"),
  "member.permission_revoked": withParams("permission"),
  // I `params` che le frasi della 9b leggono (`InstanceChangeParams` del prototipo).
  "provider.created": withParams("kind"),
  "provider.updated": changeDataSchema,
  "provider.reordered": changeDataSchema,
  "provider.credential_replaced": changeDataSchema,
  "provider.deleted": changeDataSchema,
  "model.changed": changeDataSchema,
  "automation.changed": changeDataSchema,
  "budget.changed": changeDataSchema,
  "content_language.changed": changeDataSchema,
  "server_analysis.changed": changeDataSchema,
  "git_account.created": withParams("provider"),
  "git_account.updated": changeDataSchema,
  "git_account.token_replaced": changeDataSchema,
  "git_account.deleted": changeDataSchema,
  "git_account.default_reviewer_changed": changeDataSchema,
  "plugin.registered": withParams("ref"),
  "plugin.ref_updated": changeDataSchema,
  "plugin.smoke_rerun": changeDataSchema,
  "plugin.removed": changeDataSchema,
  "google_app.created": changeDataSchema,
  "google_app.updated": changeDataSchema,
  "google_app.secret_replaced": changeDataSchema,
  "google_app.deleted": changeDataSchema,
  "storage.changed": changeDataSchema,
  "storage.secret_replaced": changeDataSchema,
  "webhook.created": changeDataSchema,
  "webhook.updated": changeDataSchema,
  "webhook.secret_replaced": changeDataSchema,
  "webhook.deleted": changeDataSchema,
  "queue.paused": changeDataSchema,
  // Prima e dopo: `paused:<ISO>` → `running` (encodeQueue del prototipo).
  "queue.resumed": changeDataSchema,
  "job.retried": changeDataSchema,
  // Area 9, F5: i `params` che le frasi della 9c leggono (`ProjectChangeParams`
  // del prototipo). Il nome di una variabile è `variable`, mai `key` (K-3): il
  // test di sorgente sui segreti resta senza eccezioni.
  "project.renamed": changeDataSchema,
  "project.description_changed": changeDataSchema,
  "project.docs_toggled": changeDataSchema,
  "project.ai_account_changed": changeDataSchema,
  "project.switch_changed": withParams("switch"),
  "project.pulse_interval_changed": changeDataSchema,
  "project.correction_cap_changed": changeDataSchema,
  "project.statuses_changed": changeDataSchema,
  "project.stall_thresholds_changed": changeDataSchema,
  "project.plugins_changed": changeDataSchema,
  "project.ingestion_key_regenerated": changeDataSchema,
  "repository.created": changeDataSchema,
  "repository.updated": withParams("field"),
  "repository.pr_mode_changed": changeDataSchema,
  "repository.release_pipeline_changed": changeDataSchema,
  "repository.webhook_configured": changeDataSchema,
  "repository.webhook_secret_regenerated": changeDataSchema,
  "env_file.created": withParams("environment", "repository"),
  "env_file.deleted": withParams("environment", "repository"),
  "env_file.imported": withParams("environment", "repository", "count"),
  "env_var.set": withParams("environment", "repository", "variable"),
  "env_var.removed": withParams("environment", "repository", "variable"),
  "environment.created": changeDataSchema,
  "environment.updated": changeDataSchema,
  "environment.deleted": changeDataSchema,
  "widget.created": changeDataSchema,
  "widget.updated": changeDataSchema,
  "widget.deleted": changeDataSchema,
  "repository.deleted": changeDataSchema,
  "project.archived": changeDataSchema,
  "project.reopened": changeDataSchema,
  "repository.linked": changeDataSchema,
  // Quanti repository restano senza progetto, numero in stringa (il prototipo).
  "project.deleted": withParams("detachedRepositories"),
};

/**
 * Una voce come la legge il client (G-4 = a): `type` e `data`, l'attore col
 * nome di allora, il codice del progetto e `objectDeleted`. Nessuna prosa:
 * la frase, il link e il prima/dopo da leggere li compone il client. Le
 * persone che chi guarda non vede sono già tolte dal server.
 */
const changeEntryBaseSchema = z.object({
  id: z.uuid(),
  type: z.enum(CHANGE_LOG_KINDS),
  at: z.iso.datetime(),
  actor: z.object({
    /**
     * Registro, A11 r.1414: l'id, oppure `hidden-<n>` per chi chi guarda non
     * conosce (un segnaposto della risposta, mai un id da mandare indietro).
     */
    id: z.string().nullable().default(null),
    /** Null per chi chi guarda non conosce: la pagina scrive «Someone». */
    name: z.string().nullable(),
    kind: z.enum(["user", "agent", "system"]),
  }),
  projectId: z.uuid().nullable().default(null),
  projectCode: z.string().nullable().default(null),
  scope: z.enum(["instance", "project"]),
  group: z.string(),
  data: changeDataSchema,
  objectDeleted: z.boolean().default(false),
  /**
   * Area 9, F6: la voce parla di un progetto ELIMINATO che chi guarda non
   * conosceva (non ne era membro, non è full admin): «un progetto che non
   * vedi». `object.id` arriva `"hidden"` (non può essere vuoto), `object.label` vuota.
   */
  hidden: z.boolean().default(false),
  /**
   * Area 9, F6: il progetto della voce è ARCHIVIATO adesso (derivato a lettura
   * da `projects.archived_at`, mai scritto nella voce): il client la porta a
   * `/archived/<CODICE>`.
   */
  projectArchived: z.boolean().default(false),
  /**
   * Area 9, F7 (0195, M-5 = a): la voce l'ha scritta Claude per conto
   * dell'attore («By Claude»). Le voci di prima di F7 sono null.
   */
  via: z.literal("claude").nullable().default(null),
  /**
   * D4 della parità MCP (0237): l'attore l'ha fatta da Claude Code, col suo
   * PAT («via Claude Code»). Additivo: le voci di prima, e un server più
   * vecchio, danno false.
   */
  viaClaudeCode: z.boolean().default(false),
  /**
   * Area 9, F7: la voce viene da un «Annulla», e questa è la voce che annulla
   * (stessa azione di Claude, stesso oggetto) — SOLO se chi guarda la legge;
   * altrimenti null.
   */
  undoOf: z.uuid().nullable().default(null),
});

/** Una voce, con la voce che annulla (un livello solo: quella non porta la sua). */
export const changeEntrySchema = changeEntryBaseSchema.extend({
  undoneEntry: changeEntryBaseSchema.nullable().default(null),
});
export type ChangeEntry = z.infer<typeof changeEntrySchema>;

/** Una pagina del registro, con il cursore della pagina dopo (`null` = finita). */
export const changeLogPageSchema = z.object({
  entries: z.array(changeEntrySchema),
  nextCursor: z.string().nullable().default(null),
});
export type ChangeLogPage = z.infer<typeof changeLogPageSchema>;

/** Le scelte dei filtri per chi guarda (solo persone, progetti e gruppi che vede). */
export const changeLogFiltersSchema = z.object({
  everything: z.boolean().default(false),
  people: z.array(z.object({ personId: z.uuid(), name: z.string() })).default([]),
  projects: z.array(z.object({ projectId: z.uuid(), code: z.string(), name: z.string() })).default([]),
  groups: z.array(z.string()).default([]),
  /** Area 9, F7: «By Claude» fra i filtri, solo se chi guarda ne legge almeno una. */
  claude: z.boolean().default(false),
});
export type ChangeLogFilters = z.infer<typeof changeLogFiltersSchema>;
