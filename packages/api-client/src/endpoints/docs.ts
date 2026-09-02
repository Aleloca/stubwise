import {
  docPageKindSchema,
  searchDocsSemanticResultsSchema,
  searchResultsSchema,
} from "@stubwise/shared";
import type { SearchDocsSemanticResults, SearchResults } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** MIRROR di `spaceSchema` (`apps/server/src/routes/docs.ts`). */
export const docSpaceSchema = z.object({
  repositoryId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
  lastGenerationAt: z.string().nullable(),
  lastCommitSha: z.string().nullable(),
});
export type DocSpace = z.infer<typeof docSpaceSchema>;

/** MIRROR di `treeNodeSchema` (stesso file lato server). */
export const docTreeNodeSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  isManual: z.boolean(),
  createdAt: z.string(),
  viewCount: z.number().int(),
  significant: z.boolean().nullable(),
});
export type DocTreeNode = z.infer<typeof docTreeNodeSchema>;

/** MIRROR di `docPageLinkSchema` (stesso file lato server). */
const docPageLinkSchema = z.object({
  type: z.enum(["implements", "implemented_by", "related"]),
  slug: z.string(),
  title: z.string(),
});

/** MIRROR di `pageSchema` (stesso file lato server): corpo markdown + metadati. */
export const docPageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  body: z.string(),
  isManual: z.boolean(),
  commitSha: z.string().nullable(),
  commitUrl: z.string().nullable(),
  links: z.array(docPageLinkSchema).nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
  viewCount: z.number().int(),
  significant: z.boolean().nullable(),
});
export type DocPage = z.infer<typeof docPageSchema>;

/** MIRROR delle risposte di `apps/server/src/routes/docs-chat.ts`. */
const docChatSessionSchema = z.object({ id: z.uuid(), createdAt: z.string() });
export type DocChatSession = z.infer<typeof docChatSessionSchema>;

const docChatMessageSchema = z.object({
  id: z.uuid(),
  role: z.string(),
  content: z.string(),
  // `unknown` anche lato server: le citazioni sono una colonna jsonb, e il
  // contratto non le stringe. Chi le usa se le valida.
  citations: z.unknown().nullable(),
  createdAt: z.string(),
});
export type DocChatMessage = z.infer<typeof docChatMessageSchema>;

const spacesSchema = z.array(docSpaceSchema);
const treeSchema = z.array(docTreeNodeSchema);
const sessionsSchema = z.array(docChatSessionSchema);
const messagesSchema = z.array(docChatMessageSchema);

/**
 * Docs: ricerca e navigazione della documentazione autogenerata.
 *
 * La ricerca ha DUE corsie che il client fonde: `search` è full-text ed è
 * veloce, `searchDocsSemantic` è il retrieval vettoriale sui soli Docs ed è
 * lenta ma migliore. La seconda è best-effort lato server (mai un errore: lista
 * vuota se il retrieval non è disponibile), quindi si può lanciare in parallelo
 * alla prima e fondere quando arriva.
 *
 * L'INVIO di un messaggio alla chat NON è qui: oggi la rotta risponde solo in
 * SSE (`reply.hijack()`), che non passa da questo trasporto; la variante
 * `?stream=false` che serve all'app arriva con la fase B del programma. Le due
 * letture (sessioni e messaggi) invece sono JSON normale e ci sono.
 */
export function createDocsEndpoints(request: ApiRequest) {
  return {
    /**
     * Ricerca globale full-text (ticket, progetti, repository, docs).
     * `repositoryId` restringe SOLO il gruppo docs; gli altri restano globali.
     */
    search(q: string, repositoryId?: string): Promise<SearchResults> {
      return request("GET", `/api/search${toQuery({ q, repositoryId })}`, undefined, searchResultsSchema);
    },

    /** Corsia semantica sui Docs, da fondere nel gruppo docs della ricerca. */
    searchDocsSemantic(q: string, repositoryId?: string): Promise<SearchDocsSemanticResults> {
      return request(
        "GET",
        `/api/search/docs-semantic${toQuery({ q, repositoryId })}`,
        undefined,
        searchDocsSemanticResultsSchema,
      );
    },

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
