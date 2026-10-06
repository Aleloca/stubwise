import { z } from "zod";
// Da `base-enums.ts`, non da `docs.ts`/`project.ts`: `ticket.ts` importa da
// qui, e quei due importano da `ticket.ts` (vedi il docblock di `base-enums.ts`).
import { gitProviderKindSchema, heldReasonSchema } from "./base-enums.js";

/**
 * Ciclo di correzione post-PR (design `2026-09-30-pr-correction-loop-design.md`).
 *
 * Chi ha chiesto una correzione: la review AI (il ciclo automatico), il bottone
 * "Chiedi modifiche" su Stubwise, o "Request changes" sul provider. Solo
 * `review` conta come giro automatico; le altre due azzerano il contatore.
 */
export const prCorrectionTriggerSchema = z.enum(["review", "stubwise", "provider"]);
export type PrCorrectionTrigger = z.infer<typeof prCorrectionTriggerSchema>;

/**
 * Lo stato del ciclo di UNA PR, come la riga sotto la PR sul ticket lo
 * racconta. Lo deriva il server (`derivePrCycle` in `@stubwise/notifications`,
 * con la tabella di verità nel suo docblock): il client lo LEGGE, non lo
 * ricostruisce.
 */
export const prCycleStateSchema = z.enum([
  // review in coda o in corso
  "reviewing",
  // correzione in coda o in corso
  "correcting",
  // ultima review = approve: tocca a una persona
  "approved",
  // ultima review = request_changes e il ciclo automatico non riparte da solo
  // (tetto a 0, o in attesa di una richiesta umana)
  "changes_requested",
  // tetto dei giri automatici raggiunto
  "stopped_at_cap",
  // l'ultima correzione è fallita
  "correction_failed",
  // nessuna review valida della versione corrente della PR
  "idle",
]);
export type PrCycleState = z.infer<typeof prCycleStateSchema>;

/**
 * Il ciclo di una PR nella risposta del dettaglio ticket (una voce per PR).
 * `canRequestCorrection` lo calcola il SERVER (PR aperta, branch `stubwise/`,
 * nessuna correzione né job in volo): stessa regola di `canMerge`, la copia
 * della regola non deve stare nell'app, che non possiamo aggiornare.
 */
export const prCycleSchema = z.object({
  state: prCycleStateSchema,
  // Correzioni automatiche EFFETTIVE della tornata corrente, sempre derivate
  // dalle righe — anche in `stopped_at_cap` NON è `maxRounds`: se il tetto
  // cambia dopo lo stop, il numero mostrato resta vero.
  round: z.number().int(),
  maxRounds: z.number().int(),
  // c'è una richiesta umana in attesa (arrivata mentre qualcosa era in volo)
  pendingRequest: z.boolean(),
  lastRequest: z
    .object({
      via: z.enum(["stubwise", "provider"]),
      // Su quale piattaforma è stato premuto "Request changes" (il provider
      // della repository): null quando `via` è `stubwise`. Stessi valori di
      // `gitProviderKindSchema` — è quell'enum, non una copia. `.default(null)`:
      // campo nuovo, mai obbligatorio (regola dell'app mobile, CLAUDE.md).
      platform: gitProviderKindSchema.nullable().default(null),
      // email dell'utente Stubwise, o login sulla piattaforma
      name: z.string(),
      // ISO 8601
      at: z.string(),
    })
    .nullable(),
  canRequestCorrection: z.boolean(),
  // PERCHÉ la correzione in corso è ferma: il suo job è parcheggiato in `held`
  // (budget mensile o tetto per ticket esaurito, limite del provider, gate).
  // `state` resta `correcting` — nessun valore nuovo nell'enum degli stati —
  // e questo campo dice alla riga di stato che "in corso" vuol dire "ferma, e
  // perché". Stessi valori di `ai_jobs.held_reason` (`heldReasonSchema`): è
  // quell'enum, non una copia. `null` = nessuna correzione ferma (o server più
  // vecchio): `.default(null)`, campo nuovo mai obbligatorio (CLAUDE.md).
  heldReason: heldReasonSchema.nullable().default(null),
  // CHI GUARDA può riprendere la correzione ferma con *Run AI*: `heldReason`
  // non null E (viewer admin, oppure non è ferma per budget — un `member` la
  // ripresa la ottiene, ma senza scavalcare il budget tornerebbe `held`). Lo
  // calcola il SERVER col ruolo del viewer (`canResumeCorrection` in
  // `@stubwise/notifications`), mai il client: stessa regola di `canMerge`, la
  // copia non deve stare nell'app. Con `heldReason: "budget"` e `canResume`
  // false la riga dice «la riprende un maintainer». `.default(false)`: campo
  // nuovo, mai obbligatorio (server più vecchio → nessuna promessa).
  canResume: z.boolean().default(false),
  // QUALE correzione è ferma: l'id del suo job `held`, valorizzato insieme a
  // `heldReason` (null altrimenti). Il client lo rimanda in
  // `POST /api/tickets/:id/run-ai` come `resumeCorrectionJobId`, così una
  // schermata vecchia non trasforma «Riprendi» in un fix nuovo se nel
  // frattempo la correzione è stata annullata o è finita (409
  // `correction_not_held`). `.default(null)`: campo nuovo, mai obbligatorio.
  heldJobId: z.uuid().nullable().default(null),
});
export type PrCycle = z.infer<typeof prCycleSchema>;

/**
 * ADOZIONE di una PR aperta da altri (6 ott 2026, design
 * `2026-10-06-adopt-external-pr-design.md`): sul dettaglio di un ticket
 * `review`, se Stubwise può essere messo a correggere quella PR. Lo DERIVA il
 * server a ogni lettura; il client lo legge, bottone compreso.
 *
 * - `available`: «Fai correggere a Stubwise» si può premere;
 * - `adopted`: Stubwise la corregge (il ciclo è sulla voce PR del ticket);
 *   «Smetti di correggere» la restituisce;
 * - `unavailable`: il bottone c'è ma è spento, col motivo
 *   (`unavailableReason`).
 *
 * Il fork si sa in anticipo solo se l'evento del webhook l'ha detto: quando
 * non lo si sa, lo stato è `available` e l'adozione lo verifica dal provider.
 */
export const prAdoptionStateSchema = z.enum(["available", "adopted", "unavailable"]);
export type PrAdoptionState = z.infer<typeof prAdoptionStateSchema>;

/** Perché una PR non si può adottare. */
export const prAdoptionUnavailableReasonSchema = z.enum([
  // PR da un fork: Stubwise non può scrivere sul branch
  "fork",
  // un branch di Stubwise (`stubwise/…`): è già nel ciclo, o non è di una persona
  "stubwise_pr",
  // il branch sorgente è il default o il target: pushare lì sarebbe pushare sulla base
  "base_branch",
  // PR chiusa o mergiata
  "pr_closed",
]);
export type PrAdoptionUnavailableReason = z.infer<typeof prAdoptionUnavailableReasonSchema>;

export const prAdoptionSchema = z.object({
  repositoryId: z.uuid(),
  prNumber: z.number().int(),
  prUrl: z.url(),
  /** Branch sorgente della PR; null se la review è precedente alla 0081 e non c'è un'adozione. */
  branch: z.string().nullable().default(null),
  state: prAdoptionStateSchema,
  unavailableReason: prAdoptionUnavailableReasonSchema.nullable().default(null),
  /** Quando e chi ha adottato (null se mai adottata o rilasciata). ISO 8601. */
  adoptedAt: z.string().nullable().default(null),
  adoptedBy: z.string().nullable().default(null),
  /**
   * Chi GUARDA può adottare e rilasciare? Solo un maintainer (`admin`). Lo
   * calcola il SERVER col ruolo del viewer, mai il client (stesso criterio di
   * `canMerge`): un operatore non vede il bottone. `.default(false)`: nessuna
   * promessa da un server più vecchio.
   */
  canManage: z.boolean().default(false),
});
export type PrAdoption = z.infer<typeof prAdoptionSchema>;

/** Corpo di `POST /api/tickets/:id/repositories/:repositoryId/adoption`. */
export const adoptPrBodySchema = z.object({
  // La nota facoltativa per la prima correzione, come «Chiedi modifiche».
  note: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
});
export type AdoptPrBody = z.infer<typeof adoptPrBodySchema>;

/** Risposta 202: la prima correzione accodata, o null se non è potuta partire. */
export const adoptPrResponseSchema = z.object({ correctionId: z.uuid().nullable() });
export type AdoptPrResponse = z.infer<typeof adoptPrResponseSchema>;

/** Corpo di `POST /api/tickets/:id/repositories/:repositoryId/corrections`. */
export const requestCorrectionBodySchema = z.object({
  // Nessun consumatore deve sapere che una nota vuota equivale a nessuna nota.
  // `.optional()` DOPO il transform: prima, zod 4 renderebbe `note` obbligatoria
  // nel tipo di output (`note: string | undefined`) e il body non coinciderebbe
  // più col tipo di input.
  note: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
});
export type RequestCorrectionBody = z.infer<typeof requestCorrectionBodySchema>;

/** Risposta 202 della stessa rotta. */
export const requestCorrectionResponseSchema = z.object({ correctionId: z.uuid() });
export type RequestCorrectionResponse = z.infer<typeof requestCorrectionResponseSchema>;

/**
 * Un commento di una PR letto dal provider (ciclo di correzione, design §9):
 * la "fotografia" del feedback umano presa quando qualcuno chiede modifiche.
 * È la forma salvata in `pr_corrections.provider_feedback` E il tipo che
 * `GitProvider.listPrComments` restituisce: UNA definizione sola, qui —
 * `@stubwise/git` la importa e la riesporta (B1), `@stubwise/db` la usa per
 * tipizzare la colonna senza dipendere da `@stubwise/git`.
 *
 * Comprende i commenti generali E quelli sulle righe; mai i cancellati né le
 * bozze. `authorId` è l'identità STABILE dell'autore sulla piattaforma (uuid
 * Bitbucket con le graffe, id numerico GitHub come stringa): è ciò su cui il
 * chiamante esclude gli account di Stubwise, quindi un commento senza autore
 * riconoscibile non viene restituito affatto. `path`/`line` sono entrambi
 * `null` per un commento generale.
 *
 * `line` è INDICATIVA, non un indirizzo esatto nel codice di oggi. Può
 * riferirsi al file VECCHIO (commento su una riga tolta: GitHub `side: LEFT`,
 * Bitbucket `inline.from`) oppure alla revisione in cui il commento è stato
 * scritto e non a quella attuale (commento "outdated": GitHub
 * `original_line`; Bitbucket `inline.to` resta quello della revisione
 * d'origine). I commit arrivati dopo possono quindi averla spostata: chi la
 * usa la tratti come un punto di partenza da ritrovare, non come una riga su
 * cui agire alla cieca.
 */
export const prCommentSchema = z.object({
  id: z.string(),
  // uuid Bitbucket / id numerico GitHub come stringa: è ciò che si confronta
  // con `git_accounts.provider_user_id` per scartare i nostri stessi commenti
  authorId: z.string(),
  authorLogin: z.string(),
  body: z.string(),
  createdAt: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  // Il rapporto dell'autore col repository, com'è sulla piattaforma: il campo
  // `author_association` di GitHub (`OWNER`, `MEMBER`, `COLLABORATOR`,
  // `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`…), maiuscolo come GitHub
  // lo manda. Serve a tenere nella fotografia SOLO chi ha il permesso di
  // chiedere modifiche (`isTrustedAuthorAssociation` in
  // `@stubwise/notifications`): su un repository pubblico chiunque può
  // commentare, e senza questo filtro il suo testo finirebbe nel prompt.
  // Lo valorizza solo GitHub; Bitbucket non ha un equivalente e manda `null`.
  // `null`/assente = SCONOSCIUTO. Additivo e `.optional()` apposta: le
  // fotografie già salvate in `pr_corrections.provider_feedback` non ce
  // l'hanno, e devono continuare a leggersi.
  authorAssociation: z.string().nullable().optional(),
});
export type PrComment = z.infer<typeof prCommentSchema>;

/**
 * PERCHÉ il ciclo automatico si è fermato (`PrCycleEvent.stoppedReason`):
 *  - `cap`: la review chiede ancora modifiche e il tetto dei giri è raggiunto;
 *  - `review_failed`: dentro una serie di correzioni automatiche la review non
 *    è arrivata a un verdetto (errore dell'agente o del git, costo oltre il
 *    tetto, output non parsabile…): nessuno riparte da solo, e senza avviso il
 *    ciclo si sarebbe spento in silenzio. L'evento porta allora `verdict: null`.
 * Chi LEGGE questo valore da un client che non si aggiorna coi nostri deploy
 * lo faccia passare da `readerSchema`, che apre l'enum a un valore futuro.
 */
export const prCycleStopReasonSchema = z.enum(["cap", "review_failed"]);
export type PrCycleStopReason = z.infer<typeof prCycleStopReasonSchema>;

/**
 * Il ciclo com'era al momento della publish di `review.completed`: un fatto
 * vero SOLO in quell'istante (CLAUDE.md, «derivati a lettura»: questo è il
 * caso in cui scriverlo nell'evento è giusto). `stopped` = il ciclo automatico
 * si è fermato; il PERCHÉ sta in `stoppedReason`.
 *
 * `stoppedReason` è ADDITIVO e `.optional()`: gli eventi pubblicati prima non
 * lo hanno, e per loro `stopped: true` significa sempre «al tetto» (l'unico
 * stop che esisteva). Chi legge tratti l'assenza così.
 */
export const prCycleEventSchema = z.object({
  round: z.number().int(),
  max: z.number().int(),
  stopped: z.boolean(),
  stoppedReason: prCycleStopReasonSchema.optional(),
});
export type PrCycleEvent = z.infer<typeof prCycleEventSchema>;
