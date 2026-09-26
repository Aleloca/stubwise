import {
  docBriefResponseSchema,
  docChatMessageSchema,
  docChatSessionSchema,
  docPageSchema,
  docsChatAnswerSchema,
  docSpaceSchema,
  docTreeNodeSchema,
  projectDocsSearchResultSchema,
  projectHighlightsSchema,
  repoHighlightsSchema,
} from "@stubwise/shared";
import type {
  Reader,
  DocChatMessage,
  DocChatSession,
  DocPage,
  DocsChatAnswer,
  DocSpace,
  DocTreeNode,
  DocBriefResponse,
  ProjectDocsSearchResult,
  ProjectHighlights,
  RepoHighlights,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

const spacesSchema = z.array(docSpaceSchema);
const treeSchema = z.array(docTreeNodeSchema);
const sessionsSchema = z.array(docChatSessionSchema);
const messagesSchema = z.array(docChatMessageSchema);
const projectSearchSchema = z.array(projectDocsSearchResultSchema);

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
     * Gli highlights di un repository — conteggi per categoria, pagine più
     * viste e aggiornate di recente, ultime release — per la sua Overview.
     */
    repoHighlights(repositoryId: string): Promise<Reader<RepoHighlights>> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/highlights`,
        undefined,
        repoHighlightsSchema,
      );
    },

    /** Gli highlights aggregati di un progetto: le novità di tutti i suoi repository. */
    projectHighlights(projectId: string): Promise<Reader<ProjectHighlights>> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/highlights`,
        undefined,
        projectHighlightsSchema,
      );
    },

    /**
     * Il brief di un repository, con la generazione da cui viene. 404 se il
     * repository non ne ha ancora uno: chi lo legge lo tratta come assente.
     */
    brief(repositoryId: string): Promise<Reader<DocBriefResponse>> {
      return request(
        "GET",
        `/api/repositories/${seg(repositoryId)}/docs/brief`,
        undefined,
        docBriefResponseSchema,
      );
    },

    /**
     * Ricerca IBRIDA (semantica + full-text) nella documentazione di tutti i
     * repository di un progetto, lo stesso retrieval della chat di progetto.
     * Ogni risultato porta il repository d'origine.
     */
    projectSearch(projectId: string, q: string): Promise<Reader<ProjectDocsSearchResult>[]> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/docs/search${toQuery({ q })}`,
        undefined,
        projectSearchSchema,
      );
    },

    /**
     * Conta una visita a una pagina (204, nessun corpo). Chi la chiama la
     * tratta come fire-and-forget: un errore qui non deve mai toccare la
     * pagina che si sta leggendo.
     */
    viewPage(repositoryId: string, slug: string): Promise<void> {
      return request("POST", `/api/repositories/${seg(repositoryId)}/docs/pages/${seg(slug)}/view`);
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
