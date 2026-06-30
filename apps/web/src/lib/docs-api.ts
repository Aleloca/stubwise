import type {
  DocGenerationStatus,
  DocGenerationTrigger,
  DocJobStatus,
  DocPageKind,
} from "@stubwise/shared";
import { ApiError, api } from "./api";

/**
 * Client API del dominio Docs (documentazione autogenerata): tipi e funzioni
 * gemelli degli schema Zod di risposta del server (`apps/server/src/routes/docs.ts`).
 * Solo `getDocSpaces` è consumata in M7.1 (hub); il resto è scaffolding tipato
 * pronto per le sotto-feature (albero/pagina/ricerca/generazione/manuale/chat).
 */

// --- Hub spazi (GET /api/docs/spaces) ---

/**
 * Uno "spazio" dell'hub: un progetto che ha documentazione (almeno una pagina
 * autogenerata della generazione corrente o manuale). `lastGenerationAt`/
 * `lastCommitSha` sono null finché non c'è una generazione corrente riuscita
 * (es. spazi con sole pagine manuali).
 */
export interface DocSpace {
  projectId: string;
  slug: string;
  name: string;
  pageCount: number;
  lastGenerationAt: string | null;
  lastCommitSha: string | null;
}

/** Hub degli spazi: i progetti con documentazione, ordinati per nome. */
export function getDocSpaces(): Promise<DocSpace[]> {
  return api.get("/api/docs/spaces");
}

// --- Albero pagine (GET /api/projects/:id/docs/tree) ---

/**
 * Nodo dell'albero/sidebar: il minimo per renderizzare la navigazione di uno
 * spazio. Il `parentId` (soft-FK) ricostruisce la gerarchia; `kind` separa i tre
 * gruppi Tecnico/Funzionale/Manuale.
 */
export interface DocTreeNode {
  id: string;
  slug: string;
  title: string;
  kind: DocPageKind;
  parentId: string | null;
  position: number;
  sourcePath: string | null;
  isManual: boolean;
}

/** Albero delle pagine di uno spazio (generazione corrente + manuali). */
export function getDocTree(projectId: string): Promise<DocTreeNode[]> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/tree`);
}

// --- Pagina singola (GET /api/projects/:id/docs/pages/:slug) ---

/**
 * Un cross-link risolto di una pagina: `type` raggruppa la relazione
 * (implements/implemented_by/related); `slug`+`title` linkano la pagina target.
 */
export interface DocPageLink {
  type: "implements" | "implemented_by" | "related";
  slug: string;
  title: string;
}

/**
 * Pagina completa: corpo markdown + metadati. `commitSha` è quello della
 * generazione di appartenenza (badge "generato al commit"); null per le manuali.
 * `links` porta i cross-link risolti a fine generazione; null se non calcolati
 * (pagine manuali o generazioni senza cross-link).
 */
export interface DocPage {
  id: string;
  slug: string;
  title: string;
  kind: DocPageKind;
  parentId: string | null;
  position: number;
  sourcePath: string | null;
  body: string;
  isManual: boolean;
  commitSha: string | null;
  links?: DocPageLink[] | null;
  updatedAt: string;
}

/** Una pagina dello spazio per slug. */
export function getDocPage(projectId: string, slug: string): Promise<DocPage> {
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/docs/pages/${encodeURIComponent(slug)}`,
  );
}

// --- Stato/trigger generazione ---

/** Job di doc-generation (proiezione pubblica): stato + trigger + tempi. */
export interface DocGenerationJob {
  id: string;
  status: DocJobStatus;
  trigger: DocGenerationTrigger;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Generazione corrente (puntata da projects.currentDocGenerationId). */
export interface DocGeneration {
  id: string;
  status: DocGenerationStatus;
  commitSha: string | null;
  model: string | null;
  cost: string | null;
  stats: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Provider bloccato della generazione corrente (puntato da
 * generation.pinnedProviderId): proiezione minima per mostrarlo nello stato del
 * pannello. `null` quando la generazione è in automatico (primo abilitato).
 */
export interface DocPinnedProvider {
  id: string;
  label: string;
  kind: "account" | "api_key";
}

/** Stato Docs di un progetto: generazione corrente + ultimo job. */
export interface DocStatus {
  generation: DocGeneration | null;
  latestJob: DocGenerationJob | null;
  pinnedProvider: DocPinnedProvider | null;
}

/** Stato della documentazione di un progetto (generazione corrente + ultimo job). */
export function getDocStatus(projectId: string): Promise<DocStatus> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/status`);
}

/**
 * Avvia (o restituisce quello già attivo) un job di generazione documentazione
 * per il progetto. Solo admin/maintainer lato server. Ritorna il job in coda.
 * Il provider AI è quello configurato a livello di progetto (impostazioni
 * progetto): la generazione non lo accetta più come parametro.
 */
export function generateDocs(projectId: string): Promise<DocGenerationJob> {
  return api.post(`/api/projects/${encodeURIComponent(projectId)}/docs/generate`);
}

// --- Ricerca (GET /api/projects/:id/docs/search?q=) ---

/**
 * Un risultato di ricerca: la pagina (slug/title/kind) più l'estratto rilevante,
 * il punteggio e la sorgente (semantica/full-text/ibrida). Linka alla pagina.
 */
export interface DocSearchResult {
  slug: string;
  title: string;
  kind: DocPageKind;
  snippet: string;
  score: number;
  source: "semantic" | "fulltext" | "hybrid";
}

/** Ricerca ibrida (semantica + full-text) nella documentazione di un progetto. */
export function searchDocs(projectId: string, q: string): Promise<DocSearchResult[]> {
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/docs/search?q=${encodeURIComponent(q)}`,
  );
}

// --- Cronologia ricerca (GET/POST/DELETE /api/projects/:id/docs/history) ---

/**
 * Una voce della cronologia server-side: la pagina visitata dalla command
 * palette (slug/title/kind) più il momento del click. Ordinata per `clickedAt`
 * decrescente lato server; usata per il "Recenti" della palette.
 */
export interface DocHistoryEntry {
  slug: string;
  title: string;
  kind: DocPageKind;
  /** Anteprima testuale vista al click; null per i click senza snippet. */
  snippet: string | null;
  clickedAt: string;
}

/** Cronologia delle pagine recenti dell'utente corrente nello spazio. */
export function getDocsHistory(projectId: string): Promise<DocHistoryEntry[]> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/history`);
}

/** Registra (upsert) un click su una pagina nella cronologia: ritorna 204. */
export function recordDocsHistoryClick(
  projectId: string,
  entry: { slug: string; title: string; kind: DocPageKind; snippet?: string },
): Promise<void> {
  return api.post(`/api/projects/${encodeURIComponent(projectId)}/docs/history`, entry);
}

/** Rimuove una singola voce della cronologia per slug: ritorna 204. */
export function deleteDocsHistoryEntry(projectId: string, slug: string): Promise<void> {
  return api.delete(
    `/api/projects/${encodeURIComponent(projectId)}/docs/history/${encodeURIComponent(slug)}`,
  );
}

/** Svuota tutta la cronologia dell'utente corrente nello spazio: ritorna 204. */
export function clearDocsHistory(projectId: string): Promise<void> {
  return api.delete(`/api/projects/${encodeURIComponent(projectId)}/docs/history`);
}

// --- Pagine manuali (CRUD) ---

/** Dati di creazione di una pagina manuale: slug opzionale (derivato dal titolo). */
export interface ManualPageDraft {
  title: string;
  slug?: string;
  parentId?: string | null;
  position?: number;
  body?: string;
}

/** Campi modificabili di una pagina manuale. */
export interface ManualPagePatch {
  title?: string;
  parentId?: string | null;
  position?: number;
  body?: string;
}

/** Crea una pagina manuale nello spazio Manuale (member ok): 409 slug duplicato. */
export function createManualPage(projectId: string, draft: ManualPageDraft): Promise<DocPage> {
  return api.post(`/api/projects/${encodeURIComponent(projectId)}/docs/manual`, draft);
}

/** Aggiorna una pagina manuale (member ok): solo le pagine isManual. */
export function updateManualPage(
  projectId: string,
  id: string,
  patch: ManualPagePatch,
): Promise<DocPage> {
  return api.patch(
    `/api/projects/${encodeURIComponent(projectId)}/docs/manual/${encodeURIComponent(id)}`,
    patch,
  );
}

/** Elimina una pagina manuale (member ok): solo le pagine isManual. */
export function deleteManualPage(projectId: string, id: string): Promise<void> {
  return api.delete(
    `/api/projects/${encodeURIComponent(projectId)}/docs/manual/${encodeURIComponent(id)}`,
  );
}

// --- Chat RAG (streaming SSE) ---

/** Sessione di chat di uno spazio (lista cronologica). */
export interface DocChatSession {
  id: string;
  createdAt: string;
}

/** Citazione nel messaggio di risposta: linka la pagina sorgente. */
export interface DocChatCitation {
  slug: string;
  title: string;
  kind: DocPageKind;
}

/** Messaggio persistito di una sessione di chat. */
export interface DocChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: DocChatCitation[] | null;
  createdAt: string;
}

/** Le sessioni di chat dello spazio dell'utente corrente. */
export function getDocChatSessions(projectId: string): Promise<DocChatSession[]> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/chat/sessions`);
}

/** I messaggi di una sessione di chat. */
export function getDocChatMessages(
  projectId: string,
  sessionId: string,
): Promise<DocChatMessage[]> {
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/docs/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

/**
 * Invia un messaggio alla chat RAG dello spazio. La risposta è uno stream SSE
 * (`text/event-stream`): non passa dal wrapper JSON `api`, il chiamante (M7.5)
 * legge `response.body` incrementalmente. `sessionId` assente = nuova sessione.
 */
export async function postDocChat(
  projectId: string,
  body: { sessionId?: string; message: string },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/docs/chat`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError(0, "Unable to reach the server", "network_error", { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    const fallback = `Error ${response.status}`;
    const { message, code } = await response
      .json()
      .then((data: unknown) => {
        const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
        return {
          message: "message" in obj ? String(obj.message) : fallback,
          code: typeof obj.code === "string" ? obj.code : undefined,
        };
      })
      .catch(() => ({ message: fallback, code: undefined }));
    throw new ApiError(response.status, message, code);
  }
  return response;
}
