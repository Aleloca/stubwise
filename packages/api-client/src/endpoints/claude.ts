import {
  claudeChatStatusSchema,
  claudeConversationDetailSchema,
  claudeConversationListSchema,
  claudeConversationSchema,
} from "@stubwise/shared";
import type {
  ClaudeChatStatus,
  ClaudeConversation,
  ClaudeConversationDetail,
  CreateClaudeConversationInput,
  PatchClaudeConversationInput,
  Reader,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Le conversazioni libere con Claude (chat, fetta 1): private dell'autore. I
 * messaggi, «Ferma», gli eventi e lo stream sono quelli delle sessioni
 * (`agentSessions.send`, `events`, `streamPath`): la conversazione È una
 * sessione di kind `free`, con lo stesso id. 409 `budget_exhausted` col budget
 * del mese finito.
 */
export function createClaudeEndpoints(request: ApiRequest) {
  return {
    /** Prima di scrivere: il budget del mese è finito? (Un server più vecchio: `false`.) */
    status(): Promise<Reader<ClaudeChatStatus>> {
      return request("GET", "/api/claude/conversations/status", undefined, claudeChatStatusSchema);
    },
    conversations: {
      list(opts: { archived?: boolean } = {}): Promise<Reader<{ items: ClaudeConversation[] }>> {
        return request(
          "GET",
          `/api/claude/conversations${toQuery({ scope: "mine", archived: opts.archived ? "true" : undefined })}`,
          undefined,
          claudeConversationListSchema,
        );
      },
      get(id: string): Promise<Reader<ClaudeConversationDetail>> {
        return request("GET", `/api/claude/conversations/${seg(id)}`, undefined, claudeConversationDetailSchema);
      },
      create(body: CreateClaudeConversationInput = {}): Promise<Reader<ClaudeConversation>> {
        return request("POST", "/api/claude/conversations", body, claudeConversationSchema);
      },
      update(id: string, patch: PatchClaudeConversationInput): Promise<Reader<ClaudeConversation>> {
        return request("PATCH", `/api/claude/conversations/${seg(id)}`, patch, claudeConversationSchema);
      },
      remove(id: string): Promise<void> {
        return request("DELETE", `/api/claude/conversations/${seg(id)}`);
      },
    },
  };
}
