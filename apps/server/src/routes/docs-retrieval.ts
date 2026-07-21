/**
 * Retrieval ibrido (semantico + full-text) sui Docs.
 *
 * La logica vive ora in `@stubwise/db` (`packages/db/src/docs-retrieval.ts`)
 * perché serve sia al server (ricerca M6.4, chat RAG M6.5) sia al worker (intake
 * del backlog di discovery + similarity search): un solo punto di verità,
 * importabile da entrambi. Questo modulo la RI-ESPORTA con gli stessi nomi, così
 * nessun call site del server cambia (`import ... from "./docs-retrieval.js"`
 * resta valido, incluso il `vi.mock("./docs-retrieval.js")` dei test RAG).
 */

export {
  retrieveChunks,
  retrieveChunksForProject,
  retrieveChunksAll,
} from "@stubwise/db";
export type {
  EmbeddingProvider,
  RetrievedChunk,
  RetrieveChunksOptions,
  RetrievalLogger,
} from "@stubwise/db";
