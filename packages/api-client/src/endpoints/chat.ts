import {
  chatChannelListSchema,
  chatChannelSchema,
  chatClaudeQuestionListSchema,
  chatMentionListSchema,
  chatMessagePageSchema,
  chatMessageSchema,
  chatQuestionListSchema,
  chatSearchResultSchema,
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
      /**
       * I canali che chi guarda vede (di progetto, generali, i suoi DM); il
       * «general» c'è sempre per i membri del progetto. `kind` filtra (fetta 2).
       */
      list(opts: { projectId?: string; archived?: boolean; kind?: "project" | "general" | "dm" } = {}) {
        return request(
          "GET",
          `/api/chat/channels${toQuery({ projectId: opts.projectId, archived: opts.archived ? "true" : undefined, kind: opts.kind })}`,
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
      /** Esce; `null` (204) se chi esce non vede più il canale (un privato, un DM). 409 `cannot_leave`. */
      async leave(id: string) {
        return (await request("DELETE", `/api/chat/channels/${seg(id)}/join`, undefined, chatChannelSchema)) ?? null;
      },
      /** Invita (fetta 2). 403 (non può, o sé stesso); 400 `invalid_members`. */
      invite(id: string, personIds: string[]) {
        return request("POST", `/api/chat/channels/${seg(id)}/members`, { personIds }, chatChannelSchema);
      },
      /** Toglie una persona; `null` (204) se chi agisce non vede più il canale. 409 `last_member`. */
      async removeMember(id: string, personId: string) {
        return (
          (await request(
            "DELETE",
            `/api/chat/channels/${seg(id)}/members/${seg(personId)}`,
            undefined,
            chatChannelSchema,
          )) ?? null
        );
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
    /** Apre il DM con queste persone (2–8 con chi apre): quello che c'è già, o uno nuovo. 400 `invalid_members`. */
    openDm(personIds: string[]) {
      return request("POST", "/api/chat/dm", { personIds }, chatChannelSchema);
    },
    /**
     * @Claude nei thread (fetta 3): solo chi l'ha chiamato ferma, rifà e
     * risponde alla sua domanda (403 `not_yours`, 409 `invalid_status`,
     * `already_answered`, `deleted`). Le proposte si decidono con le rotte di
     * sempre (`claude.proposals.confirm|cancel`): in un canale archiviato o per
     * chi non è più membro rispondono 404.
     */
    claude: {
      stop(messageId: string) {
        return request("POST", `/api/chat/messages/${seg(messageId)}/claude/stop`, undefined, chatMessageSchema);
      },
      /** «Try again» di una risposta fallita: la risposta NUOVA, in fondo al thread. */
      retry(messageId: string) {
        return request("POST", `/api/chat/messages/${seg(messageId)}/claude/retry`, undefined, chatMessageSchema);
      },
      answer(messageId: string, body: { questionId: string; optionIndex: number | null; text: string | null }) {
        return request("POST", `/api/chat/messages/${seg(messageId)}/claude/answer`, body, chatMessageSchema);
      },
      /** Le domande di @Claude a chi guarda, aperte («Da decidere»). */
      questions() {
        return request("GET", "/api/chat/claude-questions", undefined, chatClaudeQuestionListSchema);
      },
    },
    /** Le domande rivolte a chi guarda, aperte («Da decidere»). */
    questions() {
      return request("GET", "/api/chat/questions", undefined, chatQuestionListSchema);
    },
    /** Ignora una domanda; 404 se non è sua o non è aperta. */
    dismissQuestion(messageId: string): Promise<void> {
      return request("POST", `/api/chat/questions/${seg(messageId)}/dismiss`);
    },
    /** La ricerca nei canali che chi guarda legge (meno di 2 caratteri: nessun risultato). */
    search(opts: {
      q: string;
      channelId?: string;
      authorId?: string;
      peopleOnly?: boolean;
      withCitations?: boolean;
      from?: string;
      to?: string;
      limit?: number;
    }) {
      return request(
        "GET",
        `/api/chat/search${toQuery({
          q: opts.q,
          channelId: opts.channelId,
          authorId: opts.authorId,
          peopleOnly: opts.peopleOnly ? "true" : undefined,
          withCitations: opts.withCitations ? "true" : undefined,
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
        })}`,
        undefined,
        chatSearchResultSchema,
      );
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
