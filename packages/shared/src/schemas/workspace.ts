import { z } from "zod";
import { departmentColorTokenSchema } from "./task-view.js";

/**
 * Workspace (0238, `docs/plans/2026-11-27-workspace-design.md`): raggruppamenti
 * di PROGETTI per VISIBILITÀ. Le viste le calcola il server per chi guarda
 * (r.1414): i progetti sono SOLO quelli che vede, le persone solo quelle che
 * conosce; i permessi d'azione (`can*`) li decide il server, il client li legge.
 */

export const workspacePersonSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  /** Lotto 5 (additivi): per la scheda People della workspace. */
  email: z.string().default(""),
  status: z.enum(["active", "deactivated"]).default("active"),
});
export type WorkspacePerson = z.infer<typeof workspacePersonSchema>;

export const workspaceViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  colorToken: departmentColorTokenSchema,
  /** I progetti della workspace che chi guarda vede (mai gli altri, nemmeno nel numero). */
  projectIds: z.array(z.uuid()).default([]),
  /** Le persone della workspace che chi guarda conosce, col ruolo di workspace. */
  people: z.array(workspacePersonSchema).default([]),
  /** Chi guarda ne fa parte. */
  isMember: z.boolean().default(false),
  /** Rinominare, eliminare, mettere progetti (con `project.members.manage` nel progetto): `workspaces.manage`. */
  canManage: z.boolean().default(false),
  /** Invitare e togliere persone: `workspaces.manage` E `project.members.manage` in OGNI suo progetto (D4). */
  canManagePeople: z.boolean().default(false),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const workspaceListSchema = z.object({
  items: z.array(workspaceViewSchema),
  /**
   * I3 (revisione d'insieme, additivo): chi guarda può CREARE workspace
   * (`workspaces.manage` o full admin). Sta sull'elenco e non su una riga,
   * così vale anche con l'elenco vuoto; quello di ogni workspace resta
   * `items[].canManage`. Un server di prima non lo manda: `false`.
   */
  canManage: z.boolean().default(false),
});

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  colorToken: departmentColorTokenSchema.optional(),
  projectIds: z.array(z.uuid()).max(200).optional(),
});

export const workspaceUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80).optional(), colorToken: departmentColorTokenSchema.optional() })
  .refine((b) => b.name !== undefined || b.colorToken !== undefined, { message: "nothing to change" });

/** Ciò che chi agisce non può dare, progetto per progetto (403 `escalation`). */
export const workspaceEscalationSchema = z.object({
  /** Il progetto, SOLO se chi agisce lo vede (r.1414); altrimenti null. */
  projectId: z.uuid().nullable(),
  permission: z.string(),
});

/**
 * L'anteprima di un ingresso o di un cambio di ruolo (`POST /:id/members/preview`):
 * cosa la persona guadagna in ogni progetto della workspace, e cosa chi agisce non
 * può dare. Calcolata con la regola della scrittura.
 */
export const workspaceMemberPreviewSchema = z.object({
  projects: z.array(z.object({ projectId: z.uuid(), gains: z.array(z.string()) })).default([]),
  escalation: z.array(workspaceEscalationSchema).default([]),
  lastManager: z.object({ blocked: z.boolean(), projectId: z.uuid().nullable() }).default({ blocked: false, projectId: null }),
  block: z.enum(["system_user", "user_deactivated", "role_required"]).nullable().default(null),
});
export type WorkspaceMemberPreview = z.infer<typeof workspaceMemberPreviewSchema>;

/** Le operazioni di cui `POST /api/workspaces/effect` (`workspaceAccessEffect`) calcola l'effetto. */
export const workspaceEffectRequestSchema = z.discriminatedUnion("kind", [
  // Lotto 5: una workspace NUOVA coi suoi progetti (chi smette di vederli spostandoli), prima di crearla.
  z.object({ kind: z.literal("create"), projectIds: z.array(z.uuid()).max(200) }),
  z.object({ kind: z.literal("addProject"), workspaceId: z.uuid(), projectId: z.uuid() }),
  z.object({ kind: z.literal("removeProject"), workspaceId: z.uuid(), projectId: z.uuid() }),
  z.object({ kind: z.literal("deleteWorkspace"), workspaceId: z.uuid() }),
  z.object({ kind: z.literal("removeMember"), workspaceId: z.uuid(), userId: z.uuid(), alsoProjects: z.boolean().optional() }),
]);
export type WorkspaceEffectRequest = z.infer<typeof workspaceEffectRequestSchema>;

/**
 * L'effetto di un cambio di struttura, calcolato FACENDO la scrittura in una
 * transazione annullata: chi comincia e chi smette di vedere ogni progetto
 * (i full admin vedono sempre: non compaiono), dove la scrittura darebbe
 * `last_manager` o `escalation`. Solo progetti che chi chiede vede.
 */
export const workspaceEffectSchema = z.object({
  projects: z
    .array(z.object({ projectId: z.uuid(), startSeeing: z.array(z.object({ userId: z.uuid(), name: z.string() })), stopSeeing: z.array(z.object({ userId: z.uuid(), name: z.string() })) }))
    .default([]),
  lastManager: z.array(z.uuid()).default([]),
  escalation: z.array(workspaceEscalationSchema).default([]),
});
export type WorkspaceEffect = z.infer<typeof workspaceEffectSchema>;

/**
 * Lotto 5: chi si può mettere in una workspace (`GET /api/workspaces/:id/candidates`):
 * le persone attive che chi gestisce vede (la regola degli `addable` dei membri
 * di progetto), fuori da chi c'è già e da Claude. `missing`: ciò che i suoi
 * reparti porterebbero dove chi agisce non l'ha (l'escalation dei reparti,
 * indipendente dal ruolo); i ruoli col giudizio su TUTTI i progetti.
 */
export const workspaceCandidatesSchema = z.object({
  candidates: z.array(z.object({ userId: z.uuid(), name: z.string(), email: z.string(), missing: z.array(z.string()).default([]) })).default([]),
  roles: z.array(z.object({ roleId: z.uuid(), name: z.string(), missing: z.array(z.string()).default([]) })).default([]),
  defaultRoleId: z.uuid().nullable().default(null),
});
export type WorkspaceCandidates = z.infer<typeof workspaceCandidatesSchema>;
