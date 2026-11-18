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
const project = (kind: string): ChangeLogType => ({ kind, scope: "project", group: "members", readPermission: "project.members.manage" });

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
};

/**
 * Una voce come la legge il client (G-4 = a): `type` e `data`, l'attore col
 * nome di allora, il codice del progetto e `objectDeleted`. Nessuna prosa:
 * la frase, il link e il prima/dopo da leggere li compone il client. Le
 * persone che chi guarda non vede sono già tolte dal server.
 */
export const changeEntrySchema = z.object({
  id: z.uuid(),
  type: z.enum(CHANGE_LOG_KINDS),
  at: z.iso.datetime(),
  actor: z.object({
    id: z.uuid().nullable().default(null),
    name: z.string(),
    kind: z.enum(["user", "agent", "system"]),
  }),
  projectId: z.uuid().nullable().default(null),
  projectCode: z.string().nullable().default(null),
  scope: z.enum(["instance", "project"]),
  group: z.string(),
  data: changeDataSchema,
  objectDeleted: z.boolean().default(false),
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
});
export type ChangeLogFilters = z.infer<typeof changeLogFiltersSchema>;
