import {
  supportConversationListSchema,
  supportConversationSchema,
  supportCustomerPreviewSchema,
  supportOpenRequestResultSchema,
  supportSearchResultSchema,
  type Reader,
  type SupportConversation,
  type SupportCustomerPreview,
  type SupportOpenRequestBody,
  type SupportReplyBody,
  type SupportSearchResult,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Support (area 8, F3): le conversazioni coi clienti. Stato e azioni li
 * calcola il server (la vista dice cosa chi guarda PUÒ fare); le scritture
 * rispondono con la vista aggiornata. Il team non scrive MAI al cliente del
 * widget (maintainer, 14 nov 2026): la risposta è solo per il collaboratore
 * del canale `mcp`.
 */
const searchListSchema = z.object({ items: z.array(supportSearchResultSchema) });

export function createSupportEndpoints(request: ApiRequest) {
  const byCode = (code: string) => `/api/support/conversations/by-code/${seg(code)}`;
  return {
    list(projectId: string, opts: { state?: string } = {}): Promise<Reader<{ items: SupportConversation[] }>> {
      return request("GET", `/api/projects/${seg(projectId)}/support/conversations${toQuery({ state: opts.state })}`, undefined, supportConversationListSchema);
    },
    /**
     * ⌘K (rimandi, lotto 5): le conversazioni per codice o cliente nei
     * progetti visibili, dalla più recente, al massimo 20; meno di 2
     * caratteri: nessuna.
     */
    async search(q: string): Promise<Reader<SupportSearchResult>[]> {
      return (await request("GET", `/api/support/search${toQuery({ q })}`, undefined, searchListSchema)).items;
    },
    get(code: string): Promise<Reader<SupportConversation>> {
      return request("GET", byCode(code), undefined, supportConversationSchema);
    },
    /** Ciò che vede il cliente adesso. */
    preview(code: string): Promise<Reader<SupportCustomerPreview>> {
      return request("GET", `${byCode(code)}/preview`, undefined, supportCustomerPreviewSchema);
    },
    /** La risposta al collaboratore (solo canale `mcp`, `support.manage`); 409 `support_widget_no_reply` sul widget. */
    replyToCollaborator(code: string, body: SupportReplyBody): Promise<Reader<SupportConversation>> {
      return request("POST", `${byCode(code)}/replies`, body, supportConversationSchema);
    },
    /** «Apri la richiesta» (`support.manage` e `backlog.create`); 409 `support_not_concluded` su una che non è «non conclusa». */
    openRequest(code: string, body: SupportOpenRequestBody): Promise<Reader<{ conversation: SupportConversation; request: { id: string; code: string } }>> {
      return request("POST", `${byCode(code)}/request`, body, supportOpenRequestResultSchema);
    },
    /** «Non conclusa» su una `answered` (`support.manage`); 409 `support_not_answered` altrimenti. */
    markNotConcluded(code: string): Promise<Reader<SupportConversation>> {
      return request("POST", `${byCode(code)}/not-concluded`, undefined, supportConversationSchema);
    },
  };
}
