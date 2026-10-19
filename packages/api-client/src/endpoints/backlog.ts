import {
  backlogItemDetailSchema,
  backlogJobResultSchema,
  backlogPageSchema,
  convertBacklogResultSchema,
  createBacklogResultSchema,
} from "@stubwise/shared";
import type {
  Reader,
  BacklogItemDetail,
  BacklogJobResult,
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
 * Asimmetria da tenere a mente, voluta lato server: `create` NON crea la voce,
 * accoda un job `intake` (202): dopo la cattura rapida la voce compare in lista
 * con qualche secondo di ritardo (`job` ne dice lo stato).
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

    /** Stato di un job del backlog (l'intake accodato da `create`): `done` = la voce esiste. */
    job(jobId: string): Promise<Reader<BacklogJobResult>> {
      return request("GET", `/api/backlog/jobs/${seg(jobId)}`, undefined, backlogJobResultSchema);
    },

    /** Converte la voce in un ticket task; torna id e numero del ticket creato. */
    convert(id: string): Promise<Reader<ConvertBacklogResult>> {
      return request("POST", `/api/backlog/${seg(id)}/convert`, undefined, convertBacklogResultSchema);
    },
  };
}
