import { z } from "zod";
import { ticketPrioritySchema } from "./ticket.js";

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
  /**
   * OPZIONALE, e non per lassismo: il `round` conta i giri di `ask_user` sullo
   * stesso job, ed è quindi specifico della domanda dell'agente. Gli altri kind
   * con opzioni (il pulse proattivo, che di job non ne ha) hanno la stessa
   * forma senza averne uno. Chi ne ha uno lo porta ancora, e
   * {@link ticketQuestionSchema} lo ri-stringe a obbligatorio.
   */
  round: z.number().int().optional(),
  question: z.string(),
  options: z.array(agentQuestionOptionSchema),
  recommendedIndex: z.number().int().optional(),
  allowFreeText: z.boolean(),
});
export type InboxQuestion = z.infer<typeof inboxQuestionSchema>;

/**
 * Una PROPOSTA del pulse: la voce di backlog dietro l'opzione omonima, più i
 * metadati su cui il ranking l'ha ordinata.
 *
 * `urgency`/`effort` sono nullable come le colonne che li portano (una voce
 * appena nata può non averli ancora). `backlogItemId` è ciò che permette a un
 * consumatore non-visuale — il tool MCP — di dire *quale voce* è la proposta
 * numero 2, senza rileggere il payload della notifica.
 */
export const inboxPulseProposalSchema = z.object({
  backlogItemId: z.uuid(),
  title: z.string(),
  urgency: ticketPrioritySchema.nullable(),
  effort: z.number().int().nullable(),
  /** La voce ha già la sezione "## Analisi tecnica" del deep dive. */
  hasAnalysis: z.boolean(),
});
export type InboxPulseProposal = z.infer<typeof inboxPulseProposalSchema>;

/**
 * IL CONTORNO DEL PULSE: ciò che la sua card deve poter dire e che
 * {@link inboxQuestionSchema} non porta — di quale progetto si parla, da quanti
 * giorni è fermo, e quali voci di backlog stanno dietro le opzioni.
 *
 * Blocco a parte e non campi sparsi su {@link inboxItemSchema}: i kind sono
 * tredici e uno solo ha queste informazioni: raccoglierle qui le tiene
 * assenti-o-complete invece di spargere quattro campi opzionali che nessun
 * altro kind valorizza. E non dentro `question.options[]`, che è lo schema
 * CONDIVISO con la domanda dell'agente e con la pagina ticket, dove un
 * `backlogItemId` non significherebbe nulla.
 *
 * ⚠️ **`proposals[i]` DESCRIVE `question.options[i]`**. L'indice che l'utente
 * sceglie viaggia su `options` e agisce su `proposals` (è la lista che
 * `proceedWithProposal` indicizza per trovare la voce da convertire): un
 * disallineamento non darebbe nessun errore, farebbe partire la voce
 * sbagliata. Chi popola questo blocco DEVE quindi verificare l'allineamento —
 * lo fa il recinto per-item di `listInbox`, che in caso di dubbio omette il
 * blocco invece di mentire.
 *
 * OPZIONALE come `question`, e per la stessa ragione: su un payload che il
 * server non ha saputo rileggere la card resta intera e senza contorno.
 */
export const inboxPulseSchema = z.object({
  projectName: z.string(),
  /** Da quanti giorni il progetto non ha lavoro in corso. */
  idleDays: z.number().int(),
  proposals: z.array(inboxPulseProposalSchema),
});
export type InboxPulse = z.infer<typeof inboxPulseSchema>;

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
  /**
   * RI-STRETTO a obbligatorio: sulla card d'inbox il `round` è opzionale perché
   * lì la stessa forma serve anche a kind che non hanno giri (il pulse), ma qui
   * la sorgente è la colonna `agent_questions.round`, che c'è SEMPRE. Allentare
   * anche questo contratto — che non ne ha bisogno — costringerebbe la pagina
   * ticket a difendersi da un'assenza impossibile.
   */
  round: z.number().int(),
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
   * Presente solo sui kind CON OPZIONI (`KINDS_WITH_OPTIONS` di
   * `@stubwise/notifications`: la domanda dell'agente e il pulse proattivo), e
   * solo se il payload dell'evento è leggibile: è ciò che permette alla card di
   * offrire i bottoni delle opzioni invece del solo testo.
   */
  question: inboxQuestionSchema.optional(),
  /**
   * Il contorno del pulse (progetto, giorni di fermo, voci dietro le opzioni):
   * presente solo sul kind `project.pulse`, e solo se il payload è leggibile e
   * ALLINEATO a `question.options` — vedi {@link inboxPulseSchema}.
   */
  pulse: inboxPulseSchema.optional(),
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
 *
 * `ticketId`/`ticketNumber` compaiono solo sul "Procedi" del pulse
 * (`project.pulse`), l'unica azione che CREA un ticket: la proposta scelta
 * diventa un ticket `task` e la card lo linka subito ("▶️ Avviato: #42") invece
 * di mandare l'utente a cercarlo.
 */
export const inboxActionResultSchema = z.object({
  kind: notificationKindSchema,
  jobId: z.uuid().optional(),
  ticketId: z.uuid().optional(),
  ticketNumber: z.number().int().positive().optional(),
  /**
   * Come è NATO il run del "Procedi" — `runStatus` e non `status`, che su una
   * riga d'inbox significa già un'altra cosa (aperta/gestita/rinviata).
   *
   * Sono due esperienze diverse e le superfici le dicono con parole diverse:
   * col piano ereditato dalla voce il job è GIÀ fermo sul gate
   * (`awaiting_plan_approval`), senza piano parte `queued` e sarà il worker a
   * fermarsi a piano pronto. Promettere il primo stato nel secondo caso
   * manderebbe l'utente a cercare un'approvazione che ancora non esiste.
   *
   * Presente solo sul "Procedi" riuscito del pulse: nessun'altra azione avvia
   * un run da zero.
   */
  runStatus: z.enum(["queued", "awaiting_plan_approval"]).optional(),
  changedNotificationIds: z.array(z.uuid()),
});
export type InboxActionResult = z.infer<typeof inboxActionResultSchema>;

/**
 * Corpo d'errore delle rotte d'AZIONE dell'inbox: l'errore standard
 * `{ code, message }` (stessa forma di `errorSchema` lato server) più i DATI che
 * servono alla UI per dire cosa è successo invece di un generico conflitto. Il
 * nome è sul MITTENTE (le rotte azione), non sul singolo caso: lo stesso body
 * copre tutti i loro errori.
 *
 * `handledBy` risponde alla domanda "chi l'ha già fatto?" (`already_handled`);
 * `ticketId`/`ticketNumber` a "cosa è comunque riuscito?" — li porta il 409
 * `run_not_started` del "Procedi" del pulse, l'unico errore che lascia dietro
 * di sé qualcosa di utile: il ticket è nato, il run no, e la card deve poterlo
 * LINKARE per farlo lanciare a mano. Senza dati strutturati quel link si
 * potrebbe costruire solo estraendo il numero dal `message`, che è inglese e
 * non è contratto.
 *
 * Tutti opzionali: lo stesso 409 copre anche `job_in_flight`, `plan_not_pending`
 * e `proposal_stale`, che non hanno né un autore da nominare né un ticket da
 * offrire; `code` lo è perché gli errori di validazione Zod non lo valorizzano.
 */
export const inboxActionErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  handledBy: handledBySchema.optional(),
  ticketId: z.uuid().optional(),
  ticketNumber: z.number().int().positive().optional(),
});
export type InboxActionError = z.infer<typeof inboxActionErrorSchema>;

/**
 * Progetti seguiti dall'utente: è l'insieme COMPLETO, sia in lettura che in
 * scrittura (il PUT sostituisce, non aggiunge).
 */
export const projectFollowsSchema = z.object({ projectIds: z.array(z.uuid()) });
export type ProjectFollows = z.infer<typeof projectFollowsSchema>;

/**
 * Preferenze di notifica dell'utente: i canali OPZIONALI su cui recapitare —
 * il DM Slack (`users.notify_slack_dm`) e la push sui device mobili
 * (`users.notify_push`). L'inbox in-app non è disattivabile: è la superficie
 * primaria, non un canale.
 *
 * Questa è la forma in LETTURA: i canali ci sono tutti, sempre. Un client deve
 * poter sapere lo stato completo senza indovinare i campi assenti — ed è per
 * questo che non è lo stesso schema del body di scrittura, che invece è una
 * patch (vedi {@link notificationPrefsUpdateSchema}).
 */
export const notificationPrefsSchema = z.object({
  slackDm: z.boolean(),
  push: z.boolean(),
});
/**
 * Non ha consumatori diretti: web e api-client usano `…Update` (scrittura) e
 * `…View` (lettura). Resta esportato perché è la forma di lettura da cui la
 * view deriva, e nominarla è ciò che tiene distinte le due semantiche.
 */
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/**
 * Body di `PUT /api/me/notification-prefs`: una PATCH, non una sostituzione.
 * I campi presenti si applicano, gli assenti restano come sono.
 *
 * Tutto opzionale per una ragione precisa: l'app mobile NON viaggia
 * nell'immagine del server, e una versione installata mesi fa continua a
 * mandare il body che conosceva. Se i campi fossero obbligatori, aggiungere un
 * canale renderebbe 400 ogni richiesta delle app vecchie — un cambio rompente
 * in SCRITTURA, speculare a un campo tolto da una risposta. Con la patch,
 * aggiungere un canale è additivo in entrambe le direzioni.
 *
 * Un body vuoto `{}` è una patch senza campi, quindi un no-op legittimo (204),
 * non un errore: non c'è niente di ambiguo da segnalare a chi lo manda, e un
 * 400 costringerebbe ogni client a un controllo che il server sa già fare.
 * Resta invece 400 un campo presente col tipo sbagliato.
 *
 * `.strict()` non è un'eccezione ma il precedente del repo per questa forma:
 * `apps/server/src/routes/saved-views.ts` fa la stessa cosa (tutti i campi
 * opzionali + strict) per la stessa ragione, e `backlog.ts` ne ha altri sei.
 * Su una patch lo strip è pericoloso in un modo che su un body a campi
 * obbligatori non è: con tutti i campi opzionali, `{ pussh: false }` sarebbe
 * ripulito a
 * `{}` e risponderebbe 204, cioè un typo indistinguibile da un successo.
 * Finché i campi erano obbligatori quel caso dava 400 per un effetto
 * collaterale (mancava `slackDm`); rendendo il body una patch quella
 * protezione è sparita, e `.strict()` la rimette di proposito. La chiave
 * sconosciuta diventa un 400 con dentro il nome che non conosciamo, che è
 * l'informazione che serve a chi ha sbagliato a scrivere.
 */
export const notificationPrefsUpdateSchema = notificationPrefsSchema.partial().strict();
export type NotificationPrefsUpdate = z.infer<typeof notificationPrefsUpdateSchema>;

/**
 * Le preferenze più il contesto che serve alla UI per renderle: senza identità
 * Slack collegata (`users.slack_user_id`) il toggle del DM va mostrato
 * disabilitato, perché anche acceso il canale resterebbe muto.
 */
export const notificationPrefsViewSchema = notificationPrefsSchema.extend({
  slackLinked: z.boolean(),
});
export type NotificationPrefsView = z.infer<typeof notificationPrefsViewSchema>;

/**
 * Tetto del token push, in BYTE della codifica UTF-8.
 *
 * Il numero non è scelto per stile: la colonna `device_tokens.token` è
 * `unique`, quindi ha dietro un indice btree, e Postgres rifiuta una voce
 * d'indice sopra **2704 byte** con `index row size … exceeds btree version 4
 * maximum 2704` (SQLSTATE 54000). Un token che passa la validazione e sfonda
 * quel limite non dà un 400: dà un **500**, perché l'errore arriva
 * dall'insert. La validazione deve quindi stare comodamente SOTTO 2704, non
 * "vicino": 1024 byte sono 5× un token FCM (~163 caratteri) e 16× uno APNs (64
 * esadecimali), cioè tutto il margine che serve senza avvicinarsi al muro.
 *
 * ⚠️ **In byte, non in caratteri, e la differenza non è pedanteria.** `.max()`
 * di Zod conta unità UTF-16, e un carattere BMP fuori ASCII (CJK, per dirne
 * una) è 1 unità ma 3 byte: con un tetto di 1024 CARATTERI si passa la
 * validazione con 3072 byte e si torna dritti al 500. Misurato: 1024 CJK
 * casuali = 3072 byte → 500, e falliscono anche 900 caratteri (2700 byte),
 * perché il limite è sulla voce d'indice INTERA, non sul solo valore, e
 * l'intestazione della tupla mangia i byte che mancano.
 */
const PUSH_TOKEN_MAX_BYTES = 1024;

/**
 * Il token del servizio di push del sistema operativo (APNs o FCM), dichiarato
 * una volta sola perché lo usano sia la registrazione sia la cancellazione: se
 * i due tetti divergessero, esisterebbe un token registrabile e non
 * cancellabile.
 *
 * Il tetto in caratteri c'è per dare un errore leggibile nel caso normale (un
 * token è ASCII, quindi un byte per carattere e i due limiti coincidono); il
 * controllo in byte è quello che PROTEGGE, ed è l'unico che regge sul testo
 * multibyte. Il perché del numero sta su {@link PUSH_TOKEN_MAX_BYTES}.
 *
 * ESPORTATO perché lo riusa anche il contratto del relay push
 * (`pushRelayTokenSchema` in `./push.ts`): un token che passa la registrazione
 * deve essere spedibile, e l'unico modo di garantirlo è che sia lo STESSO
 * schema, non due tetti tenuti allineati a mano.
 */
// Istanziato una volta sola: il refine gira su ogni registrazione.
const tokenByteLength = new TextEncoder();

export const pushTokenSchema = z
  .string()
  .min(1)
  .max(PUSH_TOKEN_MAX_BYTES)
  .refine((value) => tokenByteLength.encode(value).length <= PUSH_TOKEN_MAX_BYTES, {
    message: `token too long: max ${PUSH_TOKEN_MAX_BYTES} bytes`,
  });

/**
 * Body di `PUT /api/me/devices`: la registrazione del token push di UN device.
 *
 * `token` lo assegna il dispositivo, non noi, e può cambiare — l'app lo
 * ri-registra a ogni avvio e a ogni rotazione. È lui la chiave della riga
 * (unique in `device_tokens`), non l'utente: la registrazione è quindi un
 * UPSERT idempotente, non una creazione.
 *
 * Da quella unique globale discende che **chi conosce il token di un device
 * altrui se lo può intestare**, e vale la pena essere precisi sulla DIREZIONE
 * del danno, perché l'intuizione la sbaglia: non è «leggo le notifiche
 * altrui». La riga mappa token → utente, quindi intestandomi il token della
 * vittima ottengo che **le MIE notifiche arrivano sul SUO telefono** e lei
 * smette di riceverne. È un disservizio per lei più una fuga dei MIEI dati
 * verso uno schermo che non controllo — un'aggressione poco attraente, e
 * raggiungibile solo da chi il token ce l'ha già (dal telefono, dal nostro DB,
 * o dai log: per questo il token non sta MAI in un path, vedi
 * {@link deviceDeletionSchema}). In cambio, senza il passaggio di proprietà,
 * il telefono su cui l'utente A esce e B entra sbatterebbe contro la unique e
 * non riceverebbe MAI più una push, senza nessun errore visibile. Il baratto
 * è accettato con cognizione, non per inerzia.
 *
 * `platform` è speculare al CHECK `device_tokens_platform_chk` di
 * `packages/db`. Le due liste non hanno un guardiano dedicato che le confronti
 * — `@stubwise/shared` finisce nel bundle browser e non può importare
 * `@stubwise/db` — ma la divergenza pericolosa (un valore in più QUI, che il
 * DB rifiuterebbe con un 23514 a runtime) è fermata dal typecheck: la rotta
 * passa `request.body.platform` a un insert Drizzle tipato sui valori del
 * CHECK, e un valore in più non ci entra. Verificato, non supposto.
 *
 * `appVersion` è OPZIONALE, e non solo perché la colonna è nullable: è il
 * modello dei campi che verranno. L'app mobile non viaggia nell'immagine del
 * server, e un campo NUOVO e OBBLIGATORIO in questo body renderebbe 400 ogni
 * registrazione delle versioni già installate — cioè quei telefoni
 * smetterebbero di ricevere push al primo deploy. L'invariante «solo cambi
 * additivi» vale anche in SCRITTURA: ogni campo aggiunto qui dopo il primo
 * rilascio dell'app nasce opzionale.
 *
 * NON è `.strict()`, al contrario di {@link notificationPrefsUpdateSchema}, e
 * la differenza non è una svista: là TUTTI i campi sono opzionali, quindi lo
 * strip trasformerebbe `{ pussh: false }` in `{}` e un typo diventerebbe un
 * 204 bugiardo. Qui i campi che contano sono obbligatori — un typo su
 * `platform` o `token` resta un 400 per campo mancante — e l'unico strip
 * possibile è su `appVersion`, che è un dato diagnostico: perderlo non fa
 * credere a nessuno di aver salvato qualcosa che non è stato salvato. In
 * cambio, un'app più nuova del server che mandasse un campo ancora ignoto
 * continua a registrarsi invece di prendere un 400.
 */
export const deviceRegistrationSchema = z.object({
  platform: z.enum(["ios", "android"]),
  token: pushTokenSchema,
  appVersion: z.string().min(1).max(64).optional(),
});
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;

/**
 * Body di `POST /api/me/devices/delete`: il logout dell'app.
 *
 * ⚠️ **Il token sta nel BODY, e la rotta è un `POST` con `/delete` nel path,
 * non un `DELETE /api/me/devices/:token`.** Il verbo scomodo è deliberato e
 * non va "sistemato": il server gira con `logger: true` e pino scrive l'URL
 * intero di ogni richiesta, quindi un token nel path finirebbe in chiaro nei
 * log — dove ha molti più lettori del DB, e da dove chi lo legge se lo può
 * intestare (vedi il punto 2 di {@link deviceRegistrationSchema}). Il body non
 * viene loggato. La motivazione per esteso, con la riga di log reale, sta sul
 * docblock della rotta in `apps/server/src/routes/me-prefs.ts`.
 *
 * Un oggetto con un campo solo e non una stringa nuda: è la forma che può
 * crescere senza rompere le app già installate.
 */
export const deviceDeletionSchema = z.object({ token: pushTokenSchema });
export type DeviceDeletion = z.infer<typeof deviceDeletionSchema>;
