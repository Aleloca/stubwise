import { z } from "zod";

/**
 * Schemi dell'INBOX: la forma con cui `/api/inbox` e `/api/me/*` parlano alla
 * SPA. Stanno in `@stubwise/shared` perché servono a due lati (validazione
 * lato server, tipi lato web) e nessuno dei due deve ridichiararli.
 *
 * Sono la proiezione HTTP dei tipi di `apps/server/src/services/inbox.ts`: le
 * stesse informazioni con le date in ISO 8601 invece che `Date`. La logica (chi
 * può fare cosa, come si calcolano le azioni) resta tutta nel servizio: qui c'è
 * solo il contratto.
 */

/**
 * Tipo di evento che ha generato la notifica: speculare all'enum Postgres
 * `notification_kind` (packages/db) e all'unione `NotificationKind` di
 * `@stubwise/notifications`. È ridichiarato invece di importato perché
 * `@stubwise/shared` finisce nel bundle browser e dipende dal solo `zod`: le
 * tre liste vanno tenute allineate a mano quando si aggiunge un kind.
 *
 * NB: qui NON si esporta un type alias, per non collidere con l'omonimo
 * `NotificationKind` di `@stubwise/notifications` nei file che importano
 * entrambi i package. Chi vuole il tipo usa `InboxItem["kind"]`.
 */
export const notificationKindSchema = z.enum([
  "ticket.created",
  "job.pr_opened",
  "job.pr_closed",
  "job.held",
  "job.plan_review",
  "job.budget_held",
  "review.completed",
  "job.failed",
  "docs.limit_paused",
  "monitor.alert",
  "monitor.recovered",
  "job.awaiting_input",
  "project.pulse",
]);

/**
 * Stato di una riga d'inbox: `open` (da smaltire), `handled` (chiusa) o
 * `snoozed` (rinviata fino a `snoozedUntil`). Speculare all'enum Postgres
 * `notification_status`.
 */
export const inboxStatusSchema = z.enum(["open", "handled", "snoozed"]);
export type InboxStatus = z.infer<typeof inboxStatusSchema>;

/**
 * Azioni che una riga d'inbox può offrire. `open` è un link (non è eseguibile
 * lato server); `snooze` e `handled` hanno rotte dedicate; le decisionali
 * passano da `POST /api/inbox/:id/actions/:action`.
 *
 * `handled` non è offerta da TUTTI i kind: la domanda dell'agente
 * (`job.awaiting_input`) si chiude solo rispondendo. Chi decide è il catalogo di
 * `@stubwise/notifications`; qui c'è solo l'insieme dei valori ammessi.
 */
export const inboxActionSchema = z.enum([
  "approve_plan",
  "reject_plan",
  "relaunch",
  "answer",
  "open",
  "snooze",
  "handled",
]);
export type InboxAction = z.infer<typeof inboxActionSchema>;

/**
 * Sottoinsieme di {@link inboxActionSchema} accettato da
 * `POST /api/inbox/:id/actions/:action`: le sole azioni DECISIONALI. Le altre
 * arrivano dalle rotte dedicate `read`/`snooze`/`handled`.
 */
export const inboxDecisionActionSchema = z.enum([
  "approve_plan",
  "reject_plan",
  "relaunch",
  "answer",
]);
export type InboxDecisionAction = z.infer<typeof inboxDecisionActionSchema>;

/** Durate di rinvio ammesse dallo snooze. */
export const snoozeUntilSchema = z.enum(["1h", "tomorrow", "3d"]);
export type SnoozeUntil = z.infer<typeof snoozeUntilSchema>;

/** Chi ha chiuso una notifica: l'id per la UI, l'email per dirlo a parole. */
export const handledBySchema = z.object({ id: z.uuid(), email: z.string() });
export type HandledBy = z.infer<typeof handledBySchema>;

/**
 * Una delle alternative proposte dall'agente con `ask_user`: l'etichetta del
 * bottone e la conseguenza che la UI mostra sotto (assente quando l'agente non
 * l'ha scritta).
 */
export const agentQuestionOptionSchema = z.object({
  label: z.string(),
  consequence: z.string().optional(),
});
export type AgentQuestionOption = z.infer<typeof agentQuestionOptionSchema>;

/**
 * LA DOMANDA DELL'AGENTE, nella forma che serve a chi la deve far rispondere:
 * il testo, le alternative, quale è consigliata e se è ammesso il testo libero.
 *
 * È la forma CANONICA, ed è deliberatamente la stessa su due superfici che
 * prendono il dato da due posti diversi:
 *
 *  - la CARD D'INBOX la ricava dal payload `event` della notifica, che porta la
 *    domanda intera (evento autosufficiente: nessuna rilettura di
 *    `agent_questions` per disegnare una lista);
 *  - la PAGINA TICKET la legge dalla riga `agent_questions` via
 *    `GET /api/tickets/:id/questions`, che restituisce
 *    {@link ticketQuestionSchema} — questo schema PIÙ la risposta.
 *
 * Un solo componente di risposta le consuma entrambe, e per questo i nomi e le
 * convenzioni devono coincidere: `questionId` (non `id`) e `recommendedIndex`
 * OMESSO quando non c'è (non `null`), anche dove la colonna DB è nullable. La
 * normalizzazione la fa la rotta, non il client.
 *
 * Sulla card è OPZIONALE: se il payload dell'evento non supera più questa
 * validazione (riga scritta da una versione precedente) l'item arriva senza
 * `question` e la card degrada a testo — vedi il recinto per-item di
 * `listInbox`. Il `question` testuale è ridondante col `text` localizzato
 * dell'item, che lo include nella frase: è qui lo stesso perché il pannello
 * deve poterlo mostrare identico sulle due superfici.
 */
export const inboxQuestionSchema = z.object({
  questionId: z.uuid(),
  round: z.number().int(),
  question: z.string(),
  options: z.array(agentQuestionOptionSchema),
  recommendedIndex: z.number().int().optional(),
  allowFreeText: z.boolean(),
});
export type InboxQuestion = z.infer<typeof inboxQuestionSchema>;

/**
 * La risposta umana COME VIENE PERSISTITA in `agent_questions.answer`: l'indice
 * dell'opzione scelta, oppure il testo libero. È la forma canonica del dato —
 * `packages/db` ci tipa la colonna jsonb e il worker ci rilegge la decisione per
 * il prompt di ripresa — e sta qui perché nessuno dei due lati la ridichiari.
 */
export const agentQuestionAnswerSchema = z.union([
  z.object({ optionIndex: z.number().int().nonnegative() }),
  z.object({ text: z.string() }),
]);
export type AgentQuestionAnswer = z.infer<typeof agentQuestionAnswerSchema>;

/**
 * Una Q&A dell'agente come la restituisce `GET /api/tickets/:id/questions`: la
 * domanda ({@link inboxQuestionSchema}, stessi nomi e stesse convenzioni) PIÙ la
 * risposta e chi l'ha data.
 *
 * `extend` e non una dichiarazione a parte: è ciò che rende impossibile far
 * divergere le due superfici: se un giorno la domanda guadagna un campo, lo
 * guadagnano insieme e il pannello di risposta continua a consumarle entrambe
 * senza normalizzare nulla a mano.
 *
 * `answer` è `null` sia sulla domanda ancora aperta sia su una risposta che non
 * è più leggibile (jsonb di una versione precedente): `answeredAt` distingue i
 * due casi, ed è lui che il client deve guardare per sapere se una risposta c'è
 * stata.
 */
export const ticketQuestionSchema = inboxQuestionSchema.extend({
  /** Job che ha posto la domanda: la pagina ticket ci ancora la risposta. */
  jobId: z.uuid(),
  askedAt: z.iso.datetime(),
  answer: agentQuestionAnswerSchema.nullable(),
  answeredAt: z.iso.datetime().nullable(),
  answeredBy: handledBySchema.nullable(),
});
export type TicketQuestion = z.infer<typeof ticketQuestionSchema>;

/** Corpo di `GET /api/tickets/:id/questions`: le Q&A in ordine cronologico. */
export const ticketQuestionsSchema = z.array(ticketQuestionSchema);

/** Tetto per una risposta in testo libero (allineato al servizio). */
export const ANSWER_TEXT_MAX_CHARS = 4000;

/**
 * Corpo di `POST /api/inbox/:id/actions/answer`: ESATTAMENTE uno dei due campi.
 *
 * Non è la union persistita ({@link agentQuestionAnswerSchema}) ma un oggetto
 * con due campi opzionali più un refine, per una ragione pratica: un client che
 * manda `{}` o entrambi i campi deve ricevere un errore di validazione che
 * NOMINA il problema, mentre una union di oggetti gli risponderebbe con l'unione
 * degli errori dei due rami ("optionIndex richiesto" *e* "text richiesto"), che
 * non aiuta nessuno.
 *
 * La validazione di MERITO — indice dentro le opzioni davvero persistite, testo
 * libero ammesso da quella domanda — non sta qui: dipende dalla riga
 * `agent_questions` e vive in `answerQuestion`.
 */
export const answerBodySchema = z
  .object({
    optionIndex: z.number().int().nonnegative().optional(),
    text: z.string().max(ANSWER_TEXT_MAX_CHARS).optional(),
  })
  .refine((v) => (v.optionIndex === undefined) !== (v.text === undefined), {
    message: "provide exactly one of optionIndex or text",
  });
export type AnswerBody = z.infer<typeof answerBodySchema>;

/**
 * Una riga d'inbox pronta per la UI. `text` è già localizzato nella lingua del
 * destinatario e `actions` è calcolato (kind + stato del job + ruolo di chi
 * guarda): il client non deve dedurre nulla, disegna quello che riceve.
 *
 * `url` è ASSENTE quando il payload dell'evento non ne contiene uno
 * utilizzabile: la card si mostra senza link invece di portare l'utente su
 * `undefined`.
 */
export const inboxItemSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  status: inboxStatusSchema,
  text: z.string(),
  url: z.string().optional(),
  actions: z.array(inboxActionSchema),
  /**
   * Presente SOLO sul kind `job.awaiting_input`, e solo se il payload
   * dell'evento è leggibile: è ciò che permette alla card di offrire i bottoni
   * delle opzioni invece del solo testo.
   */
  question: inboxQuestionSchema.optional(),
  projectId: z.uuid().nullable(),
  ticketId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
  snoozedUntil: z.iso.datetime().nullable(),
  handledAt: z.iso.datetime().nullable(),
  handledBy: handledBySchema.nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

/** Pagina dell'inbox: `nextCursor` null quando non c'è altro da leggere. */
export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
});
export type InboxPage = z.infer<typeof inboxPageSchema>;

/**
 * Numero di notifiche non lette (la campanella). Oggetto e non numero nudo per
 * poter crescere senza rompere il client.
 */
export const unreadCountSchema = z.object({ count: z.number().int() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;

/**
 * Esito di `POST /api/inbox/:id/snooze`. `nullable` per difesa: la scadenza la
 * calcola il DB e c'è sempre, ma il contratto non deve poter far esplodere la
 * serializzazione se un giorno mancasse.
 */
export const snoozeResultSchema = z.object({ snoozedUntil: z.iso.datetime().nullable() });
export type SnoozeResult = z.infer<typeof snoozeResultSchema>;

/**
 * Esito di un'azione DECISIONALE (`POST /api/inbox/:id/actions/:action`).
 *
 * `changedNotificationIds` è la ragion d'essere della risposta: una decisione
 * chiude in blocco TUTTE le copie della stessa notifica (anche di altri
 * utenti), e il client aggiorna quelle righe senza ricaricare l'inbox.
 * `jobId` è presente solo quando l'azione ha toccato un job (approva/rilancia).
 */
export const inboxActionResultSchema = z.object({
  kind: notificationKindSchema,
  jobId: z.uuid().optional(),
  changedNotificationIds: z.array(z.uuid()),
});
export type InboxActionResult = z.infer<typeof inboxActionResultSchema>;

/**
 * Corpo d'errore delle rotte d'AZIONE dell'inbox: l'errore standard
 * `{ code, message }` (stessa forma di `errorSchema` lato server) più il DATO
 * che serve alla UI per dire "l'ha già gestita X" invece di un generico
 * conflitto. Il nome è sul MITTENTE (le rotte azione), non sul singolo caso
 * `already_handled`: lo stesso body copre tutti i loro errori.
 *
 * `handledBy` è opzionale perché lo stesso 409 copre anche `job_in_flight` e
 * `plan_not_pending`, che non hanno un autore da nominare; `code` è opzionale
 * perché gli errori di validazione Zod non lo valorizzano.
 */
export const inboxActionErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  handledBy: handledBySchema.optional(),
});
export type InboxActionError = z.infer<typeof inboxActionErrorSchema>;

/**
 * Progetti seguiti dall'utente: è l'insieme COMPLETO, sia in lettura che in
 * scrittura (il PUT sostituisce, non aggiunge).
 */
export const projectFollowsSchema = z.object({ projectIds: z.array(z.uuid()) });
export type ProjectFollows = z.infer<typeof projectFollowsSchema>;

/**
 * Preferenze di notifica dell'utente. Oggi un solo canale opzionale: il DM
 * Slack (`users.notify_slack_dm`). L'inbox in-app non è disattivabile — è la
 * superficie primaria, non un canale.
 */
export const notificationPrefsSchema = z.object({ slackDm: z.boolean() });
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/**
 * Le preferenze più il contesto che serve alla UI per renderle: senza identità
 * Slack collegata (`users.slack_user_id`) il toggle del DM va mostrato
 * disabilitato, perché anche acceso il canale resterebbe muto.
 */
export const notificationPrefsViewSchema = notificationPrefsSchema.extend({
  slackLinked: z.boolean(),
});
export type NotificationPrefsView = z.infer<typeof notificationPrefsViewSchema>;
