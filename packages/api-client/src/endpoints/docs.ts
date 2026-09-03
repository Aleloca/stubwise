import {
  docChatMessageSchema,
  docChatSessionSchema,
  docPageSchema,
  docsChatAnswerSchema,
  docSpaceSchema,
  docTreeNodeSchema,
} from "@stubwise/shared";
import type {
  Reader,
  DocChatMessage,
  DocChatSession,
  DocPage,
  DocsChatAnswer,
  DocSpace,
  DocTreeNode,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

const spacesSchema = z.array(docSpaceSchema);
const treeSchema = z.array(docTreeNodeSchema);
const sessionsSchema = z.array(docChatSessionSchema);
const messagesSchema = z.array(docChatMessageSchema);

/**
 * Docs: navigazione della documentazione autogenerata.
 *
 * La RICERCA non è qui: è globale (ticket, progetti, repository e docs) e vive
 * in `client.search`.
 *
 * L'INVIO di un messaggio alla chat è `chat`/`projectChat` qui sotto, SOLO nella
 * variante `?stream=false` (fase 4, mobile): con lo stream a `true` (default) la
 * rotta risponde in SSE grezzo (`reply.hijack()`), che non passa da questo
 * trasporto — quel percorso resta della SPA, che legge l'evento stream a mano.
 * Le due letture (sessioni e messaggi) sono JSON normale e ci sono da sempre.
 */
export function createDocsEndpoints(request: ApiRequest) {
  return {
    /** Gli spazi documentali (un repository con documentazione) dell'istanza. */
    spaces(): Promise<Reader<DocSpace>[]> {
      return request("GET", "/api/docs/spaces", undefined, spacesSchema);
    },

    /** Gli spazi dei soli repository di un progetto. */
    projectSpaces(projectId: string): Promise<Reader<DocSpace>[]> {
      return request("GET", `/api/projects/${seg(projectId)}/docs/spaces`, undefined, spacesSchema);
    },

    /** Albero di navigazione di uno spazio (piatto: i nodi portano `parentId`). */
    tree(repositoryId: string): Promise<Reader<DocTreeNode>[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/tree`,
        undefined,
        treeSchema,
      );
    },

    /** Una pagina completa (markdown + metadati). */
    page(repositoryId: string, slug: string): Promise<Reader<DocPage>> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/pages/${seg(slug)}`,
        undefined,
        docPageSchema,
      );
    },

    /**
     * Un turno della chat sui Docs di un repository, risposta JSON completa
     * (`?stream=false`, fase 4 mobile): niente SSE, un unico body a fine
     * generazione. `sessionId` è opzionale (nuova sessione se assente), come
     * nella variante SSE.
     */
    chat(
      repositoryId: string,
      input: { message: string; sessionId?: string },
    ): Promise<Reader<DocsChatAnswer>> {
      return request(
        "POST",
        `/api/repositories/${seg(repositoryId)}/docs/chat?stream=false`,
        input,
        docsChatAnswerSchema,
      );
    },

    chatSessions(repositoryId: string): Promise<Reader<DocChatSession>[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/chat/sessions`,
        undefined,
        sessionsSchema,
      );
    },

    chatMessages(repositoryId: string, sessionId: string): Promise<Reader<DocChatMessage>[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/chat/sessions/${seg(sessionId)}/messages`,
        undefined,
        messagesSchema,
      );
    },

    /** Un turno della chat sui Docs di PROGETTO (cross-repo), risposta JSON completa (`?stream=false`, fase 4 mobile). */
    projectChat(
      projectId: string,
      input: { message: string; sessionId?: string },
    ): Promise<Reader<DocsChatAnswer>> {
      return request(
        "POST",
        `/api/projects/${seg(projectId)}/docs/chat?stream=false`,
        input,
        docsChatAnswerSchema,
      );
    },

    projectChatSessions(projectId: string): Promise<Reader<DocChatSession>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/chat/sessions`,
        undefined,
        sessionsSchema,
      );
    },

    projectChatMessages(projectId: string, sessionId: string): Promise<Reader<DocChatMessage>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/chat/sessions/${seg(sessionId)}/messages`,
        undefined,
        messagesSchema,
      );
    },
  };
}
