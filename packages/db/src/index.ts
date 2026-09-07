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
export { retrieveChunks, retrieveChunksForProject, retrieveChunksAll } from "./docs-retrieval.js";
export type {
  EmbeddingProvider,
  RetrievedChunk,
  RetrieveChunksOptions,
  RetrievalLogger,
} from "./docs-retrieval.js";
// Audit delle transizioni di stato di un ticket: vive qui perché a scrivere in
// `ticket_events` sono sia il server (rotte e webhook) sia il worker (pipeline
// di fix, intake del backlog), e la regola "una transizione = un evento datato"
// deve essere una sola.
export { recordTicketStatusChange } from "./ticket-events.js";
// Registro delle DECISIONI di progetto: vive qui perché a scrivere in
// `project_decisions` sono il server (risposta a una domanda, gate del piano,
// "Procedi" del pulse, voci manuali) e, in lettura, il worker che compone il
// brief. ⚠️ Non chiama e non deve mai chiamare un agente: il registro non è mai
// scritto dall'AI (vedi il docblock di `recordDecision`).
export { recordDecision, type DecisionSource, type RecordDecisionParams } from "./decisions.js";
