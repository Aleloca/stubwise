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

/**
 * Le due decisioni umane che possono fermare un job, nella forma del pulse
 * (Fase 4): `question` = `ai_jobs.status = 'awaiting_input'` (notifica
 * `job.awaiting_input`), `plan_approval` = `awaiting_plan_approval` (notifica
 * `job.plan_review`). Un enum, non un letterale: apribile lato lettore mobile
 * (vedi `packages/shared/src/reader.ts`) se un domani si aggiunge un terzo tipo
 * di attesa.
 */
export const pulseWaitingKindSchema = z.enum(["question", "plan_approval"]);
export type PulseWaitingKind = z.infer<typeof pulseWaitingKindSchema>;

/**
 * Voce di `waitingForYou`: il viewer PUÒ agire. `notificationId` è la riga
 * d'inbox su cui farlo (stessa identità di `/api/inbox/:id/actions`).
 */
export const pulseWaitingForYouItemSchema = z.object({
  kind: pulseWaitingKindSchema,
  ticketId: z.uuid(),
  ticketNumber: z.number().int(),
  title: z.string(),
  notificationId: z.uuid(),
});
export type PulseWaitingForYouItem = z.infer<typeof pulseWaitingForYouItemSchema>;

/**
 * Chi PUÒ sbloccare una voce di `waitingForOthers`, quando non è il viewer:
 * `requester` (chi ha lanciato il job — `job.awaiting_input`, rivolta a lui)
 * o `maintainer` (solo un admin — `job.plan_review` è adminOnly, il
 * richiedente stesso non può approvare il proprio piano). STRUTTURATO e non
 * testo: la frase per l'umano la compone l'app, che sa in che lingua parlare —
 * il server manda solo il ruolo di chi deve agire.
 *
 * Un oggetto `{ kind }` e non l'enum nudo: lascia spazio a un domani in cui
 * `waitingWho` porti anche un nome (es. il richiedente), senza cambiare la
 * forma del campo — un array di stringhe diventerebbe un array di oggetti,
 * l'oggetto resta un oggetto.
 */
export const pulseWaitingWhoKindSchema = z.enum(["requester", "maintainer"]);
export const pulseWaitingWhoSchema = z.object({ kind: pulseWaitingWhoKindSchema });
export type PulseWaitingWho = z.infer<typeof pulseWaitingWhoSchema>;

/** Voce di `waitingForOthers`: il viewer non può agire lui stesso su questa. */
export const pulseWaitingForOthersItemSchema = z.object({
  kind: pulseWaitingKindSchema,
  ticketId: z.uuid(),
  ticketNumber: z.number().int(),
  title: z.string(),
  who: pulseWaitingWhoSchema,
});
export type PulseWaitingForOthersItem = z.infer<typeof pulseWaitingForOthersItemSchema>;

/** Voce di `running`: un job che l'agente sta eseguendo ORA. */
export const pulseRunningItemSchema = z.object({
  ticketId: z.uuid(),
  ticketNumber: z.number().int(),
  title: z.string(),
  // Calcolato al momento della richiesta (non un dato stabile da mettere in
  // cache lato client oltre la sessione in cui è arrivato).
  sinceMinutes: z.number().int().min(0),
});
export type PulseRunningItem = z.infer<typeof pulseRunningItemSchema>;

/**
 * Il "polso" di UN progetto per il viewer che l'ha richiesto: la vista che
 * alimenta l'app mobile (Fase 4, `GET /api/projects/pulse`). Nasce dagli
 * stessi segnali che il poller del pulse proattivo (Fase 2) già calcola per
 * decidere quando proporre lavoro (`@stubwise/notifications`), letti qui
 * sincronamente per un umano che guarda l'app.
 */
export const projectPulseSummarySchema = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  waitingForYou: z.array(pulseWaitingForYouItemSchema),
  waitingForOthers: z.array(pulseWaitingForOthersItemSchema),
  running: z.array(pulseRunningItemSchema),
  failedCount: z.number().int().min(0),
  backlogReadyCount: z.number().int().min(0),
  idleDays: z.number().int().min(0),
  // Data (YYYY-MM-DD) dell'ultimo report attività completato, o null se
  // nessuno è mai stato generato per questo progetto. Stringa e non
  // `z.iso.date()`: stessa convenzione della rotta `/api/activity` esistente
  // (la colonna Postgres è `date`, non `timestamptz`: nessun fuso da portare).
  lastReportDate: z.string().nullable(),
});
export type ProjectPulseSummary = z.infer<typeof projectPulseSummarySchema>;
