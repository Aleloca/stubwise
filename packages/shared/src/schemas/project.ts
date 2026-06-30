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
  // Slug del workspace Bitbucket (null per GitHub). Su Bitbucket serve a
  // elencare/validare i repo: gli endpoint account/globali sono stati dismessi
  // (CHANGE-2770, 410 Gone) e si può interrogare solo GET /2.0/repositories/{workspace}.
  workspace: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type GitAccount = z.infer<typeof gitAccountSchema>;

/**
 * Proiezione pubblica di un REPOSITORY (l'ex "progetto", rinominato): un singolo
 * repo git. Appartiene a esattamente un progetto-gruppo (`projectId`). Porta
 * tutto ciò che è specifico del repo git/ingest/webhook/docs. Le impostazioni di
 * prodotto (provider AI, auto-update docs) NON ne fanno più parte: sono salite al
 * progetto (vedi projectSchema).
 */
export const repositorySchema = z.object({
  id: z.uuid(),
  // Progetto (gruppo) a cui il repository appartiene.
  projectId: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  provider: gitProviderKindSchema,
  repoUrl: z.url(),
  defaultBranch: z.string().min(1),
  ingestionKey: z.string().min(1),
  // Account git che fornisce le credenziali del repository: id (per la modifica/
  // selezione) e nome (per la UI). Le credenziali NON sono mai esposte: vivono
  // cifrate sull'account. `webhookConfiguredAt` è l'istante in cui il webhook
  // git è stato configurato, o null se mai.
  gitAccountId: z.uuid(),
  gitAccountName: z.string().min(1),
  // Comando di test che la pipeline AI esegue per validare il fix (es.
  // "pnpm test"). null = nessun comando configurato.
  testCommand: z.string().min(1).nullable(),
  // Comando di installazione delle dipendenze eseguito nel worktree prima
  // della pipeline (es. "pnpm install"). null = nessun comando configurato.
  installCommand: z.string().min(1).nullable(),
  webhookConfiguredAt: z.iso.datetime().nullable(),
  // Il segreto HMAC del webhook git NON fa parte della proiezione pubblica:
  // è un segreto che permetterebbe di forgiare webhook di merge e forzare i
  // ticket a "done". Si legge solo via l'endpoint admin GET /:slug/webhook.
  createdAt: z.iso.datetime(),
});
export type Repository = z.infer<typeof repositorySchema>;

/**
 * Proiezione pubblica di un PROGETTO (gruppo): raggruppa uno o più repository
 * (1:N). È il livello "prodotto" (ticket e milestone) e porta le impostazioni
 * che valgono per tutti i suoi repository: il provider AI generale (Docs e fix;
 * null = automatico, primo abilitato all'esecuzione) e l'auto-aggiornamento
 * della documentazione ai push. `description` è opzionale (null = assente).
 */
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  aiProviderId: z.uuid().nullable(),
  docAutoUpdate: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * Payload di creazione di un progetto (gruppo): solo i campi che l'utente
 * fornisce. Lo `slug` è derivato dal nome lato server; le impostazioni di
 * prodotto hanno default (aiProviderId null = automatico, docAutoUpdate false).
 */
export const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  aiProviderId: z.uuid().nullable().optional(),
  docAutoUpdate: z.boolean().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * Payload di aggiornamento di un progetto (gruppo): tutti i campi opzionali
 * (patch parziale). `aiProviderId` nullable = scollega il provider (automatico).
 */
export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  aiProviderId: z.uuid().nullable().optional(),
  docAutoUpdate: z.boolean().optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
