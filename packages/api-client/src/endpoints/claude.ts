import { z } from "zod";
import {
  claudeActionGroupViewSchema,
  claudeChatStatusSchema,
  claudeProposalViewSchema,
  claudeConversationDetailSchema,
  claudeConversationListSchema,
  claudeConversationSchema,
} from "@stubwise/shared";
import type {
  ClaudeActionGroupView,
  ClaudeChatStatus,
  ClaudeProposalView,
  ClaudeConversation,
  ClaudeConversationDetail,
  ContinueClaudeConversationInput,
  CreateClaudeConversationInput,
  PatchClaudeConversationInput,
  SetClaudeConversationVisibilityInput,
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
      /** Le proprie (`mine`), o dalla fetta 5 le pubbliche di altri (`public`, con `claude.public.view`). */
      list(
        opts: { scope?: "mine" | "public"; archived?: boolean; limit?: number; before?: string } = {},
      ): Promise<Reader<{ items: ClaudeConversation[]; nextCursor: string | null }>> {
        return request(
          "GET",
          `/api/claude/conversations${toQuery({
            scope: opts.scope ?? "mine",
            archived: opts.archived ? "true" : undefined,
            limit: opts.limit,
            before: opts.before,
          })}`,
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
      /**
       * Pubblica o rende privata (fetta 5, solo l'autore). 409
       * `needs_confirmation` con i progetti da confermare nei `details`
       * (`claudeVisibilityConfirmationSchema`).
       */
      setVisibility(id: string, body: SetClaudeConversationVisibilityInput): Promise<Reader<ClaudeConversation>> {
        return request("POST", `/api/claude/conversations/${seg(id)}/visibility`, body, claudeConversationSchema);
      },
      /** Continua una pubblica di un altro (fetta 5): nasce una conversazione nuova, privata, di chi chiama. */
      continue(id: string, body: ContinueClaudeConversationInput = {}): Promise<Reader<ClaudeConversation>> {
        return request("POST", `/api/claude/conversations/${seg(id)}/continue`, body, claudeConversationSchema);
      },
      /** Le proposte di Claude della conversazione: classe e motivi calcolati adesso dal server. */
      proposals(id: string): Promise<Reader<ClaudeProposalView>[]> {
        return request("GET", `/api/claude/conversations/${seg(id)}/proposals`, undefined, z.array(claudeProposalViewSchema));
      },
      /** I gruppi eseguiti, con lo stato di «Annulla» per chi guarda. */
      groups(id: string): Promise<Reader<ClaudeActionGroupView>[]> {
        return request("GET", `/api/claude/conversations/${seg(id)}/groups`, undefined, z.array(claudeActionGroupViewSchema));
      },
    },
    /**
     * Le decisioni della persona (chat, fetta 3). 409 `expired`, `conflict`,
     * `budget_exhausted` o `refused` (con la proposta e il motivo nei `details`).
     */
    proposals: {
      confirm(
        id: string,
        body: { selected?: number[]; edited?: { index: number; args: Record<string, unknown> }[] } = {},
      ): Promise<Reader<ClaudeProposalView>> {
        return request("POST", `/api/claude/proposals/${seg(id)}/confirm`, body, claudeProposalViewSchema);
      },
      cancel(id: string): Promise<Reader<ClaudeProposalView>> {
        return request("POST", `/api/claude/proposals/${seg(id)}/cancel`, undefined, claudeProposalViewSchema);
      },
    },
    groups: {
      /** «Annulla»: subito, o una scheda da confermare se gli inversi avviserebbero qualcuno. 409 `changed_after`, `undone`… */
      undo(id: string): Promise<Reader<{ kind: "undone" | "needs_confirmation"; proposal?: ClaudeProposalView }>> {
        return request(
          "POST",
          `/api/claude/groups/${seg(id)}/undo`,
          undefined,
          z.object({ kind: z.enum(["undone", "needs_confirmation"]), proposal: claudeProposalViewSchema.optional() }),
        );
      },
    },
  };
}
