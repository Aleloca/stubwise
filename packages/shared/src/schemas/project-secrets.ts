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

/**
 * Area 9, F5 (I2): l'Integrazione di un progetto, in LETTURA. Nessun valore
 * intero: la chiave d'ingestione ne dà le ultime 4, i segreti dei webhook git
 * le ultime 4 (solo a chi vede i repository). `dsnBase` è il DSN SENZA la
 * chiave (`https://host/p/<slug>`): il client compone quello mascherato. I
 * permessi li calcola il server.
 */
export const projectIntegrationSchema = z.object({
  ingestion: z.object({
    last4: z.string(),
    /** `null` per una chiave fatta prima che il server lo registrasse. */
    createdAt: z.iso.datetime().nullable().default(null),
    createdBy: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
    dsnBase: z.string(),
  }),
  inbound: z.object({ url: z.string() }),
  /** Vuoto per chi non ha `repos.view` né `repos.manage`. */
  gitWebhooks: z
    .array(
      z.object({
        repositoryId: z.string(),
        slug: z.string(),
        name: z.string(),
        /** Rimandi, lotto 5: la piattaforma del repository (`github`/`bitbucket`); assente da un server più vecchio. */
        provider: z.string().optional(),
        url: z.string(),
        secretLast4: z.string().nullable(),
        configured: z.boolean(),
      }),
    )
    .default([]),
  canRegenerateKey: z.boolean().default(false),
  canRegenerateWebhookSecret: z.boolean().default(false),
});
export type ProjectIntegration = z.infer<typeof projectIntegrationSchema>;
