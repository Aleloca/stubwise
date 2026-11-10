import {
  chatChannelListSchema,
  chatChannelSchema,
  chatMentionListSchema,
  chatMessagePageSchema,
  chatMessageSchema,
  chatSignalSchema,
  chatThreadNewsSchema,
  chatThreadSchema,
} from "@stubwise/shared";
import type {
  ChatNotifyLevel,
  CreateChatChannelInput,
  PatchChatChannelInput,
  PostChatMessageInput,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * La Chat fra persone (integrazione area 4, fetta 1): canali di progetto e il
 * «general», messaggi, thread a un livello, reazioni, letti, preferenze. Le
 * viste sono di CHI GUARDA (permessi calcolati dal server); un canale o un
 * messaggio che non si vede risponde 404 `not_found`, come uno che non esiste.
 */
export function createChatEndpoints(request: ApiRequest) {
  return {
    channels: {
      /** I canali di progetto che chi guarda vede; il «general» c'è sempre per i membri del progetto. */
      list(opts: { projectId?: string; archived?: boolean } = {}) {
        return request(
          "GET",
          `/api/chat/channels${toQuery({ projectId: opts.projectId, archived: opts.archived ? "true" : undefined })}`,
          undefined,
          chatChannelListSchema,
        );
      },
      get(id: string) {
        return request("GET", `/api/chat/channels/${seg(id)}`, undefined, chatChannelSchema);
      },
      /** 403 `forbidden` senza `chat.channels.create`; 409 `name_taken`. */
      create(body: CreateChatChannelInput) {
        return request("POST", "/api/chat/channels", body, chatChannelSchema);
      },
      /** Anche `archived`. 403 `forbidden`; 409 `general_channel`, `name_taken`. */
      update(id: string, patch: PatchChatChannelInput) {
        return request("PATCH", `/api/chat/channels/${seg(id)}`, patch, chatChannelSchema);
      },
      remove(id: string): Promise<void> {
        return request("DELETE", `/api/chat/channels/${seg(id)}`);
      },
      join(id: string) {
        return request("POST", `/api/chat/channels/${seg(id)}/join`, undefined, chatChannelSchema);
      },
      leave(id: string) {
        return request("DELETE", `/api/chat/channels/${seg(id)}/join`, undefined, chatChannelSchema);
      },
      /** Letto fino a ora (o `at`); con `threadRootId`, il thread. */
      markRead(id: string, body: { threadRootId?: string; at?: string } = {}): Promise<void> {
        return request("POST", `/api/chat/channels/${seg(id)}/read`, body);
      },
      setPref(id: string, level: ChatNotifyLevel) {
        return request("PUT", `/api/chat/channels/${seg(id)}/pref`, { level }, chatChannelSchema);
      },
    },
    messages: {
      /** Solo le radici, dalla più vecchia alla più nuova; `before` è il cursore opaco della pagina prima. */
      page(channelId: string, opts: { before?: string; limit?: number } = {}) {
        return request(
          "GET",
          `/api/chat/channels/${seg(channelId)}/messages${toQuery({ before: opts.before, limit: opts.limit })}`,
          undefined,
          chatMessagePageSchema,
        );
      },
      get(id: string) {
        return request("GET", `/api/chat/messages/${seg(id)}`, undefined, chatMessageSchema);
      },
      /** Con l'id di una risposta risponde la radice. */
      thread(id: string) {
        return request("GET", `/api/chat/messages/${seg(id)}/thread`, undefined, chatThreadSchema);
      },
      /** 403 `not_member`, 409 `channel_archived`, 400 `invalid_thread`. */
      send(channelId: string, body: PostChatMessageInput) {
        return request("POST", `/api/chat/channels/${seg(channelId)}/messages`, body, chatMessageSchema);
      },
      /** 403 `not_yours`, 409 `deleted`. */
      edit(id: string, text: string) {
        return request("PATCH", `/api/chat/messages/${seg(id)}`, { text }, chatMessageSchema);
      },
      /** 403 `not_yours`; il messaggio resta, senza testo (`deleted`). */
      remove(id: string): Promise<void> {
        return request("DELETE", `/api/chat/messages/${seg(id)}`);
      },
      toggleReaction(id: string, emoji: string) {
        return request("POST", `/api/chat/messages/${seg(id)}/reactions/toggle`, { emoji }, chatMessageSchema);
      },
      /** Segue o smette di seguire il thread di una radice: risponde la radice aggiornata. */
      setFollow(id: string, following: boolean) {
        return request("PUT", `/api/chat/messages/${seg(id)}/follow`, { following }, chatMessageSchema);
      },
    },
    /** Le radici dei thread seguiti con risposte nuove («Threads»). */
    threads() {
      return request("GET", "/api/chat/threads", undefined, chatThreadNewsSchema);
    },
    /** I messaggi che nominano chi guarda nei canali che legge, dal più recente («Mentions»). */
    mentions() {
      return request("GET", "/api/chat/mentions", undefined, chatMentionListSchema);
    },
    /** Il punto del binario. */
    signal() {
      return request("GET", "/api/chat/signal", undefined, chatSignalSchema);
    },
    /** Lo stream SSE di un canale (anche le risposte dei thread, col loro `threadRootId`). */
    streamPath(channelId: string, after?: string) {
      return `/api/chat/channels/${seg(channelId)}/stream${toQuery({ after })}`;
    },
  };
}
