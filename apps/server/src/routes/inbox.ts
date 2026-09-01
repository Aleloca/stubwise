import {
  ANSWER_TEXT_MAX_CHARS,
  answerBodySchema,
  inboxActionErrorSchema,
  inboxActionResultSchema,
  inboxActionSchema,
  inboxDecisionActionSchema,
  inboxPageSchema,
  inboxStatusSchema,
  notificationKindSchema,
  snoozeResultSchema,
  snoozeUntilSchema,
  unreadCountSchema,
  type AnswerBody,
  type InboxAction,
  type InboxDecisionAction,
  type InboxItem,
} from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { publicUrlOrUndefined } from "../ingest/shared.js";
import {
  executeAction,
  listInbox,
  markRead,
  unreadCount,
  type ExecuteActionResult,
  type InboxItem as ServiceInboxItem,
} from "../services/inbox.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Rotte dell'INBOX, sotto `/api/inbox`. Sono adattatori SOTTILI su
 * `services/inbox.ts`: qui non vive nessuna regola di permesso né di stato — il
 * servizio è l'unico arbitro, perché la stessa decisione deve valere identica
 * anche presa dai bottoni di Slack (Task 10), che non passano da HTTP.
 *
 * Compiti di questo strato, e solo questi: autenticare, validare la richiesta,
 * tradurre gli errori tipizzati del servizio in status code e convertire le
 * `Date` in ISO 8601.
 *
 * FORMA DELLE ROTTE: `read`, `snooze` e `handled` hanno una rotta DEDICATA e
 * NON passano da `/actions/:action`, benché il servizio le tratti come azioni.
 * Sono igiene dell'inbox (il client le chiama continuamente, anche in massa) e
 * meritano un URL diretto con la propria risposta; `/actions/:action` resta la
 * superficie delle sole azioni DECISIONALI — `approve_plan`, `reject_plan`,
 * `relaunch` — cioè quelle che toccano un job e chiudono le notifiche di tutti.
 * Chiedere `snooze` (o `open`) da lì è un errore del client: 400 `invalid_action`.
 */

/**
 * Le sole azioni accettate da `/actions/:action`, DERIVATE dallo schema
 * condiviso: l'elenco vive in `@stubwise/shared` (dove lo legge anche il
 * client) e qui non si ripete — una lista sola, impossibile da disallineare.
 */
const DECISION_ACTIONS = new Set<InboxAction>(inboxDecisionActionSchema.options);

/** True se l'azione è decisionale (e restringe il tipo per il servizio). */
function isDecision(action: InboxAction): action is InboxDecisionAction {
  return DECISION_ACTIONS.has(action);
}

const idParamsSchema = z.object({ id: z.uuid() });

/** Risposte d'errore comuni alle azioni: mappa completa di `ExecuteActionError`. */
const actionErrorResponses = {
  400: errorSchema,
  404: errorSchema,
  // Errore standard PIÙ `handledBy`: il 409 di `already_handled` deve poter
  // dire CHI ha gestito la notifica (vedi `sendActionError`).
  409: inboxActionErrorSchema,
  ...authErrorResponses,
} as const;

/**
 * Proiezione HTTP di una riga d'inbox: gli stessi campi del servizio con le date
 * in ISO 8601. Campi elencati esplicitamente (mai lo spread della riga), come in
 * `toPatView`: quello che non è nel contratto non deve poter sfuggire.
 */
function toInboxItemView(item: ServiceInboxItem): InboxItem {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    text: item.text,
    // Assente (non null) quando il payload non porta un URL utilizzabile.
    ...(item.url === undefined ? {} : { url: item.url }),
    actions: item.actions,
    // Assente (non null) su tutti i kind che non sono una domanda dell'agente,
    // e sulle domande il cui payload non è più leggibile.
    ...(item.question === undefined ? {} : { question: item.question }),
    projectId: item.projectId,
    ticketId: item.ticketId,
    jobId: item.jobId,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt?.toISOString() ?? null,
    snoozedUntil: item.snoozedUntil?.toISOString() ?? null,
    handledAt: item.handledAt?.toISOString() ?? null,
    handledBy: item.handledBy,
  };
}

/**
 * Traduce l'esito negativo di `executeAction` nella risposta HTTP.
 *
 * Unico punto di mappatura per TUTTE le rotte azione: `snooze` e `handled`
 * passano dallo stesso servizio delle decisioni e possono fallire per gli
 * stessi motivi (`not_found`, `already_handled`), quindi devono rispondere
 * identico. Lo switch è esaustivo su `ExecuteActionError`: un errore nuovo nel
 * servizio non compila finché non gli si sceglie uno status.
 */
function sendActionError(
  reply: FastifyReply,
  result: Extract<ExecuteActionResult, { ok: false }>,
): FastifyReply {
  switch (result.error) {
    case "not_found":
      // Anche per la notifica di un ALTRO utente: non se ne rivela l'esistenza.
      return apiError(reply, 404, "not_found", "Notification not found");
    case "forbidden":
      return apiError(reply, 403, "forbidden", "Administrators only");
    case "invalid_action":
      return apiError(reply, 400, "invalid_action", "Action not available on this notification");
    case "already_handled":
      // 409 con `handledBy`: alla UI serve dire "l'ha già fatto X", non un
      // generico conflitto. `apiError` non veicola dati, quindi si compone qui.
      return reply.code(409).send({
        code: "already_handled",
        message: result.handledBy
          ? `Already handled by ${result.handledBy.email}`
          : "Already handled",
        ...(result.handledBy ? { handledBy: result.handledBy } : {}),
      });
    case "job_in_flight":
      return apiError(
        reply,
        409,
        "job_in_flight",
        `A job for this ticket is already ${result.jobStatus ?? "running"}`,
      );
    case "plan_not_pending":
      return apiError(reply, 409, "plan_not_pending", "No plan pending approval");
    case "invalid_answer":
      // 400 e non 409: la risposta è malformata (indice fuori dalle opzioni,
      // testo libero non ammesso), non in conflitto con lo stato.
      return apiError(reply, 400, "invalid_answer", "Invalid answer for this question");
    case "question_not_pending":
      return apiError(reply, 409, "question_not_pending", "No question pending an answer");
    case "proposal_stale":
      // 409: la proposta esiste ancora sulla card ma non è più prendibile
      // (voce già convertita, archiviata o sparita). È un conflitto di stato,
      // non una richiesta malformata.
      return apiError(reply, 409, "proposal_stale", "This proposal is no longer available");
    case "run_not_started":
      // Riuscita a metà: il ticket c'è (e il numero lo dice), il run no. 409
      // perché c'è qualcosa da fare — aprirlo e lanciarlo a mano — non un
      // errore del client da correggere.
      return apiError(
        reply,
        409,
        "run_not_started",
        result.ticketNumber === undefined
          ? "Ticket created, but the run did not start"
          : `Ticket #${result.ticketNumber} created, but the run did not start`,
      );
  }
}

export async function inboxRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * Pagina dell'inbox dell'utente autenticato. Il `status` di default è `open`:
   * l'inbox è la lista di ciò che resta da smaltire, gli altri stati sono viste
   * di consultazione. `text` è reso nella lingua dell'UTENTE (non in quella dei
   * contenuti): è una frase che legge lui.
   */
  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: z.object({
          status: inboxStatusSchema.default("open"),
          projectId: z.uuid().optional(),
          // Filtro per TIPO di evento, dallo schema condiviso: un kind fuori
          // enum è un 400 esplicito e non una lista vuota — la differenza è
          // tutto per chi debugga un client che chiede un taglio solo
          // (`?status=open&kind=project.pulse`, cioè le proposte del pulse).
          kind: notificationKindSchema.optional(),
          // Default e tetto ripetuti dal servizio (che li riapplica comunque
          // con un clamp): qui servono a rifiutare 0 o 101 con un 400 esplicito
          // invece di accettarli in silenzio e restituire un'altra dimensione.
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
        }),
        response: { 200: inboxPageSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { status, projectId, kind, limit, cursor } = request.query;
      const result = await listInbox(app.db, {
        userId: request.user!.id,
        status,
        limit,
        lang: request.user!.language,
        ...(projectId ? { projectId } : {}),
        ...(kind === undefined ? {} : { kind }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.invalidCursor) {
        return apiError(reply, 400, "invalid_cursor", "Invalid pagination cursor");
      }
      return { items: result.items.map(toInboxItemView), nextCursor: result.nextCursor };
    },
  );

  /**
   * Numero della campanella. Lettura PURA (non riapre gli snooze scaduti, li
   * conta e basta): la SPA la interroga in polling da ogni scheda aperta.
   */
  app.get(
    "/unread-count",
    {
      preHandler: requireAuth,
      schema: {
        response: { 200: unreadCountSchema, ...authErrorResponses },
      },
    },
    async (request) => ({ count: await unreadCount(app.db, request.user!.id) }),
  );

  /**
   * Segna la notifica come letta. Idempotente (`read_at` è la PRIMA apertura),
   * quindi 204 anche se lo era già: il client la chiama a ogni scroll.
   */
  app.post(
    "/:id/read",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await markRead(app.db, {
        notificationId: request.params.id,
        userId: request.user!.id,
      });
      if (!result.ok) return apiError(reply, 404, "not_found", "Notification not found");
      return reply.code(204).send(null);
    },
  );

  /**
   * Rinvia la notifica: sparisce dall'inbox aperta fino alla scadenza, che si
   * restituisce perché la UI possa dirlo ("torna fra un'ora") senza ricaricare.
   */
  app.post(
    "/:id/snooze",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: z.object({ until: snoozeUntilSchema }),
        response: { 200: snoozeResultSchema, ...actionErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await executeAction(app.db, {
        notificationId: request.params.id,
        action: "snooze",
        actor: request.user!,
        payload: { until: request.body.until },
      });
      if (!result.ok) return sendActionError(reply, result);
      return { snoozedUntil: result.snoozedUntil?.toISOString() ?? null };
    },
  );

  /**
   * Archivia la notifica. È igiene PERSONALE: chiude la sola riga di chi chiama,
   * mai le copie degli altri destinatari (quelle le chiude una decisione).
   */
  app.post(
    "/:id/handled",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), ...actionErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await executeAction(app.db, {
        notificationId: request.params.id,
        action: "handled",
        actor: request.user!,
      });
      if (!result.ok) return sendActionError(reply, result);
      return reply.code(204).send(null);
    },
  );

  /**
   * Azione DECISIONALE su una notifica: approva o rifiuta il piano, rilancia il
   * job. Va a buon fine solo se il kind la offre, il ruolo la consente e lo
   * stato ATTUALE del job la ammette — tre "no" distinti, con tre status
   * diversi (400/403/409): è il servizio a stabilirli, qui si traducono.
   *
   * In caso di successo si restituiscono anche gli id delle righe il cui stato
   * è cambiato: la decisione chiude in blocco tutte le copie della stessa
   * notifica (anche di altri utenti), e la UI le aggiorna senza ricaricare.
   */
  app.post(
    "/:id/actions/:action",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema.extend({ action: inboxActionSchema }),
        // nullish (non optional): fastify-type-provider-zod passa `null` quando
        // la POST arriva senza corpo, e un `.optional()` puro lo rifiuterebbe.
        // `instructions` serve solo a reject_plan (diventa un commento del team);
        // `optionIndex`/`text` solo ad `answer`. Il corpo è LARGO qui — una sola
        // rotta serve quattro azioni con parametri diversi — e la forma stretta
        // della risposta (esattamente uno dei due campi) si applica sotto, solo
        // sul ramo che la riguarda.
        body: z
          .object({
            instructions: z.string().max(4000).optional(),
            optionIndex: z.number().int().nonnegative().optional(),
            text: z.string().max(ANSWER_TEXT_MAX_CHARS).optional(),
          })
          .nullish(),
        response: { 200: inboxActionResultSchema, ...actionErrorResponses },
      },
    },
    async (request, reply) => {
      const { id, action } = request.params;
      // `snooze`/`handled`/`open` sono nell'enum delle azioni ma hanno la loro
      // rotta (o sono un link): da qui sono una richiesta senza senso.
      if (!isDecision(action)) {
        return apiError(reply, 400, "invalid_action", "Use the dedicated route for this action");
      }
      const instructions = request.body?.instructions;
      // La risposta a una domanda dell'agente ha un contratto suo (esattamente
      // uno fra opzione e testo), che il corpo largo della rotta non esprime:
      // si valida qui, sul solo ramo `answer`, con lo schema condiviso. Un
      // corpo che non lo rispetta è `invalid_answer` (400) come se l'avesse
      // rifiutato il servizio: per il client è lo stesso errore.
      let answer: AnswerBody | undefined;
      if (action === "answer") {
        const parsed = answerBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return apiError(
            reply,
            400,
            "invalid_answer",
            "Provide exactly one of optionIndex or text",
          );
        }
        answer = parsed.data;
      }
      const payload = answer
        ? { answer }
        : instructions === undefined
          ? undefined
          : { instructions };
      // Serve ai link delle notifiche che `startRun` emette rilanciando.
      const publicUrl = publicUrlOrUndefined(app);
      const result = await executeAction(app.db, {
        notificationId: id,
        action,
        actor: request.user!,
        ...(payload ? { payload } : {}),
        ...(publicUrl ? { publicUrl } : {}),
      });
      if (!result.ok) return sendActionError(reply, result);
      return {
        kind: result.kind,
        ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
        // Solo il "Procedi" del pulse crea un ticket: sugli altri esiti i due
        // campi restano ASSENTI (non null), come `url` e `question` altrove.
        ...(result.ticketId === undefined ? {} : { ticketId: result.ticketId }),
        ...(result.ticketNumber === undefined ? {} : { ticketNumber: result.ticketNumber }),
        changedNotificationIds: result.changedNotificationIds,
      };
    },
  );
}
