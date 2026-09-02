import {
  backlogChatAcceptedSchema,
  backlogItemDetailSchema,
  backlogPageSchema,
  convertBacklogResultSchema,
  createBacklogResultSchema,
} from "@stubwise/shared";
import type {
  Reader,
  BacklogChatAccepted,
  BacklogItemDetail,
  BacklogPage,
  ConvertBacklogResult,
  CreateBacklogResult,
  BacklogItemStatus,
  BacklogRisk,
  CreateBacklogItemInput,
  TicketPriority,
} from "@stubwise/shared";
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
    list(filters: BacklogFilters = {}, cursor?: string, limit?: number): Promise<Reader<BacklogPage>> {
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

    get(id: string): Promise<Reader<BacklogItemDetail>> {
      return request("GET", `/api/backlog/${seg(id)}`, undefined, backlogItemDetailSchema);
    },

    /** Creazione manuale: accoda un job `intake` (202), non crea la voce. */
    create(input: CreateBacklogItemInput): Promise<Reader<CreateBacklogResult>> {
      return request("POST", "/api/backlog", input, createBacklogResultSchema);
    },

    /** Converte la voce in un ticket task; torna id e numero del ticket creato. */
    convert(id: string): Promise<Reader<ConvertBacklogResult>> {
      return request("POST", `/api/backlog/${seg(id)}/convert`, undefined, convertBacklogResultSchema);
    },

    /** Un turno della chat di raffinamento CON sessione di analisi attiva (202). */
    chat(id: string, message: string): Promise<Reader<BacklogChatAccepted>> {
      return request("POST", `/api/backlog/${seg(id)}/chat`, { message }, backlogChatAcceptedSchema);
    },
  };
}
