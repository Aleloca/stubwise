import type {
  DocGenerationStatus,
  DocGenerationTrigger,
  DocJobStatus,
  DocPageKind,
  ProductExclusion,
  ProjectBrief,
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
 * Uno "spazio" dell'hub: un repository che ha documentazione (almeno una pagina
 * autogenerata della generazione corrente o manuale). `lastGenerationAt`/
 * `lastCommitSha` sono null finché non c'è una generazione corrente riuscita
 * (es. spazi con sole pagine manuali).
 */
export interface DocSpace {
  repositoryId: string;
  slug: string;
  name: string;
  pageCount: number;
  lastGenerationAt: string | null;
  lastCommitSha: string | null;
}

/** Hub degli spazi: i repository con documentazione, ordinati per nome. */
export function getDocSpaces(): Promise<DocSpace[]> {
  return api.get("/api/docs/spaces");
}

/**
 * Gli spazi-doc di un PROGETTO: i suoi repository con documentazione. Stesso
 * shape dell'hub globale (un repository = uno spazio), filtrato sul progetto.
 */
export function getProjectDocSpaces(projectId: string): Promise<DocSpace[]> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/spaces`);
}

// --- Albero pagine (GET /api/repositories/:repositoryId/docs/tree) ---

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
  /** Data di creazione della pagina (per le release = data della entry). */
  createdAt: string;
  /** Visualizzazioni cumulate (increment all'apertura). */
  viewCount: number;
  /** Solo per kind="releases": significatività; null per le altre pagine. */
  significant: boolean | null;
}

/** Albero delle pagine di uno spazio (generazione corrente + manuali). */
export function getDocTree(repositoryId: string): Promise<DocTreeNode[]> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/tree`);
}

// --- Pagina singola (GET /api/repositories/:repositoryId/docs/pages/:slug) ---

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
  createdAt: string;
  viewCount: number;
  /** Solo per kind="releases": significatività; null per le altre pagine. */
  significant: boolean | null;
}

/** Una pagina dello spazio per slug. */
export function getDocPage(repositoryId: string, slug: string): Promise<DocPage> {
  return api.get(
    `/api/repositories/${encodeURIComponent(repositoryId)}/docs/pages/${encodeURIComponent(slug)}`,
  );
}

/**
 * Segnala l'apertura di una pagina (increment del contatore viste). Chiamata
 * fire-and-forget: gli errori sono ignorati di proposito — un contatore mancato
 * non deve mai disturbare la lettura.
 */
export function pingPageView(repositoryId: string, slug: string): void {
  void api
    .post(
      `/api/repositories/${encodeURIComponent(repositoryId)}/docs/pages/${encodeURIComponent(slug)}/view`,
    )
    .catch(() => {
      /* il conteggio viste è best-effort */
    });
}

// --- Highlights (home orientanti di repo e progetto) ---

/** Riferimento leggero a una pagina in una lista di highlights. */
export interface DocHighlightRef {
  slug: string;
  title: string;
  kind: DocPageKind;
  viewCount: number;
}

/**
 * Una release nel changelog. `createdAt` è la data della entry; `significant`
 * distingue le release rilevanti da quelle minori (null per le release create
 * prima dell'introduzione della colonna). `commitSha` è sempre null per le
 * release: il commit si legge dallo slug `release-YYYYMMDD-HHmm-<sha>`.
 */
export interface DocReleaseRef {
  slug: string;
  title: string;
  createdAt: string;
  significant: boolean | null;
  commitSha: string | null;
}

/** Conteggio pagine per categoria: tutte le chiavi sempre presenti. */
export type DocCountsByKind = Record<DocPageKind, number>;

/** Highlights di un repository: alimentano l'overview dello spazio. */
export interface DocHighlights {
  countsByKind: DocCountsByKind;
  topViewed: DocHighlightRef[];
  recentlyUpdated: DocHighlightRef[];
  latestReleases: DocReleaseRef[];
}

/** Repository d'origine, annesso alle voci aggregate di progetto. */
interface DocRepoOrigin {
  repositoryId: string;
  repositorySlug: string;
  repositoryName: string;
}

export type DocProjectHighlightRef = DocHighlightRef & DocRepoOrigin;
export type DocProjectReleaseRef = DocReleaseRef & DocRepoOrigin;

/** Highlights aggregate di progetto: changelog cross-repo + pagine più lette. */
export interface DocProjectHighlights {
  countsByKind: DocCountsByKind;
  topViewed: DocProjectHighlightRef[];
  latestReleases: DocProjectReleaseRef[];
}

/** Highlights del repository (conteggi, pagine top, ultime release). */
export function getRepoHighlights(repositoryId: string): Promise<DocHighlights> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/highlights`);
}

/** Highlights aggregate del progetto (changelog cross-repo, pagine più lette). */
export function getProjectHighlights(projectId: string): Promise<DocProjectHighlights> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/highlights`);
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
export function getDocStatus(repositoryId: string): Promise<DocStatus> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/status`);
}

/**
 * Avvia (o restituisce quello già attivo) un job di generazione documentazione
 * per il progetto. Solo admin/maintainer lato server. Ritorna il job in coda.
 * Il provider AI è quello configurato a livello di progetto (impostazioni
 * progetto): la generazione non lo accetta più come parametro.
 */
export function generateDocs(repositoryId: string): Promise<DocGenerationJob> {
  return api.post(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/generate`);
}

/**
 * Riprende subito una generazione in pausa per limite del provider (solo
 * admin), senza aspettare il resume poller. 409 `generation_not_paused` se non
 * c'è nulla in pausa (o il poller l'ha già ripresa): lo stato reale va
 * comunque rinfrescato.
 */
export function resumeDocs(repositoryId: string): Promise<DocGeneration> {
  return api.post(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/resume`);
}

// --- Project brief (GET /api/repositories/:repositoryId/docs/brief) ---

export type { ProjectBrief, ProductExclusion } from "@stubwise/shared";

/** Metadati della generazione da cui provengono brief ed esclusioni (coerenza A3). */
export interface DocBriefGeneration {
  createdAt: string;
  commitSha: string | null;
}

/**
 * Risposta della route brief: il brief della generazione corrente, i metadati di
 * quella generazione (data/commit) e le pagine product ESCLUSE dal verificatore
 * segreti (Fase C) della STESSA generazione.
 */
export interface DocBriefResponse {
  brief: ProjectBrief;
  generation: DocBriefGeneration;
  productExclusions: ProductExclusion[];
}

/**
 * Project brief della generazione corrente del repository: le "domande fondanti"
 * del prodotto (identità, attori, superfici, glossario, invarianti, journey e
 * fatti riservati) prodotte nel primo step dell'orientamento. Superficie interna
 * autenticata: include i `confidentialFacts` (per l'audit — NON entrano mai nella
 * documentazione pubblica) e le `productExclusions` del verificatore segreti. 404
 * se nessuna generazione del repo ha un brief.
 */
export function getDocBrief(repositoryId: string): Promise<DocBriefResponse> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/brief`);
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
export function createManualPage(repositoryId: string, draft: ManualPageDraft): Promise<DocPage> {
  return api.post(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/manual`, draft);
}

/** Aggiorna una pagina manuale (member ok): solo le pagine isManual. */
export function updateManualPage(
  repositoryId: string,
  id: string,
  patch: ManualPagePatch,
): Promise<DocPage> {
  return api.patch(
    `/api/repositories/${encodeURIComponent(repositoryId)}/docs/manual/${encodeURIComponent(id)}`,
    patch,
  );
}

/** Elimina una pagina manuale (member ok): solo le pagine isManual. */
export function deleteManualPage(repositoryId: string, id: string): Promise<void> {
  return api.delete(
    `/api/repositories/${encodeURIComponent(repositoryId)}/docs/manual/${encodeURIComponent(id)}`,
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
  /**
   * Repository d'origine della fonte. Sempre presente nel JSON del server (sia
   * per-repo sia cross-repo): nella chat per-repo è ridondante, nella chat di
   * progetto serve a mostrare/linkare la pagina nel repo giusto.
   */
  repositoryId?: string;
  repositorySlug?: string;
  repositoryName?: string;
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
export function getDocChatSessions(repositoryId: string): Promise<DocChatSession[]> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/docs/chat/sessions`);
}

/** I messaggi di una sessione di chat. */
export function getDocChatMessages(
  repositoryId: string,
  sessionId: string,
): Promise<DocChatMessage[]> {
  return api.get(
    `/api/repositories/${encodeURIComponent(repositoryId)}/docs/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

/** Le sessioni di chat (cross-repo) di un PROGETTO dell'utente corrente. */
export function getProjectDocChatSessions(projectId: string): Promise<DocChatSession[]> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/docs/chat/sessions`);
}

/** I messaggi di una sessione di chat di progetto. */
export function getProjectDocChatMessages(
  projectId: string,
  sessionId: string,
): Promise<DocChatMessage[]> {
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/docs/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

/**
 * Helper condiviso della chat RAG (per-repo e di progetto): POSTa il messaggio
 * a `path` e ritorna la `Response` grezza per la lettura incrementale dello
 * stream SSE (`text/event-stream`) da parte del chiamante. NON passa dal wrapper
 * JSON `api`; mappa gli errori di rete e di stato in `ApiError` come le altre
 * chiamate. Il parsing SSE vive nel componente chat, identico per entrambe le
 * sorgenti (per-repo / per-progetto), quindi non è duplicato qui.
 */
async function postDocChatStream(
  path: string,
  body: { sessionId?: string; message: string },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
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

/**
 * Invia un messaggio alla chat RAG dello spazio (per-repository). La risposta è
 * uno stream SSE letto incrementalmente dal chiamante (M7.5). `sessionId`
 * assente = nuova sessione.
 */
export function postDocChat(
  repositoryId: string,
  body: { sessionId?: string; message: string },
): Promise<Response> {
  return postDocChatStream(
    `/api/repositories/${encodeURIComponent(repositoryId)}/docs/chat`,
    body,
  );
}

/**
 * Invia un messaggio alla chat RAG cross-repo di un PROGETTO. Stessa meccanica
 * SSE della chat per-repo (`postDocChatStream`); le citazioni del `done`
 * portano il repository d'origine. `sessionId` assente = nuova sessione di
 * progetto (project-level).
 */
export function postProjectDocChat(
  projectId: string,
  body: { sessionId?: string; message: string },
): Promise<Response> {
  return postDocChatStream(`/api/projects/${encodeURIComponent(projectId)}/docs/chat`, body);
}
