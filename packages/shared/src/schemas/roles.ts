import { z } from "zod";
import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "../permissions.js";

/**
 * Ruoli, membri di progetto, ruolo d'istanza di un utente e progetti di un
 * invito (design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Le chiavi di permesso si validano contro il catalogo del codice, per il
 * livello del ruolo: un ruolo d'istanza con una chiave di progetto (o una
 * chiave che non esiste) è un 400, non una riga che nessuno saprebbe leggere.
 */

export const roleScopeSchema = z.enum(["instance", "project"]);

const INSTANCE_KEYS: ReadonlySet<string> = new Set(INSTANCE_PERMISSIONS);
const PROJECT_KEYS: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS);

/** Le chiavi di `permissions` che non appartengono al catalogo di `scope`. */
export function unknownPermissionsFor(
  scope: z.infer<typeof roleScopeSchema>,
  permissions: readonly string[],
): string[] {
  const known = scope === "instance" ? INSTANCE_KEYS : PROJECT_KEYS;
  return permissions.filter((p) => !known.has(p));
}

const roleNameSchema = z.string().trim().min(1).max(80);
const permissionListSchema = z.array(z.string().min(1)).max(100);

/** Un ruolo del catalogo, come lo vede chi gestisce ruoli e membri. */
export const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scope: roleScopeSchema,
  permissions: z.array(z.string()),
  /** Chiave del preset da cui il ruolo è nato (`admin`, `project_lead`…), null se creato da un utente. */
  presetKey: z.string().nullable(),
  /** Quante assegnazioni lo usano (utenti per un ruolo d'istanza, membri per uno di progetto). */
  assignmentCount: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Role = z.infer<typeof roleSchema>;

/** Corpo di `POST /api/roles`. */
export const createRoleSchema = z
  .object({
    name: roleNameSchema,
    scope: roleScopeSchema,
    permissions: permissionListSchema,
  })
  .superRefine((value, ctx) => {
    const unknown = unknownPermissionsFor(value.scope, value.permissions);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: `unknown permissions for scope ${value.scope}: ${unknown.join(", ")}`,
      });
    }
  });
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

/**
 * Corpo di `PATCH /api/roles/:id`: una patch, i campi assenti restano. Il tipo
 * non si cambia; le chiavi si validano sul server contro il tipo del ruolo.
 */
export const updateRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    permissions: permissionListSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.permissions !== undefined, {
    message: "nothing to update",
  });
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** Corpo di `POST /api/roles/:id/duplicate`: senza nome, «<nome> (copy)». */
export const duplicateRoleSchema = z.object({ name: roleNameSchema.optional() });
export type DuplicateRoleInput = z.infer<typeof duplicateRoleSchema>;

/** Un membro esplicito di un progetto (i full admin lo sono implicitamente e non compaiono). */
export const projectMemberSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  roleId: z.uuid(),
  roleName: z.string(),
  createdAt: z.iso.datetime(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** Corpo di `PUT /api/projects/:projectId/members/:userId`: aggiunge o cambia il ruolo. */
export const putProjectMemberSchema = z.object({ roleId: z.uuid() });
export type PutProjectMemberInput = z.infer<typeof putProjectMemberSchema>;

/** Corpo di `PATCH /api/users/:id/instance-role`. */
export const updateInstanceRoleSchema = z.object({ roleId: z.uuid() });
export type UpdateInstanceRoleInput = z.infer<typeof updateInstanceRoleSchema>;

/** Un progetto di un invito: all'accettazione l'invitato ne diventa membro con `roleId`. */
export const inviteProjectSchema = z.object({ projectId: z.uuid(), roleId: z.uuid() });
export type InviteProject = z.infer<typeof inviteProjectSchema>;
