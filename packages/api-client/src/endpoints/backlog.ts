import {
  backlogChatAcceptedSchema,
  backlogItemDetailSchema,
  backlogPageSchema,
  convertBacklogResultSchema,
  createBacklogResultSchema,
  docsChatAnswerSchema,
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
  DocsChatAnswer,
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
 * Asimmetrie da tenere a mente, tutte volute lato server:
 * - `create` NON crea la voce, accoda un job `intake` (202): dopo la cattura
 *   rapida la voce compare in lista con qualche secondo di ritardo;
 * - `chat` (202) SOLO con una sessione di analisi sul codice attiva: è il
 *   chiamante a sapere che è quello il caso — la STESSA rotta, senza sessione
 *   attiva, risponde altrimenti in SSE (che questo pacchetto non legge) o, con
 *   `?stream=false`, nel body JSON di `chatText` qui sotto;
 * - `chatText` (200, fase 4 mobile) è la chat di raffinamento SENZA sessione di
 *   analisi attiva: stesso contratto “è il chiamante a sapere in quale modo sta
 *   chiedendo” — se una sessione FOSSE attiva, il server risponde comunque 202
 *   (`?stream` è ignorato in quel ramo, vedi `backlog.ts` lato server) e questa
 *   chiamata fallirebbe con `invalid_response` (la forma non è quella attesa):
 *   il chiamante verifica lo stato della sessione PRIMA di scegliere fra `chat`
 *   e `chatText`, non dopo.
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

    /**
     * Un turno della chat di raffinamento SENZA sessione di analisi attiva,
     * risposta JSON completa (`?stream=false`, fase 4 mobile). `sessionId` nella
     * risposta è l'id della VOCE (non c'è una tabella di sessioni dedicata per
     * il backlog, vedi `backlog.ts` lato server).
     */
    chatText(id: string, message: string): Promise<Reader<DocsChatAnswer>> {
      return request(
        "POST",
        `/api/backlog/${seg(id)}/chat?stream=false`,
        { message },
        docsChatAnswerSchema,
      );
    },
  };
}
