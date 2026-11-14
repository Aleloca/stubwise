import {
  supportConversationListSchema,
  supportConversationSchema,
  supportCustomerPreviewSchema,
  supportEmailDraftSchema,
  supportOpenRequestResultSchema,
  type Reader,
  type SupportConversation,
  type SupportCustomerPreview,
  type SupportEmailDraft,
  type SupportOpenRequestBody,
  type SupportReplyBody,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Support (area 8, F3): le conversazioni coi clienti. Stato e azioni li
 * calcola il server (la vista dice cosa chi guarda PUÒ fare); le scritture
 * rispondono con la vista aggiornata. Nessuna rotta di annullamento: l'Undo
 * di 5 s della risposta è del renderer (la risposta parte allo scadere).
 */
export function createSupportEndpoints(request: ApiRequest) {
  const byCode = (code: string) => `/api/support/conversations/by-code/${seg(code)}`;
  return {
    list(projectId: string, opts: { state?: string } = {}): Promise<Reader<{ items: SupportConversation[] }>> {
      return request("GET", `/api/projects/${seg(projectId)}/support/conversations${toQuery({ state: opts.state })}`, undefined, supportConversationListSchema);
    },
    /** «Clienti in attesa» (Home): le conversazioni che aspettano noi dove chi guarda ha `support.reply`. */
    waitingCustomers(): Promise<Reader<{ items: SupportConversation[] }>> {
      return request("GET", "/api/me/waiting-customers", undefined, supportConversationListSchema);
    },
    get(code: string): Promise<Reader<SupportConversation>> {
      return request("GET", byCode(code), undefined, supportConversationSchema);
    },
    /** Ciò che vede il cliente adesso. */
    preview(code: string): Promise<Reader<SupportCustomerPreview>> {
      return request("GET", `${byCode(code)}/preview`, undefined, supportCustomerPreviewSchema);
    },
    /** «Send to customer» (`support.reply`); 409 `support_triage` durante il triage. */
    reply(code: string, body: SupportReplyBody): Promise<Reader<SupportConversation>> {
      return request("POST", `${byCode(code)}/replies`, body, supportConversationSchema);
    },
    follow(code: string, on: boolean): Promise<Reader<SupportConversation>> {
      return request("PUT", `${byCode(code)}/follow`, { on }, supportConversationSchema);
    },
    /** «Apri la richiesta» (`backlog.create`); 409 `support_not_concluded` su una che non è «non conclusa». */
    openRequest(code: string, body: SupportOpenRequestBody): Promise<Reader<{ conversation: SupportConversation; request: { id: string; code: string } }>> {
      return request("POST", `${byCode(code)}/request`, body, supportOpenRequestResultSchema);
    },
    /** «Non conclusa» su una `answered` (`support.reply`); 409 `support_not_answered` altrimenti. */
    markNotConcluded(code: string): Promise<Reader<SupportConversation>> {
      return request("POST", `${byCode(code)}/not-concluded`, undefined, supportConversationSchema);
    },
    /** «Ask Claude»: accoda la bozza (202, `claudeDraftPending`); 409 `budget_exhausted`. */
    requestDraft(code: string): Promise<Reader<SupportConversation>> {
      return request("POST", `${byCode(code)}/draft`, undefined, supportConversationSchema);
    },
    /** «Scrivigli anche per email»: i campi da aprire nella Posta (il server non salva né invia). */
    emailDraft(code: string): Promise<Reader<SupportEmailDraft>> {
      return request("GET", `${byCode(code)}/email-draft`, undefined, supportEmailDraftSchema);
    },
  };
}
