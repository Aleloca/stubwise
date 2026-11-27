import { z } from "zod";

/**
 * Area 9, F1 (design 1.7, D-11): «Chi può farlo?» e «Cosa può fare?».
 * `GET /api/access/who-can` e `GET /api/access/what-can`.
 *
 * Il PERCHÉ di un permesso: `full_admin` (li ha tutti), `role` (il ruolo
 * d'istanza o di progetto, con l'id e il nome), `grant` (dato a lui, da chi e
 * quando), e con F8 `department`. Un oggetto piatto: i campi che non c'entrano
 * sono null, e `kind` lo apre `readerSchema` sui client.
 */
export const accessReasonSchema = z.object({
  kind: z.enum(["full_admin", "role", "grant", "department", "workspace"]),
  roleId: z.uuid().nullable().default(null),
  roleName: z.string().nullable().default(null),
  byUserId: z.uuid().nullable().default(null),
  at: z.iso.datetime().nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
  /** Area 9, F8 (additivo): il nome del reparto, per «via <reparto>». */
  departmentName: z.string().nullable().default(null),
  /** Workspace (lotto 4, additivi): da quale workspace, col ruolo di workspace in `roleId`/`roleName`. */
  workspaceId: z.uuid().nullable().default(null),
  workspaceName: z.string().nullable().default(null),
});
export type AccessReason = z.infer<typeof accessReasonSchema>;

/** Una riga di «Chi può farlo?»: una persona attiva, coi motivi. */
export const whoCanPersonSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable().default(null),
  reasons: z.array(accessReasonSchema).default([]),
});
export type WhoCanPerson = z.infer<typeof whoCanPersonSchema>;

/**
 * Claude non ha permessi suoi, e il server non gliene applica nessuno: agisce
 * sempre con quelli di chi lo assegna (`runs.start`) o di chi conferma
 * l'azione. Per questo non ha una riga, ma questo fatto fisso, che il client
 * dice con una frase di catalogo (una sola verità, quella del server).
 */
export const agentAccessSchema = z.object({ actsFor: z.enum(["confirmer"]) });

export const whoCanResponseSchema = z.object({
  permission: z.string(),
  projectId: z.uuid().nullable(),
  people: z.array(whoCanPersonSchema),
  agent: agentAccessSchema.default({ actsFor: "confirmer" }),
});
export type WhoCanResponse = z.infer<typeof whoCanResponseSchema>;

export const permissionWithReasonsSchema = z.object({
  permission: z.string(),
  reasons: z.array(accessReasonSchema).default([]),
});
export type PermissionWithReasons = z.infer<typeof permissionWithReasonsSchema>;

/** «Cosa può fare?»: i permessi d'istanza e, per ogni progetto che chi guarda vede, quelli di progetto. */
export const whatCanResponseSchema = z.object({
  userId: z.uuid(),
  instance: z.array(permissionWithReasonsSchema),
  projects: z.array(
    z.object({
      projectId: z.uuid(),
      projectName: z.string(),
      /** Workspace (lotto 4, additivo): la workspace da cui la persona vede il progetto, se c'è. */
      workspaceName: z.string().nullable().default(null),
      permissions: z.array(permissionWithReasonsSchema),
    }),
  ),
});
export type WhatCanResponse = z.infer<typeof whatCanResponseSchema>;
