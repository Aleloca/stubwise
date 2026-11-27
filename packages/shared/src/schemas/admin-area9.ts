import { z } from "zod";

/**
 * Area 9, F1 (aggiunta per R7 e R8 del renderer): le letture CALCOLATE
 * dell'amministrazione — persone, ruoli, inviti, membri — coi campi che il
 * client legge senza dedurli (permissions.md, «Il client legge i permessi
 * calcolati dal server»). Le forme sono quelle del prototipo
 * (`apps/desktop/src/renderer/data/admin/types.ts`), con `avatarUrl` al posto
 * di `avatar`. Ogni campo che un server più vecchio non manderebbe ha un
 * default; gli enum li apre `readerSchema`.
 */

/** `null` = si può; altrimenti il motivo (`self`, `status`, `forbidden`, `last_full_admin`…). */
export const actionBlockSchema = z.string().nullable();

/** Un ruolo da scegliere, con ciò che a chi guarda manca per darlo (vuoto = si può). */
export const roleChoiceSchema = z.object({
  roleId: z.uuid(),
  name: z.string(),
  permissionCount: z.number().int().nonnegative(),
  missing: z.array(z.string()).default([]),
  /**
   * Un motivo per cui QUESTA scelta non si può fare anche senza escalation
   * (review: `last_full_admin` sulla scelta che toglierebbe l'amministrazione
   * all'ultimo full admin), o null.
   */
  block: z.string().nullable().default(null),
});
export type RoleChoice = z.infer<typeof roleChoiceSchema>;

/** Una fonte di un permesso, coi nomi già risolti. Piatta: i campi che non c'entrano sono null. */
export const sourceViewSchema = z.object({
  kind: z.enum(["role", "grant", "department", "full_admin", "workspace"]),
  roleId: z.uuid().nullable().default(null),
  roleName: z.string().nullable().default(null),
  grantedById: z.uuid().nullable().default(null),
  grantedByName: z.string().nullable().default(null),
  at: z.iso.datetime().nullable().default(null),
  /** Solo `grant`: `given` (salvata) o `draft` (nella bozza del pannello). */
  origin: z.enum(["given", "seed", "draft"]).nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
  departmentName: z.string().nullable().default(null),
  /** Workspace (lotto 4, additivi): la workspace di una fonte `workspace` (il suo ruolo in `roleId`/`roleName`). */
  workspaceId: z.uuid().nullable().default(null),
  workspaceName: z.string().nullable().default(null),
});
export type SourceView = z.infer<typeof sourceViewSchema>;

/** Un permesso in più del ruolo (concessione o reparto), con le sue fonti. */
export const extraPermissionSchema = z.object({
  permission: z.string(),
  sources: z.array(sourceViewSchema).default([]),
  granted: z.boolean().default(false),
});
export type ExtraPermission = z.infer<typeof extraPermissionSchema>;

const departmentRefSchema = z.object({ id: z.uuid(), name: z.string(), colorToken: z.string() });

/** Una riga di People: una persona, o un invito pendente (`status: "invited"`). */
export const personRowSchema = z.object({
  personId: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().default(null),
  instanceRole: z.object({ id: z.uuid(), name: z.string() }).nullable().default(null),
  departments: z.array(departmentRefSchema).default([]),
  /** Solo i progetti che chi guarda vede. */
  projects: z.array(z.object({ code: z.string(), role: z.string() })).default([]),
  status: z.enum(["active", "invited", "deactivated"]),
  deactivatedAt: z.iso.datetime().nullable().default(null),
  invite: z
    .object({ id: z.string(), expiresAt: z.iso.datetime(), expired: z.boolean(), invitedByName: z.string().nullable().default(null) })
    .nullable()
    .default(null),
});
export type PersonRow = z.infer<typeof personRowSchema>;

export const personProjectViewSchema = z.object({
  projectId: z.uuid(),
  code: z.string(),
  name: z.string(),
  role: z.object({ id: z.uuid(), name: z.string() }),
  extra: z.array(extraPermissionSchema).default([]),
  canManage: z.boolean().default(false),
  /** Workspace (lotto 4, additivi): il progetto visto anche (o solo) da una workspace, col ruolo di workspace. */
  workspace: z.object({ name: z.string(), roleName: z.string() }).nullable().default(null),
  /** Lo vede SOLO dalla workspace (allora `role` è il ruolo di workspace). */
  workspaceOnly: z.boolean().default(false),
});

/** La pagina di una persona. */
export const personDetailSchema = z.object({
  personId: z.uuid(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().default(null),
  status: z.enum(["active", "deactivated"]),
  deactivatedAt: z.iso.datetime().nullable().default(null),
  isSelf: z.boolean(),
  isFullAdmin: z.boolean(),
  /** Solo a chi gestisce le persone o alla persona stessa (review, I1); null agli altri. */
  hasSecondFactor: z.boolean().nullable().default(null),
  peer: z.boolean().default(false),
  instanceRole: z.object({ id: z.uuid(), name: z.string() }).nullable().default(null),
  projects: z.array(personProjectViewSchema).default([]),
  alsoInHiddenProjects: z.boolean().default(false),
  addableTo: z.array(z.object({ projectId: z.uuid(), code: z.string(), name: z.string() })).default([]),
  departments: z.array(departmentRefSchema.extend({ managesHome: z.boolean().default(false) })).default([]),
  /** Workspace (lotto 4, additivo): le sue workspace che chi guarda vede, col ruolo. */
  workspaces: z.array(z.object({ id: z.uuid(), name: z.string(), roleName: z.string() })).default([]),
  identities: z
    .object({ gitEmails: z.array(z.string()).default([]), bitbucketUsername: z.string().nullable().default(null) })
    .default({ gitEmails: [], bitbucketUsername: null }),
  actions: z.object({
    setInstanceRole: actionBlockSchema,
    resetPassword: actionBlockSchema,
    changeEmail: actionBlockSchema.default("forbidden"),
    resetSecondFactor: actionBlockSchema,
    deactivate: actionBlockSchema,
    reactivate: actionBlockSchema,
    identities: actionBlockSchema,
  }),
  instanceRoleChoices: z.array(roleChoiceSchema).default([]),
  openTasks: z
    .array(z.object({ taskId: z.uuid(), code: z.string(), title: z.string(), projectId: z.uuid(), reassignTo: z.array(z.uuid()).default([]) }))
    .default([]),
});
export type PersonDetail = z.infer<typeof personDetailSchema>;

/** Un ruolo nell'amministrazione, coi campi calcolati su chi guarda. */
export const adminRoleViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scope: z.enum(["instance", "project"]),
  permissions: z.array(z.string()),
  presetKey: z.string().nullable().default(null),
  peopleCount: z.number().int().nonnegative().default(0),
  holders: z.array(z.object({ personId: z.uuid(), projectId: z.uuid().nullable() })).default([]),
  missing: z.array(z.string()).default([]),
  reach: z.enum(["instance", "projects", "anywhere"]),
  notGivable: z.array(z.string()).default([]),
  copyMissing: z.array(z.string()).default([]),
  affectedCount: z.number().int().nonnegative().default(0),
  fullAdminImplies: z.array(z.string()).default([]),
  deleteBlock: z.enum(["preset", "in_use"]).nullable().default(null),
  givesActivityView: z.boolean().default(false),
});
export type AdminRoleView = z.infer<typeof adminRoleViewSchema>;

/** Un invito pendente come lo legge chi invita. `id` è il token (gli inviti non hanno un altro id). */
export const inviteViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  instanceRole: z.object({ id: z.uuid(), name: z.string() }).nullable().default(null),
  projects: z.array(z.object({ projectId: z.uuid(), code: z.string(), roleId: z.uuid(), roleName: z.string() })).default([]),
  /** Workspace (D9, additivo): le workspace che l'invito promette e che chi guarda vede, col ruolo. */
  workspaces: z.array(z.object({ workspaceId: z.uuid(), name: z.string(), roleId: z.uuid(), roleName: z.string() })).default([]),
  invitedById: z.uuid().nullable().default(null),
  invitedByName: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
});
export type InviteView = z.infer<typeof inviteViewSchema>;

/** Le scelte del dialogo «Invite someone», con ciò che manca a chi invita. */
export const inviteChoicesSchema = z.object({
  instanceRoles: z.array(roleChoiceSchema).default([]),
  defaultInstanceRoleId: z.uuid().nullable().default(null),
  projects: z.array(z.object({ projectId: z.uuid(), code: z.string(), name: z.string(), roles: z.array(roleChoiceSchema).default([]) })).default([]),
  /** Workspace (lotto 4, additivo): dove chi invita gestisce le persone, coi ruoli (escalation su tutti i progetti). */
  workspaces: z.array(z.object({ workspaceId: z.uuid(), name: z.string(), roles: z.array(roleChoiceSchema).default([]), defaultRoleId: z.uuid().nullable().default(null) })).default([]),
});
export type InviteChoices = z.infer<typeof inviteChoicesSchema>;

/** Un membro esplicito di un progetto nella vista di gestione. */
export const memberRowViewSchema = z.object({
  personId: z.uuid(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().default(null),
  status: z.enum(["active", "deactivated"]),
  role: z.object({ id: z.uuid(), name: z.string(), permissions: z.array(z.string()).default([]) }),
  extra: z.array(extraPermissionSchema).default([]),
  /** I permessi dati a mano, anche quelli che il ruolo dà già. */
  granted: z.array(z.string()).default([]),
  /** Workspace (lotto 4, additivi): la workspace da cui vede il progetto, col ruolo di workspace. */
  workspace: z.object({ workspaceId: z.uuid(), workspaceName: z.string(), roleName: z.string() }).nullable().default(null),
  /** Membro ESPLICITO (false: lo vede solo dalla workspace, e `role` è il ruolo di workspace). */
  explicit: z.boolean().default(true),
});

export const projectMembersViewSchema = z.object({
  projectId: z.uuid(),
  members: z.array(memberRowViewSchema),
  fullAdminNote: z.literal(true).default(true),
  canManage: z.boolean(),
  roleChoices: z.array(roleChoiceSchema).default([]),
  grantable: z.array(z.object({ permission: z.string(), allowed: z.boolean() })).default([]),
  addable: z.array(z.uuid()).default([]),
  addableMissing: z.record(z.string(), z.array(z.string())).default({}),
});
export type ProjectMembersView = z.infer<typeof projectMembersViewSchema>;

/** La bozza del pannello del membro: il ruolo e i permessi dati a mano. */
export const memberDraftSchema = z.object({ roleId: z.uuid(), granted: z.array(z.string().min(1).max(80)).max(64).default([]) });

/** Il giudizio di una bozza, lo stesso che il salvataggio applica. */
export const memberPreviewSchema = z.object({
  permissions: z.array(z.object({ permission: z.string(), sources: z.array(sourceViewSchema).default([]) })).default([]),
  removing: z.array(z.object({ permission: z.string(), source: sourceViewSchema })).default([]),
  roleChoices: z.array(roleChoiceSchema).default([]),
  missing: z.array(z.string()).default([]),
  block: actionBlockSchema.default(null),
  removeBlock: actionBlockSchema.default(null),
  viewerLoses: z.array(z.string()).default([]),
});
export type MemberPreview = z.infer<typeof memberPreviewSchema>;
