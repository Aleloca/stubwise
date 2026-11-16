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
  kind: z.enum(["full_admin", "role", "grant", "department"]),
  roleId: z.uuid().nullable().default(null),
  roleName: z.string().nullable().default(null),
  byUserId: z.uuid().nullable().default(null),
  at: z.iso.datetime().nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
});
export type AccessReason = z.infer<typeof accessReasonSchema>;

/**
 * Una riga di «Chi può farlo?». Claude ha la sua riga (`agent: true`, senza
 * motivi) solo se il permesso è nel suo insieme fisso.
 */
export const whoCanPersonSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable().default(null),
  agent: z.boolean().default(false),
  reasons: z.array(accessReasonSchema).default([]),
});
export type WhoCanPerson = z.infer<typeof whoCanPersonSchema>;

export const whoCanResponseSchema = z.object({
  permission: z.string(),
  projectId: z.uuid().nullable(),
  people: z.array(whoCanPersonSchema),
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
      permissions: z.array(permissionWithReasonsSchema),
    }),
  ),
});
export type WhatCanResponse = z.infer<typeof whatCanResponseSchema>;
