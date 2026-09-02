import { backlogItemDetailSchema, backlogPageSchema } from "@stubwise/shared";
import type {
  BacklogItemDetail,
  BacklogPage,
  BacklogItemStatus,
  BacklogRisk,
  CreateBacklogItemInput,
  TicketPriority,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/backlog`. */
export interface BacklogFilters {
  projectId?: string;
  status?: BacklogItemStatus;
  /** L'urgenza riusa la scala di priority dei ticket (`backlogUrgencySchema`). */
  urgency?: TicketPriority;
  risk?: BacklogRisk;
  q?: string;
}

const createResultSchema = z.object({ queued: z.literal(true), jobId: z.uuid() });
const convertResultSchema = z.object({ ticketId: z.uuid(), ticketNumber: z.number().int() });
const chatTurnSchema = z.object({ mode: z.literal("code"), userMessageId: z.uuid() });

export type CreateBacklogResult = z.infer<typeof createResultSchema>;
export type ConvertBacklogResult = z.infer<typeof convertResultSchema>;
/** Esito di un turno di chat con sessione di analisi attiva. */
export type BacklogChatTurn = z.infer<typeof chatTurnSchema>;

/**
 * Backlog di discovery.
 *
 * Due asimmetrie da tenere a mente, entrambe volute lato server:
 * - `create` NON crea la voce, accoda un job `intake` (202): dopo la cattura
 *   rapida la voce compare in lista con qualche secondo di ritardo;
 * - `chat` esiste in due modi, e questo è quello NON in streaming: risponde 202
 *   quando c'è una sessione di analisi sul codice attiva. Senza sessione la
 *   stessa rotta risponde in SSE, che il client non sa (ancora) leggere — la
 *   variante non-streaming per l'app arriva con la fase B.
 */
export function createBacklogEndpoints(request: ApiRequest) {
  return {
    list(filters: BacklogFilters = {}, cursor?: string, limit?: number): Promise<BacklogPage> {
      const query = toQuery({
        projectId: filters.projectId,
        status: filters.status,
        urgency: filters.urgency,
        risk: filters.risk,
        q: filters.q,
        cursor,
        limit,
      });
      return request("GET", `/api/backlog${query}`, undefined, backlogPageSchema);
    },

    get(id: string): Promise<BacklogItemDetail> {
      return request("GET", `/api/backlog/${seg(id)}`, undefined, backlogItemDetailSchema);
    },

    /** Creazione manuale: accoda un job `intake` (202), non crea la voce. */
    create(input: CreateBacklogItemInput): Promise<CreateBacklogResult> {
      return request("POST", "/api/backlog", input, createResultSchema);
    },

    /** Converte la voce in un ticket task; torna id e numero del ticket creato. */
    convert(id: string): Promise<ConvertBacklogResult> {
      return request("POST", `/api/backlog/${seg(id)}/convert`, undefined, convertResultSchema);
    },

    /** Un turno della chat di raffinamento CON sessione di analisi attiva (202). */
    chat(id: string, message: string): Promise<BacklogChatTurn> {
      return request("POST", `/api/backlog/${seg(id)}/chat`, { message }, chatTurnSchema);
    },
  };
}
