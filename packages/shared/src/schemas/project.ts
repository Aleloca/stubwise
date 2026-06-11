import { z } from "zod";

export const gitProviderKindSchema = z.enum(["bitbucket", "github"]);
export type GitProviderKind = z.infer<typeof gitProviderKindSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  provider: gitProviderKindSchema,
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  ingestionKey: z.string().min(1),
  // Stato di configurazione esposto alla UI per collassare i form già
  // compilati. `hasCredentials` dice solo SE le credenziali esistono (mai il
  // loro contenuto: restano write-only). `webhookConfiguredAt` è l'istante in
  // cui il webhook git è stato configurato, o null se mai.
  hasCredentials: z.boolean(),
  webhookConfiguredAt: z.iso.datetime().nullable(),
  // Il segreto HMAC del webhook git NON fa parte della proiezione pubblica:
  // è un segreto che permetterebbe di forgiare webhook di merge e forzare i
  // ticket a "done". Si legge solo via l'endpoint admin GET /:slug/webhook.
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;
