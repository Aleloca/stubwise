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
 * tutto ciò che è specifico del repo git/webhook/docs. Le impostazioni di
 * prodotto (provider AI, auto-update docs) e l'ingestion (`ingestionKey`,
 * numerazione ticket) NON ne fanno più parte: sono salite al progetto (Fase 3,
 * vedi projectSchema). Il webhook git delle PR resta invece per-repo.
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
  // Knowledge graph (graphify) attivo su questo repository: abilita la build ai
  // push sul branch di default e la generazione manuale. Vive sul REPOSITORY
  // (non sul progetto) perché il grafo è estratto da un singolo codebase.
  graphEnabled: z.boolean(),
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
 * della documentazione ai push. Dalla Fase 3 porta anche l'ingestion di prodotto:
 * `ingestionKey` (salita dal repo) con cui gli SDK inviano errori/feedback, e la
 * numerazione ticket per-progetto (`nextTicketNumber`). `description` è opzionale
 * (null = assente).
 */
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  aiProviderId: z.uuid().nullable(),
  docAutoUpdate: z.boolean(),
  // Se true, il worker genera ogni notte uno standup dai commit del giorno di
  // tutti i repository del progetto (report attività). Default false.
  dailyReportEnabled: z.boolean(),
  // Se true, i ticket feedback/feature del progetto NON entrano nella pipeline
  // fix: vengono deviati verso il backlog di discovery (intake). Default false.
  backlogEnabled: z.boolean(),
  // Pulse proattivo: se true, quando il progetto è fermo un poller propone 2–3
  // voci del backlog da cui ripartire. Default false (opt-in esplicito).
  //
  // Dipende dal BACKLOG: senza `backlogEnabled` non ci sono voci da proporre e
  // il pulse resterebbe muto. Il vincolo NON è espresso qui — è il form a
  // disabilitare i controlli — perché un progetto può spegnere il backlog senza
  // dover contestualmente spegnere il pulse, e un refine lo trasformerebbe in
  // un 400 su un PATCH che tocca tutt'altro.
  pulseEnabled: z.boolean(),
  // Cadenza minima fra due pulse dello stesso progetto, in giorni. Il range
  // 1..30 è lo stesso CHECK che il DB applica (`projects_pulse_every_days_chk`):
  // sotto 1 giorno sarebbe un ping continuo, sopra 30 un promemoria che non
  // arriva mai.
  pulseEveryDays: z.number().int().min(1).max(30),
  // Chiave di ingestion del progetto: gli SDK la usano per inviare errori e
  // feedback (l'ingestion è di prodotto, non di repo — Fase 3).
  ingestionKey: z.string().min(1),
  // Prossimo numero ticket sequenziale del progetto (per-progetto, Fase 3).
  nextTicketNumber: z.number().int().min(1),
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
  dailyReportEnabled: z.boolean().optional(),
  backlogEnabled: z.boolean().optional(),
  pulseEnabled: z.boolean().optional(),
  pulseEveryDays: z.number().int().min(1).max(30).optional(),
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
  dailyReportEnabled: z.boolean().optional(),
  backlogEnabled: z.boolean().optional(),
  pulseEnabled: z.boolean().optional(),
  // Fuori dal range 1..30 il PATCH è un 400 di validazione, e non arriva mai al
  // CHECK del DB (che resta l'arbitro per chi scrive senza passare da qui).
  pulseEveryDays: z.number().int().min(1).max(30).optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/**
 * Riepilogo di un repository dentro la lista/dettaglio di un progetto: solo i
 * campi che servono a ELENCARE i repo del gruppo. La proiezione pubblica
 * completa ({@link repositorySchema}) vive sotto `/api/repositories` — qui
 * sarebbe rumore su ogni riga.
 */
export const repositorySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  provider: gitProviderKindSchema,
});
export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

/** Progetto con il CONTEGGIO dei repository: la forma della lista. */
export const projectListItemSchema = projectSchema.extend({
  repositoryCount: z.number().int(),
});
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

/** Progetto con l'ELENCO sintetico dei suoi repository: la forma del dettaglio. */
export const projectDetailSchema = projectSchema.extend({
  repositories: z.array(repositorySummarySchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
