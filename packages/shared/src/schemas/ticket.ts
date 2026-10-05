import { z } from "zod";
import { handledBySchema } from "./actor.js";
import { prCycleSchema } from "./pr-correction.js";

export const ticketStatusSchema = z.enum([
  "open",
  "triaged",
  "in_progress",
  "in_review",
  "done",
  "closed",
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const ticketTypeSchema = z.enum(["bug", "feature", "task", "feedback", "review"]);
export type TicketType = z.infer<typeof ticketTypeSchema>;

export const ticketPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const ticketSourceSchema = z.enum([
  "manual",
  "sdk_error",
  "sdk_feedback",
  "api",
  "slack",
  "webhook",
  "widget",
]);
export type TicketSource = z.infer<typeof ticketSourceSchema>;

/**
 * Stima di sforzo di un ticket: intero 1–5, prodotto dal triage e usato dal
 * gate di automazione (auto-fix solo se `effort <= maxEffort`). La scala e le
 * etichette italiane sono l'unica fonte di verità, condivise tra worker
 * (prompt), server (validazione) e web (UI).
 */
export const effortSchema = z.number().int().min(1).max(5);
export type Effort = z.infer<typeof effortSchema>;

/** Etichette italiane della scala di sforzo, indicizzate per valore 1–5. */
export const EFFORT_LABELS: Record<number, string> = {
  1: "Banale",
  2: "Piccolo",
  3: "Medio",
  4: "Grande",
  5: "Molto grande",
};

/**
 * Stato della PR aperta dal fix su un singolo repo di un ticket (Fase 3, fix
 * multi-repo): "open" (in attesa di merge), "merged" (mergiata) o
 * "closed_unmerged" (chiusa senza merge). L'enum Postgres deriva da questo
 * schema: valori e validazione non possono divergere.
 */
export const prStateSchema = z.enum(["open", "merged", "closed_unmerged"]);
export type PrState = z.infer<typeof prStateSchema>;

/**
 * Proiezione pubblica dello stato PR per-repo di un ticket (Fase 3): una voce
 * per ogni repository effettivamente modificato dal fix, con il branch, la PR
 * aperta (se già aperta) e il suo stato. È l'unico legame ticket↔repo esposto:
 * il ticket appartiene solo al progetto. Popolata dopo l'esecuzione dell'agente;
 * vuota prima. `repositoryName` è opzionale (comodità di UI); slug e id sono
 * sempre presenti.
 */
export const ticketRepositorySchema = z.object({
  repositoryId: z.uuid(),
  repositorySlug: z.string().min(1),
  repositoryName: z.string().min(1).optional(),
  branch: z.string().min(1),
  prUrl: z.url().nullable(),
  prState: prStateSchema,
  /**
   * Stato del ciclo review → correzione della PR (30 set 2026, design
   * `2026-09-30-pr-correction-loop-design.md` §9). Lo DERIVA il server
   * (`derivePrCycle`, `@stubwise/notifications`, col ruolo di chi GUARDA) e i
   * client lo LEGGONO, bottone compreso (`canRequestCorrection`, `canResume`):
   * web e app non possono dire cose diverse, stessa regola di `canMerge`.
   * `null` = PR non aperta da Stubwise.
   *
   * `.nullable().default(null)` e mai obbligatorio: l'app installata valida
   * questa risposta, e un server senza il ciclo (rollback, istanza indietro)
   * non lo manda. Vedi `ticket.test.ts`. Sul WEB il default non gira (cast,
   * non parse): chi lo legge lì lo difende con `?? null`.
   */
  cycle: prCycleSchema.nullable().default(null),
});
export type TicketRepository = z.infer<typeof ticketRepositorySchema>;

/**
 * Forma pubblica di un ticket nelle risposte API: la riga del DB con le date
 * in ISO 8601. Alimenta anche l'OpenAPI generata.
 */
export const ticketSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  type: ticketTypeSchema,
  priority: ticketPrioritySchema,
  status: ticketStatusSchema,
  source: ticketSourceSchema,
  assigneeId: z.uuid().nullable(),
  // Milestone a cui il ticket è assegnato; null = nessuna milestone.
  milestoneId: z.uuid().nullable(),
  // Stima di sforzo 1–5 del triage AI; null finché il ticket non è triagiato.
  effort: effortSchema.nullable(),
  labels: z.array(z.string()),
  technicalPayload: z.unknown().nullable(),
  occurrences: z.number().int(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/**
 * Dettaglio del ticket: la forma pubblica più lo stato PR per-repo (Fase 3,
 * fix multi-repo). `repositories` elenca una voce per ogni repository
 * effettivamente modificato dal fix (righe `ticket_repositories`), con branch,
 * PR e stato. Vuoto prima dell'esecuzione dell'agente. È l'unico legame
 * ticket↔repo: il ticket appartiene solo al progetto.
 */
export const ticketDetailSchema = ticketSchema.extend({
  // Piano di implementazione e contenuto d'origine (design/piano collegati al
  // ticket): testo libero, null finché non impostati. Solo nel dettaglio: sono
  // potenzialmente grandi e fuori posto nelle liste.
  implementationPlan: z.string().nullable(),
  originContent: z.string().nullable(),
  /**
   * Riassunto "in breve" del piano dell'ULTIMO job del ticket (fase 5): le
   * stesse frasi non tecniche che la card d'inbox mostra sopra Approva/Rifiuta.
   * Null quando l'ultimo job non ha un piano riassunto.
   *
   * `.optional()` OLTRE a `.nullable()`: l'app mobile installata valida questa
   * risposta con lo schema compilato dentro di sé, e un campo obbligatorio
   * nuovo la romperebbe se il server tornasse a un'immagine precedente.
   */
  planSummary: z.string().nullable().optional(),
  /**
   * Pre-approvazione del piano (fase 7): un maintainer può approvare in
   * anticipo il piano CORRENTE, così un operatore (member) può far partire il
   * fix senza fermarsi sul gate — vedi `startRun` in
   * `apps/server/src/services/jobs.ts`. Tutti e tre OPZIONALI/nullable, come
   * `planSummary`: l'app mobile installata valida questa stessa risposta con
   * lo schema compilato dentro di sé, e un campo obbligatorio nuovo la
   * romperebbe se il server tornasse a un'immagine precedente.
   *
   * `planApprovedAt`/`planApprovedBy` restano valorizzati anche quando
   * l'approvazione è SCADUTA (il piano è stato riscritto dopo): raccontano
   * "quando e da chi", non "è ancora valida" — quello lo dice
   * `planApprovalStale`. Null = il piano corrente non è mai stato approvato.
   */
  planApprovedAt: z.iso.datetime().nullable().optional(),
  planApprovedBy: handledBySchema.nullable().optional(),
  /**
   * True quando l'approvazione esiste ma il piano è cambiato da allora (il
   * digest non combacia più): "serve un nuovo via libera". False sia quando
   * l'approvazione è ancora valida sia quando il piano non è mai stato
   * approvato (in quel caso `planApprovedAt` è null e la UI non deve
   * comunque parlare di "scaduta").
   */
  planApprovalStale: z.boolean().optional(),
  repositories: z.array(ticketRepositorySchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

/**
 * Item della lista ticket: la forma pubblica più il conteggio dei repository
 * toccati (righe `ticket_repositories`), utile ai badge di board/lista senza
 * caricare l'elenco completo per ogni ticket.
 */
export const ticketListItemSchema = ticketSchema.extend({
  repositoryCount: z.number().int(),
});
export type TicketListItem = z.infer<typeof ticketListItemSchema>;

/**
 * Pagina della lista ticket: gli item più il cursore della pagina successiva
 * (null sull'ultima). L'involucro sta qui accanto agli item e non nelle rotte
 * perché lo leggono in tre — server, SPA e app mobile — e una copia per
 * lettore è esattamente ciò che questo pacchetto esiste per evitare.
 */
export const ticketPageSchema = z.object({
  items: z.array(ticketListItemSchema),
  nextCursor: z.string().nullable(),
  /**
   * Quanti ticket soddisfano i FILTRI della richiesta, non quanti ne porta
   * questa pagina (22 set 2026, hub di progetto): serve a una riga di sintesi
   * — «TICKET · 14 aperti» — che senza dovrebbe scaricare tutte le pagine per
   * sapere di quante sta mostrando le prime due.
   *
   * ⚠️ Il conteggio IGNORA il cursore, di proposito: il cursore è
   * paginazione, non un filtro, e includerlo darebbe un totale che CALA
   * pagina dopo pagina — «quanti ne restano», che non è la domanda. Il server
   * lo calcola perciò sulle sole condizioni di filtro.
   *
   * `.optional()` come ogni campo nuovo che l'app legge (CLAUDE.md, «solo
   * cambi additivi»): un'app aggiornata che parla con un server più vecchio
   * non lo riceve, e chi lo mostra deve degradare alle sole righe senza il
   * numero — mai una schermata rotta.
   */
  total: z.number().int().optional(),
});
export type TicketPage = z.infer<typeof ticketPageSchema>;

/**
 * Esito di `POST /api/tickets/:id/questions/answer`: il job che riparte e la
 * domanda a cui si è risposto. `questionId` torna indietro perché il server
 * confronta quella MOSTRATA con quella davvero aperta, e il client deve poter
 * verificare a quale delle due ha risposto.
 */
export const answerQuestionResultSchema = z.object({ jobId: z.uuid(), questionId: z.uuid() });
export type AnswerQuestionResult = z.infer<typeof answerQuestionResultSchema>;

/**
 * Corpo di `POST /api/tickets/:id/run-ai`. Tutti i campi sono OPZIONALI: un
 * client vecchio che non ne conosce uno continua a funzionare (verso l'app
 * mobile si cresce solo per aggiunta, anche nelle richieste — CLAUDE.md).
 *
 * `resumeCorrectionJobId` dice QUALE correzione ferma si vuole riprendere: il
 * job `held` che la schermata mostrava (`cycle.heldJobId`). Il server lo
 * forza SOLO se è ancora l'ultimo job del ticket, di una correzione, e ancora
 * `held`; altrimenti 409 `correction_not_held`, senza scrivere niente. Senza
 * il campo il rilancio è quello di sempre — e su una correzione nel frattempo
 * annullata o conclusa partirebbe un fix nuovo, cioè ciò che una schermata
 * vecchia con «Riprendi» non deve poter chiedere.
 */
export const runAiBodySchema = z.object({
  withInstructions: z.boolean().optional(),
  // "ai_plan" forza il flusso normale (triage/pianificazione) anche se il
  // ticket ha un piano salvato: l'unico valore ammesso.
  mode: z.literal("ai_plan").optional(),
  resumeCorrectionJobId: z.uuid().optional(),
});
export type RunAiBody = z.infer<typeof runAiBodySchema>;

/**
 * Esito (202) dell'avvio manuale dell'AI su un ticket. `status` distingue i due
 * modi in cui un run può nascere: in coda, oppure GIÀ fermo sul gate di
 * approvazione — un run chiesto da un operatore su un ticket con piano salvato.
 * Sono due esperienze diverse e il client deve dirle con parole diverse.
 */
export const runAiResultSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(["queued", "awaiting_plan_approval"]),
});
export type RunAiResult = z.infer<typeof runAiResultSchema>;

/** Esito (202) di approva/rifiuta piano: il job che riparte. */
export const planDecisionResultSchema = z.object({ jobId: z.uuid() });
export type PlanDecisionResult = z.infer<typeof planDecisionResultSchema>;

/**
 * Una voce del feed di attività di un ticket (`GET /api/tickets/:id/activity`):
 * commenti, eventi di audit e marker dei run dell'agente, già fusi e ordinati
 * per `createdAt` crescente dal server.
 *
 * ⚠️ **FORMA PIATTA E PERMISSIVA, di proposito.** Lato server la risposta è una
 * `discriminatedUnion` di tre varianti (`apps/server/src/routes/tickets.ts`),
 * ma `readerSchema` (`packages/shared/src/reader.ts`) NON attraversa le union:
 * dichiararla qui com'è lascerebbe chiusi gli enum interni (`eventKind`,
 * `status`) senza che nulla lo segnali, e una quarta variante aggiunta domani
 * farebbe fallire il parse dell'INTERO feed su un'app già installata — la
 * schermata "Storia del lavoro" vuota su ogni telefono. Vedi la stessa
 * riflessione, con la conclusione opposta (nessuno schema affatto), sul metodo
 * `timeline` in `packages/api-client/src/endpoints/projects.ts`.
 *
 * Qui la si legge invece come UN oggetto con i campi comuni obbligatori e
 * quelli specifici di una variante opzionali. Le conseguenze sono volute:
 *
 * - `kind` ed `eventKind` sono `z.string()` e non enum: aperti per
 *   costruzione, senza bisogno che `readerSchema` li apra. Chi li confronta
 *   confronta stringhe, e un valore ignoto semplicemente non corrisponde a
 *   nulla — mai un crash, mai un `UNKNOWN` da gestire.
 * - `payload` dichiara le sole due chiavi che i consumatori leggono davvero
 *   (`from`/`to` di `status_changed`) e non un `z.record`, che sarebbe un nodo
 *   NON attraversabile e farebbe scattare il guardiano in
 *   `packages/api-client/src/reader.test.ts`.
 * - i campi delle altre varianti (autore e corpo di un commento) non sono
 *   dichiarati: `z.object` li spoglia, e nessuno li legge.
 */
export const ticketActivityEntrySchema = z.object({
  /** `comment` | `event` | `ai_job` oggi — stringa aperta, vedi sopra. */
  kind: z.string(),
  /** Identità della riga d'origine (commento, evento, job). */
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  /** Solo su `kind: "event"`: il tipo di evento di audit, es. `status_changed`. */
  eventKind: z.string().optional(),
  /** Solo su `kind: "event"`: `{ from, to }` per `status_changed`, `null` per gli eventi che non ne hanno. */
  payload: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .nullable()
    .optional(),
  /** Solo su `kind: "ai_job"`. */
  status: z.string().optional(),
  prUrl: z.string().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional(),
});
export type TicketActivityEntry = z.infer<typeof ticketActivityEntrySchema>;

/**
 * Il commento a cui un altro risponde, come lo vede chi legge la risposta
 * (migrazione 0083, piano `2026-10-05-ticket-history-and-replies`).
 *
 * DERIVATO a lettura dal server (una query per elenco), mai copiato nella
 * riga della risposta: se l'originale sparisce (`ON DELETE SET NULL`) la
 * risposta riceve `replyTo: null`, invece di indicare un commento che non c'è.
 * `authorName` è l'email per un autore `user`, `null` per AI/sistema o per un
 * autore eliminato; `excerpt` è il corpo senza markdown, tagliato
 * (`plainExcerpt`). `authorType` è un enum che `readerSchema` apre.
 */
export const commentReplyToSchema = z.object({
  id: z.uuid(),
  authorType: z.enum(["user", "ai", "system"]),
  authorName: z.string().nullable(),
  excerpt: z.string(),
});
export type CommentReplyTo = z.infer<typeof commentReplyToSchema>;

/**
 * Un commento di ticket, come lo restituiscono `GET`/`POST
 * /api/tickets/:ticketId/comments`.
 *
 * Vive QUI e non più solo in `apps/server/src/routes/comments.ts` (che ora lo
 * importa da qui e lo ri-esporta per l'OpenAPI) perché dall'app mobile lo
 * legge anche il client condiviso: due definizioni dello stesso corpo sono
 * due verità che divergono al primo campo aggiunto da una parte sola.
 *
 * `authorId` è nullo per i commenti dell'AI e di sistema, o se l'autore è
 * stato eliminato; `authorType` distingue i tre casi, ed è un enum che
 * `readerSchema` apre — una quarta origine di commento non deve far fallire
 * il parse dell'intero elenco su un telefono non aggiornato.
 */
export const ticketCommentSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  authorType: z.enum(["user", "ai", "system"]),
  authorId: z.uuid().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  /**
   * Il commento a cui questo risponde, o `null`. Campo ADDITIVO: nasce
   * `.nullable().default(null)` perché l'app installata può parlare con un
   * server che non lo manda (rollback, istanza self-hosted non aggiornata).
   */
  replyTo: commentReplyToSchema.nullable().default(null),
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;

/**
 * Un evento della storia di un ticket (`GET /api/tickets/:id/history`), dal
 * modulo puro `buildTicketHistory` di `@stubwise/notifications`.
 *
 * Forma PIATTA con `kind` stringa aperta, per lo stesso motivo di
 * {@link ticketActivityEntrySchema}: `readerSchema` non attraversa le union, e
 * un `kind` nuovo domani non deve far fallire il parse della storia intera su
 * un telefono non aggiornato (l'app lo rende come riga generica).
 *
 * Ogni campo oltre a `id`/`kind`/`at` nasce `.nullable().default(null)`.
 *
 * - `actor`: chi ha fatto la cosa. `null` = nessuna persona REGISTRATA — un
 *   evento di sistema, o un utente poi eliminato (le colonne d'autore sono
 *   `ON DELETE SET NULL`): il client non deve tradurlo in «automatico».
 * - `round`: il numero d'ordine della correzione sulla sua PR (da 1), NON il
 *   contatore dei giri automatici del ciclo (`cycle.round`).
 * - `detail`: il dettaglio del kind (verdetto, stato di arrivo, `cancelled`,
 *   `pre_approved`…).
 * - `fromStatus`: solo su `status_changed`, lo stato di partenza. Assente
 *   (`null`) sulla chiusura (`ticket_closed`): non serve a dirla, e per le
 *   chiusure ricostruite dal backfill della fase 5 è un valore PRESUNTO.
 */
export const ticketHistoryEventSchema = z.object({
  /** Stabile: `${kind}:${idDellaRiga}`. */
  id: z.string(),
  kind: z.string(),
  at: z.iso.datetime(),
  actor: z
    .object({
      type: z.enum(["user", "ai", "system", "provider"]),
      name: z.string().nullable(),
    })
    .nullable()
    .default(null),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  round: z.number().int().nullable().default(null),
  detail: z.string().nullable().default(null),
  fromStatus: z.string().nullable().default(null),
});
export type TicketHistoryEvent = z.infer<typeof ticketHistoryEventSchema>;

/**
 * La storia di un ticket, dal più recente. `events` porta al più il tetto
 * della rotta (200); `total` è il numero PRIMA del taglio, così «Show all (N)»
 * non mente su un ticket lunghissimo (`.default(0)` per un server che non lo
 * mandasse).
 */
export const ticketHistorySchema = z.object({
  events: z.array(ticketHistoryEventSchema).default([]),
  total: z.number().int().nonnegative().default(0),
});
export type TicketHistory = z.infer<typeof ticketHistorySchema>;
