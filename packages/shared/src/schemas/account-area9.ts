import { z } from "zod";

/**
 * Area 9, F1: le forme dell'account che leggono i client (sessioni, cambio
 * dell'email). Nate nel server, stanno qui perché il client le parsa. Ogni
 * campo che può mancare a un server più vecchio ha un default.
 */

/** Una mia sessione (`GET /api/me/sessions`): l'id è OPACO, mai quello vero. */
export const meSessionSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "desktop", "mobile"]),
  userAgent: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable().default(null),
  current: z.boolean().default(false),
});
export type MeSession = z.infer<typeof meSessionSchema>;

/** `GET /api/me/email-change` (e il 202 di `POST`). */
export const emailChangeStatusSchema = z.object({
  available: z.boolean(),
  pending: z.object({ newEmail: z.string(), expiresAt: z.iso.datetime() }).nullable().default(null),
});
export type EmailChangeStatus = z.infer<typeof emailChangeStatusSchema>;

/** `GET /api/auth/email-change/:token`: la lettura del link, che non conferma. */
export const emailChangeLinkSchema = z.object({
  status: z.enum(["valid", "invalid"]),
  newEmail: z.string().nullable().default(null),
});
export type EmailChangeLink = z.infer<typeof emailChangeLinkSchema>;

/** `POST /api/auth/email-change/confirm` e `PATCH /api/users/:id/email`. */
export const emailChangedSchema = z.object({ email: z.string() });
export type EmailChanged = z.infer<typeof emailChangedSchema>;

/** `POST /api/users/:id/password-reset`: `token` è additivo (area 9, F1). */
export const passwordResetLinkSchema = z.object({
  url: z.string(),
  token: z.string().nullable().default(null),
  expiresAt: z.iso.datetime(),
});
export type PasswordResetLink = z.infer<typeof passwordResetLinkSchema>;

/**
 * `GET /api/auth/invites/:token` (area 9, F1, decisione del maintainer): la
 * lettura pubblica dell'invito prima di registrarsi. I dettagli SOLO su un
 * invito valido (chi ha il token è il destinatario); su scaduto, usato,
 * revocato o sbagliato solo lo stato. Un invito usato o revocato è cancellato,
 * quindi il server risponde `invalid` per entrambi: `used` e `revoked` restano
 * nell'enum per i client.
 */
export const inviteLinkSchema = z.object({
  status: z.enum(["valid", "expired", "revoked", "used", "invalid"]),
  email: z.string().nullable().default(null),
  invitedByName: z.string().nullable().default(null),
  projects: z
    .array(z.object({ code: z.string().nullable().default(null), name: z.string(), roleName: z.string() }))
    .default([]),
  instanceRoleName: z.string().nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export type InviteLink = z.infer<typeof inviteLinkSchema>;
