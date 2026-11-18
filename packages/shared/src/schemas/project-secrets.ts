import { z } from "zod";

/**
 * Area 9, F5: le rigenerazioni (riconferma). Il valore nuovo si legge UNA
 * volta, in questa risposta.
 */
export const ingestionKeyResultSchema = z.object({ ingestionKey: z.string() });
export type IngestionKeyResult = z.infer<typeof ingestionKeyResultSchema>;

/**
 * Il segreto del webhook git: `manual` (da copiare a mano sulla piattaforma),
 * `platform` (aggiornato anche lì), `rollback` (la piattaforma aveva
 * accettato ma la scrittura è fallita: resta il vecchio; `platformRestored`
 * dice se anche la piattaforma è tornata al vecchio). Non un'unione
 * discriminata: `readerSchema` apre l'enum di `mode`, non le unioni.
 */
export const webhookSecretResultSchema = z.object({
  mode: z.enum(["manual", "platform", "rollback"]),
  webhookSecret: z.string().optional(),
  platformRestored: z.boolean().optional(),
});
export type WebhookSecretResult = z.infer<typeof webhookSecretResultSchema>;
