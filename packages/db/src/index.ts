export * from "./schema.js";
export { createDb, runMigrations, type Db, type DbHandle } from "./client.js";
// Cifratura delle credenziali a riposo: vive qui (non nel server) perché è
// accoppiata a ciò che è salvato nel DB (git_accounts.encryptedCredentials) e
// serve sia al server (encrypt alla creazione/validazione dell'account) sia al
// worker (decrypt dell'account collegato al progetto nel fix).
export { decrypt, encrypt } from "./secrets.js";
// Helper di lettura costo (somma agent_runs.cost_usd per ticket / per mese
// corrente): importati da worker e server per i gate di budget.
export { monthlyCostUsd, ticketCostUsd } from "./cost.js";
// Retrieval ibrido (semantico pgvector + full-text) sui Docs: vive qui perché
// serve sia al server (ricerca, chat RAG) sia al worker (intake del backlog di
// discovery + similarity search). L'embedder è un tipo strutturale locale
// (`EmbeddingProvider`), così db non dipende da `@stubwise/embeddings`.
export {
  retrieveChunks,
  retrieveChunksForProject,
  retrieveChunksAll,
} from "./docs-retrieval.js";
export type {
  EmbeddingProvider,
  RetrievedChunk,
  RetrieveChunksOptions,
  RetrievalLogger,
} from "./docs-retrieval.js";
