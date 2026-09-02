/**
 * `@stubwise/api-client` — il client HTTP dell'API di Stubwise, condiviso.
 *
 * Esiste perché `apps/mobile` è un client dell'API esattamente come la SPA:
 * senza un pacchetto comune, path, verbi, gestione degli errori e forme di
 * risposta sarebbero una TERZA copia dopo il server e il web. Non è un livello
 * di stato: niente cache, niente React — quello ce lo mette chi lo usa.
 *
 * Sulla validazione delle risposte: `request` accetta uno schema OPZIONALE.
 * Dove il server dichiara lo stesso schema come risposta della rotta, il
 * serializzatore Zod di Fastify ci fa già passare ogni payload prima di
 * spedirlo — quindi validare di nuovo qui è fail-fast a costo zero. Dove non
 * c'è uno schema, il JSON passa così com'è: è la corsia che usa `apps/web` per
 * le rotte non mappate, e garantisce che adottare il client non cambi nulla di
 * ciò che vede un utente del web.
 */
export { createStubwiseClient } from "./client.js";
export type { ApiRequest, HttpMethod, StubwiseClient, StubwiseClientOptions } from "./client.js";
export { ApiError, errorFromResponse, handledByFromError } from "./errors.js";

export type { Credentials } from "./endpoints/auth.js";
export type {
  BacklogChatTurn,
  BacklogFilters,
  ConvertBacklogResult,
  CreateBacklogResult,
} from "./endpoints/backlog.js";
export type { InboxActionBody, InboxFilters } from "./endpoints/inbox.js";
export type {
  AnswerQuestionResult,
  PlanDecisionResult,
  RunAiResult,
  TicketFilters,
} from "./endpoints/tickets.js";
