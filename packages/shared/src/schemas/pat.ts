import { z } from "zod";

/**
 * Corpo di creazione di un Personal Access Token: un nome leggibile (obbligatorio)
 * e una scadenza opzionale in ISO 8601. `expiresAt` null oppure omesso = token
 * senza scadenza (vive finché non viene revocato).
 */
export const createPatSchema = z
  .object({
    name: z.string().min(1).max(100),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => v.expiresAt == null || new Date(v.expiresAt).getTime() > Date.now(), {
    message: "expiresAt must be in the future",
    path: ["expiresAt"],
  });
export type CreatePatInput = z.infer<typeof createPatSchema>;

/**
 * Proiezione pubblica di un PAT per la SPA: mai il token in chiaro né l'hash.
 * Le date sono ISO string; `lastUsedAt`/`expiresAt` sono nullable.
 */
export const patViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PatView = z.infer<typeof patViewSchema>;

/**
 * Risposta della creazione: la vista pubblica più il token in chiaro
 * (`stw_pat_…`). È l'UNICO momento in cui il token è visibile: non viene mai
 * più restituito (in DB vive solo il suo sha256).
 */
export const patWithTokenSchema = patViewSchema.extend({ token: z.string() });
export type PatWithToken = z.infer<typeof patWithTokenSchema>;
