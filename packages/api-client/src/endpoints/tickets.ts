import {
  aiJobSchema,
  answerQuestionResultSchema,
  planDecisionResultSchema,
  releaseResultSchema,
  requestCorrectionResponseSchema,
  runAiResultSchema,
  ticketCommentSchema,
  ticketDetailSchema,
  ticketPageSchema,
  ticketSchema,
  ticketActivityEntrySchema,
  ticketHistorySchema,
  ticketQuestionsSchema,
} from "@stubwise/shared";
import type {
  Reader,
  AiJob,
  AnswerBody,
  AnswerQuestionResult,
  PlanDecisionResult,
  ReleaseResult,
  RequestCorrectionBody,
  RequestCorrectionResponse,
  RunAiBody,
  RunAiResult,
  Ticket,
  TicketActivityEntry,
  TicketComment,
  TicketDetail,
  TicketHistory,
  TicketPage,
  TicketPriority,
  TicketQuestion,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/tickets`. */
export interface TicketFilters {
  projectId?: string;
  status?: TicketStatus;
  /**
   * Più stati insieme (serializzati come lista separata da virgole). Se
   * valorizzato prevale su `status`; un `statuses=` VUOTO è un 400, quindi una
   * lista vuota non viene mandata affatto.
   */
  statuses?: TicketStatus[];
  type?: TicketType;
  priority?: TicketPriority;
  milestoneId?: string;
  q?: string;
}

/**
 * Campi modificabili di un ticket (`PATCH /api/tickets/:id`), tutti
 * FACOLTATIVI: è una patch, non una sostituzione — ciò che non si manda resta
 * com'è. Verso un'app che si aggiorna dagli store è anche l'unica forma
 * sicura (vedi il docblock di `ApiRequest`: un campo reso obbligatorio in un
 * corpo rompe i client vecchi come un campo rimosso da una risposta).
 *
 * `assigneeId` e `milestoneId` distinguono "non toccare" (assente) da
 * "azzera" (`null`); `title`, `body` e `type` il server li accetta ma nessuna
 * superficie li espone dalla pagina ticket, e la parità vale in entrambe le
 * direzioni.
 */
export interface TicketPatch {
  title?: string;
  body?: string;
  type?: TicketType;
  priority?: TicketPriority;
  status?: TicketStatus;
  assigneeId?: string | null;
  milestoneId?: string | null;
  labels?: string[];
}

const jobsSchema = z.array(aiJobSchema);
const activitySchema = z.array(ticketActivityEntrySchema);
const commentsSchema = z.array(ticketCommentSchema);

/**
 * Ticket e stato del lavoro dell'agente: è il materiale della "storia del
 * lavoro" dell'app mobile, che la ricostruisce da `jobs` + `questions` senza
 * rotte dedicate.
 */
export function createTicketsEndpoints(request: ApiRequest) {
  return {
    list(filters: TicketFilters = {}, cursor?: string, limit?: number): Promise<Reader<TicketPage>> {
      const query = toQuery({
        projectId: filters.projectId,
        status: filters.status,
        statuses: filters.statuses?.length ? filters.statuses.join(",") : undefined,
        type: filters.type,
        priority: filters.priority,
        milestoneId: filters.milestoneId,
        q: filters.q,
        cursor,
        limit,
      });
      return request("GET", `/api/tickets${query}`, undefined, ticketPageSchema);
    },

    get(id: string): Promise<Reader<TicketDetail>> {
      return request("GET", `/api/tickets/${seg(id)}`, undefined, ticketDetailSchema);
    },

    /** I run dell'agente sul ticket, dal più recente: la timeline del lavoro. */
    jobs(ticketId: string): Promise<Reader<AiJob>[]> {
      return request("GET", `/api/tickets/${seg(ticketId)}/jobs`, undefined, jobsSchema);
    },

    /**
     * Feed di attività del ticket (commenti, eventi di audit, marker dei run),
     * fuso e ordinato per `createdAt` CRESCENTE dal server.
     *
     * Lo legge l'app mobile per datare i passi della "Storia del lavoro": nulla
     * su `AiJob` dice QUANDO un piano è stato sbloccato o QUANDO la PR è nata,
     * mentre gli eventi `status_changed` lo dicono. Sulla forma piatta e
     * permissiva dello schema — e sul perché non è la `discriminatedUnion` del
     * server — vedi {@link ticketActivityEntrySchema}.
     */
    activity(ticketId: string): Promise<Reader<TicketActivityEntry>[]> {
      return request("GET", `/api/tickets/${seg(ticketId)}/activity`, undefined, activitySchema);
    },

    /**
     * Modifica parziale del ticket. Il corpo porta SOLO i campi toccati: il
     * server li applica uno a uno, e un campo assente non è un azzeramento
     * (per quello c'è `null`, su `assigneeId` e `milestoneId`).
     *
     * `requireAuth`, non `requireAdmin`: cambiare stato, priorità,
     * assegnatario, milestone o etichette è lavoro quotidiano anche per un
     * operatore. Questo metodo non aggiunge un controllo di ruolo che il
     * server non ha — sarebbe una seconda copia della regola, e la copia
     * sbagliata starebbe nel client.
     */
    patch(ticketId: string, patch: TicketPatch): Promise<Reader<Ticket>> {
      return request("PATCH", `/api/tickets/${seg(ticketId)}`, patch, ticketSchema);
    },

    /** I commenti del ticket, dal più vecchio: è la conversazione attorno al lavoro. */
    comments(ticketId: string): Promise<Reader<TicketComment>[]> {
      return request("GET", `/api/tickets/${seg(ticketId)}/comments`, undefined, commentsSchema);
    },

    /**
     * Aggiunge un commento (201). Nasce sempre `authorType: "user"`: quelli
     * dell'AI li inserisce il worker, senza passare da questa rotta.
     *
     * `replyToCommentId` (0083) va nel corpo SOLO se c'è: senza, il corpo
     * resta `{ body }` esatto, come lo mandava ogni versione precedente. Un
     * server che non conosce il campo lo spoglia e crea un commento normale;
     * uno che lo conosce risponde 422 `reply_target_invalid` se il commento
     * non è di questo ticket.
     */
    comment(
      ticketId: string,
      body: string,
      opts: { replyToCommentId?: string } = {},
    ): Promise<Reader<TicketComment>> {
      const payload =
        opts.replyToCommentId === undefined
          ? { body }
          : { body, replyToCommentId: opts.replyToCommentId };
      return request("POST", `/api/tickets/${seg(ticketId)}/comments`, payload, ticketCommentSchema);
    },

    /**
     * Modifica un PROPRIO commento (`PATCH`, 0084): 200 col commento
     * aggiornato. Chi può farlo lo dice `canEdit` del commento, calcolato dal
     * server — il client non lo deduce. Errori: 403 `forbidden`, 404
     * `comment_not_found`, 409 `comment_deleted` (eliminato nel frattempo).
     */
    editComment(ticketId: string, commentId: string, body: string): Promise<Reader<TicketComment>> {
      return request(
        "PATCH",
        `/api/tickets/${seg(ticketId)}/comments/${seg(commentId)}`,
        { body },
        ticketCommentSchema,
      );
    },

    /**
     * Cancella un commento (`DELETE`, 0084): 204, nessun corpo. La riga resta
     * come segnaposto «Commento eliminato»; idempotente. Permesso: `canDelete`.
     */
    deleteComment(ticketId: string, commentId: string): Promise<void> {
      return request("DELETE", `/api/tickets/${seg(ticketId)}/comments/${seg(commentId)}`);
    },

    /**
     * La storia del ticket, dal più recente (`GET /api/tickets/:id/history`):
     * un evento per riga, al più 200, con `total` prima del taglio. `kind` è
     * una stringa aperta (un valore nuovo arriva così com'è, il client lo
     * rende come riga generica); un server più vecchio risponde 404, e chi
     * chiama lo tratta come «storia non disponibile».
     */
    history(ticketId: string): Promise<Reader<TicketHistory>> {
      return request("GET", `/api/tickets/${seg(ticketId)}/history`, undefined, ticketHistorySchema);
    },

    /**
     * Scollega il design: il `body` del ticket torna all'originale conservato
     * in `originContent`. **Irreversibile** — il design non è conservato
     * altrove — e per questo ogni superficie che la offre chiede conferma.
     * 404 se un design attivo non c'è.
     */
    deleteDesign(ticketId: string): Promise<Reader<TicketDetail>> {
      return request("DELETE", `/api/tickets/${seg(ticketId)}/design`, undefined, ticketDetailSchema);
    },

    /** Azzera il piano di implementazione. **Irreversibile**, come `deleteDesign`. */
    deletePlan(ticketId: string): Promise<Reader<TicketDetail>> {
      return request("DELETE", `/api/tickets/${seg(ticketId)}/plan`, undefined, ticketDetailSchema);
    },

    /**
     * Q&A dell'agente sul ticket, in ordine cronologico. `answer` è null sia
     * sulla domanda aperta sia su una risposta non più leggibile: è `answeredAt`
     * a dire se una risposta c'è stata.
     */
    questions(ticketId: string): Promise<Reader<TicketQuestion>[]> {
      return request(
        "GET",
        `/api/tickets/${seg(ticketId)}/questions`,
        undefined,
        ticketQuestionsSchema,
      );
    },

    /**
     * Risposta a una domanda DALLA PAGINA TICKET (l'unica superficie senza una
     * notifica in mano). `questionId` è un parametro a sé e non un campo del
     * corpo per renderlo impossibile da dimenticare: il server lo confronta con
     * la domanda davvero aperta, così una schermata ferma su un giro superato
     * viene rifiutata invece di rispondere alla domanda successiva.
     */
    answerQuestion(
      ticketId: string,
      questionId: string,
      answer: AnswerBody,
    ): Promise<Reader<AnswerQuestionResult>> {
      return request(
        "POST",
        `/api/tickets/${seg(ticketId)}/questions/answer`,
        { ...answer, questionId },
        answerQuestionResultSchema,
      );
    },

    /**
     * Avvio manuale dell'AI sul ticket (202). `status` distingue i due esiti: un
     * run chiesto da un operatore su un ticket con piano salvato nasce già fermo
     * sul gate (`awaiting_plan_approval`) invece che in coda, e l'app deve dirlo
     * invece di annunciare un fix partito. 409 `job_in_flight` se un job è già
     * in volo.
     *
     * `resumeCorrectionJobId` (facoltativo, come ogni campo del corpo:
     * `runAiBodySchema`) dice QUALE correzione ferma si vuole riprendere — il
     * `cycle.heldJobId` che la schermata mostrava. Il server la forza solo se
     * quel job è ancora l'ultimo del ticket e ancora `held`; altrimenti 409
     * `correction_not_held` (distinto da `job_in_flight` dal `code`, non dallo
     * status), e per un `member` su una correzione ferma per budget 403
     * `needs_maintainer`. Senza il campo il rilancio è quello di sempre.
     *
     * ⚠️ Un server PRECEDENTE a G5 non conosce il campo e lo IGNORA (il corpo
     * non è `.strict()`): per lui è un rilancio normale, cioè un fix nuovo.
     * Per questo il chiamante lo manda solo quando `cycle.heldJobId` c'è —
     * un server che lo valorizza è anche uno che sa leggerlo.
     */
    runAi(ticketId: string, opts?: RunAiBody): Promise<Reader<RunAiResult>> {
      return request("POST", `/api/tickets/${seg(ticketId)}/run-ai`, opts, runAiResultSchema);
    },

    /** Approva il piano in attesa: il worker lo esegue. 409 se non ce n'è uno. */
    approvePlan(ticketId: string): Promise<Reader<PlanDecisionResult>> {
      return request("POST", `/api/tickets/${seg(ticketId)}/approve-plan`, undefined, planDecisionResultSchema);
    },

    /**
     * Rifiuta il piano: il worker ri-pianifica. Le `instructions` opzionali
     * (max 4000) diventano un commento del team sul ticket — cioè proprio ciò
     * che il nuovo piano rilegge.
     */
    rejectPlan(ticketId: string, body?: { instructions?: string }): Promise<Reader<PlanDecisionResult>> {
      return request("POST", `/api/tickets/${seg(ticketId)}/reject-plan`, body, planDecisionResultSchema);
    },

    /**
     * Pre-approva IN ANTICIPO il piano CORRENTE (fase 7): un operatore può
     * far partire il fix senza fermarsi sul gate. Solo admin lato server
     * (`requireAdmin` + ricontrollo dentro il servizio) — questo metodo non
     * indebolisce né duplica quel divieto, la UI mostra il bottone solo al
     * maintainer. Risponde con il TICKET intero (non un esito a sé): i tre
     * campi (`planApprovedAt`/`planApprovedBy`/`planApprovalStale`) sono già
     * lì. 409 `no_plan` se il ticket non ha un piano da approvare.
     */
    preApprovePlan(ticketId: string): Promise<Reader<TicketDetail>> {
      return request("POST", `/api/tickets/${seg(ticketId)}/pre-approve-plan`, undefined, ticketDetailSchema);
    },

    /**
     * Revoca la pre-approvazione: azzera i tre campi. Idempotente (revocare
     * un ticket mai approvato è un no-op, 200 comunque) — stesso motivo per
     * cui non c'è un 409 dedicato qui, a differenza di `preApprovePlan`.
     */
    revokePlanApproval(ticketId: string): Promise<Reader<TicketDetail>> {
      return request("DELETE", `/api/tickets/${seg(ticketId)}/pre-approve-plan`, undefined, ticketDetailSchema);
    },

    /**
     * Mergia la PR del ticket su UN repository (28 set 2026, dettaglio
     * progetto v3 §6): la STESSA rotta della coda di rilascio del web, con il
     * suo `requireAdmin` e il controllo ridondante dentro
     * `releasePullRequest`. Il cancello vero è lì: chi chiama mostra il
     * bottone solo quando il polso dice `canMerge`, ma non decide niente.
     *
     * Gli errori arrivano come `ApiError` col loro `code` — 404 `not_found`,
     * 409 `already_closed`/`checks_failed`/`checks_unreadable`, 502 — e chi
     * chiama li MOSTRA. Il ticket non cambia qui: lo chiude il webhook del
     * provider, come per un merge fatto a mano.
     */
    release(ticketId: string, repositoryId: string): Promise<Reader<ReleaseResult>> {
      return request(
        "POST",
        `/api/tickets/${seg(ticketId)}/repositories/${seg(repositoryId)}/release`,
        undefined,
        releaseResultSchema,
      );
    },

    /**
     * Chiede una CORREZIONE della PR del ticket su UN repository (202): l'AI
     * applica sulla stessa PR l'ultima review più la `note`, pusha in avanti
     * sullo stesso branch e fa ripartire la review. Non è un piano nuovo, e per
     * questo non passa dal gate di approvazione: chiunque possa lanciare un run
     * sul ticket può chiederla (il cancello vero è sul server).
     *
     * Il corpo è una PATCH per costruzione: `note` facoltativa, e senza nota il
     * corpo è `{}` — mai `note: undefined`, mai un campo obbligatorio che un'app
     * vecchia non saprebbe mandare.
     *
     * Gli errori arrivano come `ApiError` col loro `code` — 409
     * `correction_in_flight`/`job_in_flight`/`pr_not_open`/`not_stubwise_pr` — e
     * chi chiama li MOSTRA. Se una correzione è già possibile oppure no lo dice
     * `cycle.canRequestCorrection` nel dettaglio: il client non lo rideduce.
     */
    requestCorrection(
      ticketId: string,
      repositoryId: string,
      body: RequestCorrectionBody = {},
    ): Promise<Reader<RequestCorrectionResponse>> {
      return request(
        "POST",
        `/api/tickets/${seg(ticketId)}/repositories/${seg(repositoryId)}/corrections`,
        body.note !== undefined ? { note: body.note } : {},
        requestCorrectionResponseSchema,
      );
    },
  };
}
