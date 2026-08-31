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
 * lato server); `snooze` e `handled` hanno rotte dedicate; solo le tre
 * decisionali passano da `POST /api/inbox/:id/actions/:action`.
 */
export const inboxActionSchema = z.enum([
  "approve_plan",
  "reject_plan",
  "relaunch",
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
export const inboxDecisionActionSchema = z.enum(["approve_plan", "reject_plan", "relaunch"]);
export type InboxDecisionAction = z.infer<typeof inboxDecisionActionSchema>;

/** Durate di rinvio ammesse dallo snooze. */
export const snoozeUntilSchema = z.enum(["1h", "tomorrow", "3d"]);
export type SnoozeUntil = z.infer<typeof snoozeUntilSchema>;

/** Chi ha chiuso una notifica: l'id per la UI, l'email per dirlo a parole. */
export const handledBySchema = z.object({ id: z.uuid(), email: z.string() });
export type HandledBy = z.infer<typeof handledBySchema>;

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
 * Corpo del 409 delle rotte d'azione: l'errore standard `{ code, message }`
 * (stessa forma di `errorSchema` lato server) più il DATO che serve alla UI per
 * dire "l'ha già gestita X" invece di un generico conflitto.
 *
 * `handledBy` è opzionale perché lo stesso 409 copre anche `job_in_flight` e
 * `plan_not_pending`, che non hanno un autore da nominare; `code` è opzionale
 * perché gli errori di validazione Zod non lo valorizzano.
 */
export const alreadyHandledErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  handledBy: handledBySchema.optional(),
});
export type AlreadyHandledError = z.infer<typeof alreadyHandledErrorSchema>;

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
