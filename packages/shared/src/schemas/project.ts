import { z } from "zod";

export const gitProviderKindSchema = z.enum(["bitbucket", "github"]);
export type GitProviderKind = z.infer<typeof gitProviderKindSchema>;

/**
 * Proiezione pubblica di un account git riutilizzabile. Le credenziali (token,
 * username, email) NON ne fanno MAI parte: restano cifrate at-rest e write-only,
 * si validano/usano solo lato server. Un account può essere collegato a più
 * progetti (vedi projectSchema.gitAccountId).
 */
export const gitAccountSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  provider: gitProviderKindSchema,
  createdAt: z.iso.datetime(),
});
export type GitAccount = z.infer<typeof gitAccountSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  provider: gitProviderKindSchema,
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  ingestionKey: z.string().min(1),
  // Account git che fornisce le credenziali del progetto: id (per la modifica/
  // selezione) e nome (per la UI). Le credenziali NON sono mai esposte: vivono
  // cifrate sull'account. `webhookConfiguredAt` è l'istante in cui il webhook
  // git è stato configurato, o null se mai.
  gitAccountId: z.uuid(),
  gitAccountName: z.string().min(1),
  webhookConfiguredAt: z.iso.datetime().nullable(),
  // Il segreto HMAC del webhook git NON fa parte della proiezione pubblica:
  // è un segreto che permetterebbe di forgiare webhook di merge e forzare i
  // ticket a "done". Si legge solo via l'endpoint admin GET /:slug/webhook.
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
