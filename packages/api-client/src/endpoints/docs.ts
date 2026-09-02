import {
  docChatMessageSchema,
  docChatSessionSchema,
  docPageSchema,
  docSpaceSchema,
  docTreeNodeSchema,
} from "@stubwise/shared";
import type {
  DocChatMessage,
  DocChatSession,
  DocPage,
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
 * L'INVIO di un messaggio alla chat NON è qui: oggi la rotta risponde solo in
 * SSE (`reply.hijack()`), che non passa da questo trasporto; la variante
 * `?stream=false` che serve all'app arriva con la fase B del programma. Le due
 * letture (sessioni e messaggi) invece sono JSON normale e ci sono.
 */
export function createDocsEndpoints(request: ApiRequest) {
  return {
    /** Gli spazi documentali (un repository con documentazione) dell'istanza. */
    spaces(): Promise<DocSpace[]> {
      return request("GET", "/api/docs/spaces", undefined, spacesSchema);
    },

    /** Gli spazi dei soli repository di un progetto. */
    projectSpaces(projectId: string): Promise<DocSpace[]> {
      return request("GET", `/api/projects/${seg(projectId)}/docs/spaces`, undefined, spacesSchema);
    },

    /** Albero di navigazione di uno spazio (piatto: i nodi portano `parentId`). */
    tree(repositoryId: string): Promise<DocTreeNode[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/tree`,
        undefined,
        treeSchema,
      );
    },

    /** Una pagina completa (markdown + metadati). */
    page(repositoryId: string, slug: string): Promise<DocPage> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/pages/${seg(slug)}`,
        undefined,
        docPageSchema,
      );
    },

    chatSessions(repositoryId: string): Promise<DocChatSession[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/chat/sessions`,
        undefined,
        sessionsSchema,
      );
    },

    chatMessages(repositoryId: string, sessionId: string): Promise<DocChatMessage[]> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/chat/sessions/${seg(sessionId)}/messages`,
        undefined,
        messagesSchema,
      );
    },

    projectChatSessions(projectId: string): Promise<DocChatSession[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/chat/sessions`,
        undefined,
        sessionsSchema,
      );
    },

    projectChatMessages(projectId: string, sessionId: string): Promise<DocChatMessage[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/chat/sessions/${seg(sessionId)}/messages`,
        undefined,
        messagesSchema,
      );
    },
  };
}
