import { aiJobSchema, ticketDetailSchema, ticketListItemSchema, ticketQuestionsSchema } from "@stubwise/shared";
import type {
  AiJob,
  AnswerBody,
  TicketDetail,
  TicketListItem,
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

export interface TicketPage {
  items: TicketListItem[];
  nextCursor: string | null;
}

/**
 * MIRROR di `listTicketsResponseSchema` (`apps/server/src/routes/tickets.ts`):
 * l'involucro paginato resta locale alle rotte, mentre gli item sono lo schema
 * condiviso. Stesso discorso per il backlog.
 */
const ticketPageSchema = z.object({
  items: z.array(ticketListItemSchema),
  nextCursor: z.string().nullable(),
});

const jobsSchema = z.array(aiJobSchema);
const answerResultSchema = z.object({ jobId: z.uuid(), questionId: z.uuid() });
const runAiResultSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(["queued", "awaiting_plan_approval"]),
});
const jobIdSchema = z.object({ jobId: z.uuid() });

export type RunAiResult = z.infer<typeof runAiResultSchema>;
/** Esito di una risposta a una domanda dell'agente dalla pagina ticket. */
export type AnswerQuestionResult = z.infer<typeof answerResultSchema>;
/** Esito di approva/rifiuta piano: il job che riparte. */
export type PlanDecisionResult = z.infer<typeof jobIdSchema>;

/**
 * Ticket e stato del lavoro dell'agente: è il materiale della "storia del
 * lavoro" dell'app mobile, che la ricostruisce da `jobs` + `questions` senza
 * rotte dedicate.
 */
export function createTicketsEndpoints(request: ApiRequest) {
  return {
    list(filters: TicketFilters = {}, cursor?: string, limit?: number): Promise<TicketPage> {
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

    get(id: string): Promise<TicketDetail> {
      return request("GET", `/api/tickets/${seg(id)}`, undefined, ticketDetailSchema);
    },

    /** I run dell'agente sul ticket, dal più recente: la timeline del lavoro. */
    jobs(ticketId: string): Promise<AiJob[]> {
      return request("GET", `/api/tickets/${seg(ticketId)}/jobs`, undefined, jobsSchema);
    },

    /**
     * Q&A dell'agente sul ticket, in ordine cronologico. `answer` è null sia
     * sulla domanda aperta sia su una risposta non più leggibile: è `answeredAt`
     * a dire se una risposta c'è stata.
     */
    questions(ticketId: string): Promise<TicketQuestion[]> {
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
    ): Promise<AnswerQuestionResult> {
      return request(
        "POST",
        `/api/tickets/${seg(ticketId)}/questions/answer`,
        { ...answer, questionId },
        answerResultSchema,
      );
    },

    /**
     * Avvio manuale dell'AI sul ticket (202). `status` distingue i due esiti: un
     * run chiesto da un operatore su un ticket con piano salvato nasce già fermo
     * sul gate (`awaiting_plan_approval`) invece che in coda, e l'app deve dirlo
     * invece di annunciare un fix partito. 409 `job_in_flight` se un job è già
     * in volo.
     */
    runAi(
      ticketId: string,
      opts?: { withInstructions?: boolean; mode?: "ai_plan" },
    ): Promise<RunAiResult> {
      return request("POST", `/api/tickets/${seg(ticketId)}/run-ai`, opts, runAiResultSchema);
    },

    /** Approva il piano in attesa: il worker lo esegue. 409 se non ce n'è uno. */
    approvePlan(ticketId: string): Promise<PlanDecisionResult> {
      return request("POST", `/api/tickets/${seg(ticketId)}/approve-plan`, undefined, jobIdSchema);
    },

    /**
     * Rifiuta il piano: il worker ri-pianifica. Le `instructions` opzionali
     * (max 4000) diventano un commento del team sul ticket — cioè proprio ciò
     * che il nuovo piano rilegge.
     */
    rejectPlan(ticketId: string, body?: { instructions?: string }): Promise<PlanDecisionResult> {
      return request("POST", `/api/tickets/${seg(ticketId)}/reject-plan`, body, jobIdSchema);
    },
  };
}
