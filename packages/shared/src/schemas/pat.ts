import { z } from "zod";

/**
 * Corpo di creazione di un Personal Access Token: un nome leggibile (obbligatorio)
 * e una scadenza opzionale in ISO 8601. `expiresAt` null oppure omesso = token
 * senza scadenza (vive finché non viene revocato).
 */
export const createPatSchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreatePatInput = z.infer<typeof createPatSchema>;

/**
 * Proiezione pubblica di un PAT per la SPA: mai il token in chiaro né l'hash.
 * Le date sono ISO string; `lastUsedAt`/`expiresAt` sono nullable.
 */
export const patViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type PatView = z.infer<typeof patViewSchema>;

/**
 * Risposta della creazione: la vista pubblica più il token in chiaro
 * (`stw_pat_…`). È l'UNICO momento in cui il token è visibile: non viene mai
 * più restituito (in DB vive solo il suo sha256).
 */
export const patWithTokenSchema = patViewSchema.extend({ token: z.string() });
export type PatWithToken = z.infer<typeof patWithTokenSchema>;
