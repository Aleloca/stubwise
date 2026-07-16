import type {
  AlertThresholds,
  CheckStatus,
  CheckType,
  CreateCheckInput,
  DiscoveredService,
  GitProviderKind,
  Language,
  PrState,
  RecordSearchHistoryBody,
  SearchDocsSemanticResults,
  SearchEntityType,
  SearchHistoryItem,
  SearchResults,
  ServerStatus,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
  UpdateCheckInput,
  UpdateServerInput,
  WidgetRepositoryFilters,
  WidgetSettings,
  WidgetUpsertBody,
} from "@stubwise/shared";

export type { PrState, WidgetSettings, WidgetUpsertBody } from "@stubwise/shared";

/**
 * Wrapper fetch tipizzato per l'API di Stubwise.
 *
 * In dev le richieste passano dal proxy di Vite (same-origin), in produzione
 * Caddy serve statici e API dallo stesso host: il cookie di sessione httpOnly
 * viaggia da solo. `credentials: "include"` è ridondante in same-origin ma
 * rende esplicita l'intenzione e copre eventuali setup cross-origin.
 */

/**
 * Errore HTTP dell'API: status + messaggio estratto dal body del server.
 * `code` è l'identificatore stabile (snake_case, indipendente dalla lingua)
 * che il server invia su `{ code, message }`: la UI lo usa per la traduzione
 * via `translateApiError`. Assente su risposte non-JSON, errori di validazione
 * Zod ed errori di rete. Status 0 = errore di rete (il server non ha risposto).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    // fetch rifiuta con TypeError sugli errori di rete (server giù, DNS,
    // CORS): normalizzato in ApiError così i chiamanti hanno un solo tipo
    // di errore da gestire. Tutto il resto (es. AbortError) riemerge as-is.
    if (error instanceof TypeError) {
      // `network_error` è un code stabile (non c'è un body server da cui
      // leggerlo): `translateApiError` lo localizza. Il message inglese è il
      // fallback se la chiave non esistesse.
      throw new ApiError(0, "Unable to reach the server", "network_error", { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    // Il server risponde { code, message } sugli errori user-facing (code
    // assente sugli errori di validazione Zod); il fallback copre risposte
    // non-JSON (proxy, gateway, ecc.). Caso raro e senza code: message in
    // inglese (coerente con "API in inglese, UI traduce per code").
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

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

// --- Auth ---

export interface PublicUser {
  id: string;
  email: string;
  role: "admin" | "member";
  /** Avatar Slack (URL) derivato al link, o null se l'utente non è linkato. */
  avatarUrl: string | null;
  /** Slack user id linkato, o null se non linkato. */
  slackUserId: string | null;
}

/**
 * Utente della sessione corrente esposto da `/me`: l'identità pubblica più la
 * lingua persistita, che la UI usa per allineare i18n dopo il login.
 */
export interface SessionUser extends PublicUser {
  language: Language;
}

export interface Credentials {
  email: string;
  password: string;
}

export function getMe(): Promise<{ user: SessionUser }> {
  return api.get("/api/auth/me");
}

export function getSetupStatus(): Promise<{ needed: boolean }> {
  return api.get("/api/auth/setup");
}

export function postSetup(credentials: Credentials): Promise<{ user: PublicUser }> {
  return api.post("/api/auth/setup", credentials);
}

export function postLogin(credentials: Credentials): Promise<{ user: PublicUser }> {
  return api.post("/api/auth/login", credentials);
}

export function postLogout(): Promise<void> {
  return api.post("/api/auth/logout");
}

/**
 * Aggiorna la preferenza di lingua dell'utente corrente. Il server ricava
 * l'id dalla sessione (mai dal body), quindi si invia solo `{ language }`.
 */
export function patchMyLanguage(language: Language): Promise<{ language: Language }> {
  return api.patch("/api/auth/me", { language });
}

export interface Invite {
  token: string;
  expiresAt: string;
}

/**
 * Crea un invito (solo admin): il token va consegnato fuori banda.
 * Con `slackUserId` l'invito è originato dal workspace Slack e porta con sé
 * l'identità Slack (email/avatar derivati server-side dal profilo Slack).
 */
export function postInvite(email: string, slackUserId?: string): Promise<Invite> {
  return api.post("/api/auth/invites", { email, ...(slackUserId ? { slackUserId } : {}) });
}

/**
 * Invito in sospeso: una riga esiste finché il token non viene consumato
 * dalla registrazione, quindi la lista coincide con gli invitati non ancora
 * registrati. Solo admin (il token consente la registrazione).
 */
export interface PendingInvite {
  token: string;
  email: string;
  expiresAt: string;
  createdAt: string;
  /** Identità Slack dell'invito (null se invito email classico). */
  slackUserId: string | null;
  slackAvatarUrl: string | null;
}

/** Inviti ancora in sospeso (solo admin): 403 per i member. */
export function getInvites(): Promise<PendingInvite[]> {
  return api.get("/api/auth/invites");
}

/** Revoca un invito in sospeso (solo admin): elimina il token. */
export function deleteInvite(token: string): Promise<void> {
  return request("DELETE", `/api/auth/invites/${encodeURIComponent(token)}`);
}

export interface Registration extends Credentials {
  token: string;
}

export function postRegister(registration: Registration): Promise<{ user: PublicUser }> {
  return api.post("/api/auth/register", registration);
}

// --- Tickets ---

/**
 * Stato per-repo di un ticket (Fase 3, fix multi-repo): una voce per ogni
 * repository effettivamente modificato dal fix (riga `ticket_repositories`),
 * con il branch, la PR aperta (se già aperta) e il suo stato. Esposto solo nel
 * DETTAGLIO del ticket; vuoto finché il fix non è stato eseguito.
 */
export interface TicketRepository {
  repositoryId: string;
  repositorySlug: string;
  /** Nome del repository (comodità di UI); slug e id sono sempre presenti. */
  repositoryName?: string;
  branch: string;
  /** URL della PR aperta dal fix; null finché non è stata aperta. */
  prUrl: string | null;
  prState: PrState;
}

/**
 * Campi base di un ticket, comuni a tutte le risposte (POST/PATCH li
 * restituiscono così com'è; lista e dettaglio li estendono con lo stato repo).
 * Il ticket appartiene al solo PROGETTO (Fase 3): non c'è più un repository
 * bersaglio, l'AI sceglie i repo da toccare in fase di fix.
 */
export interface TicketBase {
  id: string;
  /** Progetto (gruppo) a cui il ticket appartiene. */
  projectId: string;
  number: number;
  title: string;
  body: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  source: TicketSource;
  assigneeId: string | null;
  /** Milestone a cui il ticket è assegnato; null = nessuna milestone. */
  milestoneId: string | null;
  /** Stima di sforzo 1–5 del triage AI; null finché non triagiato. */
  effort: number | null;
  labels: string[];
  technicalPayload: unknown;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Ticket nel DETTAGLIO (getTicket): oltre ai campi base, lo stato per-repo
 * (`repositories`). Una voce per ogni repository modificato dal fix; vuoto
 * finché il fix non è stato eseguito.
 */
export interface Ticket extends TicketBase {
  repositories: TicketRepository[];
}

/**
 * Ticket nella LISTA/BOARD: i campi base più il solo CONTEGGIO dei repo toccati
 * (`repositoryCount`), per il badge di board/lista senza caricare lo stato PR
 * completo.
 */
export interface TicketListItem extends TicketBase {
  repositoryCount: number;
}

/** Filtri della lista ticket: combaciano con i search param di /tickets. */
export interface TicketFilters {
  projectId?: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: TicketPriority;
  milestoneId?: string;
  q?: string;
}

export interface TicketPage {
  items: TicketListItem[];
  nextCursor: string | null;
}

export interface TicketPatch {
  title?: string;
  body?: string;
  type?: TicketType;
  priority?: TicketPriority;
  status?: TicketStatus;
  assigneeId?: string | null;
  milestoneId?: string | null;
  labels?: string[];
}

export function listTickets(
  filters: TicketFilters,
  cursor?: string,
  limit?: number,
): Promise<TicketPage> {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  if (filters.type) params.set("type", filters.type);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.milestoneId) params.set("milestoneId", filters.milestoneId);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  if (limit !== undefined) params.set("limit", String(limit));
  const query = params.toString();
  return api.get(`/api/tickets${query ? `?${query}` : ""}`);
}

export function getTicket(id: string): Promise<Ticket> {
  return api.get(`/api/tickets/${id}`);
}

export function patchTicket(id: string, patch: TicketPatch): Promise<TicketBase> {
  return api.patch(`/api/tickets/${id}`, patch);
}

/**
 * Creazione manuale di un ticket dalla UI (source "manual" lato server). Il
 * ticket appartiene al solo PROGETTO: nessun repository bersaglio (Fase 3),
 * l'AI sceglie i repo da toccare in fase di fix.
 */
export interface TicketDraft {
  /** Progetto (gruppo) a cui il ticket appartiene. */
  projectId: string;
  title: string;
  body?: string;
  type: TicketType;
  priority: TicketPriority;
}

export function postTicket(draft: TicketDraft): Promise<TicketBase> {
  return api.post("/api/tickets", draft);
}

// --- Milestones ---

/** Milestone di progetto: raggruppa i ticket verso un obiettivo con scadenza. */
export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  /** Scadenza ISO 8601; null = nessuna scadenza. */
  dueDate: string | null;
  status: "open" | "closed";
  createdAt: string;
}

/** Milestone con l'avanzamento: total/completed e ripartizione per stato. */
export interface MilestoneWithCounts extends Milestone {
  counts: {
    total: number;
    completed: number;
    byStatus: Partial<Record<TicketStatus, number>>;
  };
}

/** Dati di creazione di una milestone. */
export interface MilestoneDraft {
  projectId: string;
  name: string;
  dueDate?: string | null;
  status?: "open" | "closed";
}

/** Campi modificabili di una milestone. */
export interface MilestonePatch {
  name?: string;
  dueDate?: string | null;
  status?: "open" | "closed";
}

export function listMilestones(projectId: string): Promise<MilestoneWithCounts[]> {
  return api.get(`/api/milestones?projectId=${encodeURIComponent(projectId)}`);
}

export function createMilestone(input: MilestoneDraft): Promise<Milestone> {
  return api.post("/api/milestones", input);
}

export function updateMilestone(id: string, patch: MilestonePatch): Promise<MilestoneWithCounts> {
  return api.patch(`/api/milestones/${id}`, patch);
}

export function deleteMilestone(id: string): Promise<void> {
  return request("DELETE", `/api/milestones/${encodeURIComponent(id)}`);
}

// --- Saved views ---

/** Criteri di filtraggio della lista ticket persistiti in una vista salvata. */
export interface SavedViewFilters {
  projectId?: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: TicketPriority;
  assigneeId?: string;
  milestoneId?: string;
  q?: string;
}

/** Vista salvata dei filtri; `isOwn` è relativo all'utente corrente. */
export interface SavedView {
  id: string;
  name: string;
  filters: SavedViewFilters;
  shared: boolean;
  ownerId: string;
  isOwn: boolean;
  createdAt: string;
}

/** Dati di creazione di una vista salvata. */
export interface SavedViewDraft {
  name: string;
  filters: SavedViewFilters;
  shared?: boolean;
}

/** Campi modificabili di una vista salvata. */
export interface SavedViewPatch {
  name?: string;
  filters?: SavedViewFilters;
  shared?: boolean;
}

export function listSavedViews(): Promise<SavedView[]> {
  return api.get("/api/saved-views");
}

export function createSavedView(input: SavedViewDraft): Promise<SavedView> {
  return api.post("/api/saved-views", input);
}

export function updateSavedView(id: string, patch: SavedViewPatch): Promise<SavedView> {
  return api.patch(`/api/saved-views/${encodeURIComponent(id)}`, patch);
}

export function deleteSavedView(id: string): Promise<void> {
  return request("DELETE", `/api/saved-views/${encodeURIComponent(id)}`);
}

// --- Comments ---

export interface Comment {
  id: string;
  ticketId: string;
  // "system" copre i commenti generati dalla piattaforma (es. chiusura
  // automatica del ticket al merge della PR): né utente né AI.
  authorType: "user" | "ai" | "system";
  authorId: string | null;
  body: string;
  createdAt: string;
}

export function getComments(ticketId: string): Promise<Comment[]> {
  return api.get(`/api/tickets/${ticketId}/comments`);
}

export function postComment(ticketId: string, body: string): Promise<Comment> {
  return api.post(`/api/tickets/${ticketId}/comments`, { body });
}

// --- Attachments ---

/**
 * Metadato di un allegato. Il binario non passa mai per l'API JSON: si scarica
 * via URL presigned. `downloadUrl` è presente solo nella lista (il server lo
 * firma al volo); la creazione restituisce i soli metadati.
 */
export interface Attachment {
  id: string;
  ticketId: string;
  /** Allegato legato a un commento specifico; null = allegato del ticket. */
  commentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/** Allegato con URL di download presigned a scadenza breve (dalla lista). */
export interface AttachmentWithUrl extends Attachment {
  downloadUrl: string;
}

/**
 * Tipi MIME ammessi dal server per gli allegati. Esposto qui per filtrare in UI
 * (attributo `accept` dell'input file) prima dell'upload: gemello della
 * allowlist server in routes/attachments.ts.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
] as const;

/**
 * Carica un allegato su un ticket via multipart/form-data. Non passa dal
 * wrapper JSON `request`: il browser imposta da sé il Content-Type col boundary
 * a partire dal FormData. `opts.commentId` lega l'allegato a un commento.
 */
export async function uploadAttachment(
  ticketId: string,
  file: File,
  opts?: { commentId?: string },
): Promise<Attachment> {
  const form = new FormData();
  if (opts?.commentId) form.append("commentId", opts.commentId);
  form.append("file", file);

  let response: Response;
  try {
    response = await fetch(`/api/tickets/${ticketId}/attachments`, {
      method: "POST",
      credentials: "include",
      body: form,
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
  return (await response.json()) as Attachment;
}

/** Allegati di un ticket (inclusi quelli legati ai suoi commenti), con downloadUrl. */
export function getTicketAttachments(ticketId: string): Promise<AttachmentWithUrl[]> {
  return api.get(`/api/tickets/${ticketId}/attachments`);
}

/** Rimuove un allegato (uploader o admin): 403 altrimenti. */
export function deleteAttachment(attachmentId: string): Promise<void> {
  return request("DELETE", `/api/attachments/${encodeURIComponent(attachmentId)}`);
}

/**
 * URL dell'endpoint di download di un allegato. Il server fa 302 verso l'URL
 * presigned, quindi questo URL funziona direttamente in `<a href>`/`<img src>`.
 */
export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/download`;
}

// --- AI Jobs ---

export type AIJobStatus =
  | "queued"
  | "triaging"
  | "fixing"
  // "held": triage ha deciso fix ma il gate di automazione lo tiene in attesa
  // di un avvio manuale.
  | "held"
  | "pr_opened"
  | "pr_merged"
  | "failed"
  | "skipped"
  // "pr_closed": la PR aperta dal fix è stata chiusa senza merge (rifiutata da
  // un umano). Stato terminale, distinto da "pr_merged".
  | "pr_closed"
  // "awaiting_plan_approval": il piano prodotto supera la soglia di effort
  // configurata; il job attende l'approvazione umana prima di eseguirlo.
  | "awaiting_plan_approval";

export interface AIJob {
  id: string;
  ticketId: string;
  status: AIJobStatus;
  log: string;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  // Provider AI usato dal job: etichetta e tipo credenziale, null quando il
  // job non ha provider (pre-feature, fallback env, provider eliminato).
  providerLabel: string | null;
  providerKind: "api_key" | "account" | null;
}

export function getTicketJobs(ticketId: string): Promise<AIJob[]> {
  return api.get(`/api/tickets/${ticketId}/jobs`);
}

/**
 * Avvio manuale dell'AI su un ticket: rimette in coda l'ultimo job con il
 * flag manual_trigger, così il worker rifà il triage e procede sul fix
 * scavalcando il gate di automazione (soglia/auto-fix). 202 con l'id del job.
 *
 * Con `withInstructions:true` il job riparte in resume_mode=fix (riprende sul
 * fix senza rifare il triage); senza opzione si rifà il triage da capo.
 */
export function postRunAi(
  ticketId: string,
  opts?: { withInstructions?: boolean },
): Promise<{ jobId: string }> {
  return api.post(`/api/tickets/${ticketId}/run-ai`, opts);
}

/**
 * Approva il piano in attesa sull'ultimo job del ticket: il worker lo eseguirà
 * (resume_mode=execute, piano conservato). 409 se nessun piano è in attesa.
 */
export function approvePlan(ticketId: string): Promise<{ jobId: string }> {
  return api.post(`/api/tickets/${ticketId}/approve-plan`);
}

/**
 * Rifiuta il piano in attesa: il worker ri-pianifica (resume_mode=fix, piano
 * azzerato), incorporando gli eventuali commenti utente. 409 se nessun piano.
 */
export function rejectPlan(ticketId: string): Promise<{ jobId: string }> {
  return api.post(`/api/tickets/${ticketId}/reject-plan`);
}

/** Consumo aggregato di un singolo modello sui job AI del ticket. */
export interface UsageByModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Null quando nessun run del modello riporta un costo. */
  costUsd: number | null;
}

/**
 * Riepilogo dei consumi AI di un ticket: token totali (input+output), costo
 * totale USD (null se nessun run riporta un costo) e dettaglio per modello.
 */
export interface TicketUsage {
  totalTokens: number;
  totalCostUsd: number | null;
  byModel: UsageByModel[];
}

export function getTicketUsage(ticketId: string): Promise<TicketUsage> {
  return api.get(`/api/tickets/${ticketId}/usage`);
}

// --- Activity feed ---

/** Tipo dell'evento di audit di un ticket (gemello dell'enum ticket_event_kind del DB). */
export type TicketEventKind =
  | "status_changed"
  | "assignee_changed"
  | "priority_changed"
  | "type_changed"
  | "labels_changed"
  | "title_changed"
  | "body_changed"
  | "milestone_changed"
  | "relation_added"
  | "relation_removed";

/** Commento nel feed unificato. */
export interface ActivityComment {
  kind: "comment";
  id: string;
  authorType: "user" | "ai" | "system";
  authorId: string | null;
  body: string;
  createdAt: string;
}

/**
 * Evento di audit nel feed. `eventKind` è il tipo di transizione (rinominato
 * lato server da `kind` per non collidere col discriminante del feed);
 * `payload` è il dettaglio jsonb arbitrario (es. { from, to }), o null.
 */
export interface ActivityEvent {
  kind: "event";
  id: string;
  eventKind: TicketEventKind;
  actorId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** Marker di un job AI nel feed: solo stato e PR (log/consumi negli endpoint dedicati). */
export interface ActivityAiJob {
  kind: "ai_job";
  id: string;
  status: AIJobStatus;
  prUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Item del feed: union discriminata su `kind`. */
export type ActivityItem = ActivityComment | ActivityEvent | ActivityAiJob;

/**
 * Feed unificato di un ticket: commenti, eventi di audit e marker dei job AI,
 * ordinati per createdAt crescente. I nomi utente non arrivano dal server
 * (espone authorId/actorId): la UI li risolve dalla users query.
 */
export function getTicketActivity(ticketId: string): Promise<ActivityItem[]> {
  return api.get(`/api/tickets/${ticketId}/activity`);
}

// --- Ticket links (relazioni tra ticket) ---

/** Tipo di relazione canonica memorizzato sul link (gemello dell'enum ticket_link_kind del DB). */
export type TicketLinkKind = "blocks" | "relates_to" | "parent";

/**
 * Relazione vista dal ticket interrogato. Dal lato SOURCE coincide con la kind
 * canonica; dal lato TARGET si inverte: blocks→blocked_by, parent→child,
 * relates_to resta simmetrica.
 */
export type TicketRelation = "blocks" | "blocked_by" | "relates_to" | "parent" | "child";

/** Il link appena creato, come restituito dal POST. */
export interface TicketLink {
  id: string;
  sourceTicketId: string;
  targetTicketId: string;
  kind: TicketLinkKind;
  createdAt: string;
}

/** Un link risolto col ticket "altro", dal punto di vista del ticket interrogato. */
export interface TicketLinkView {
  linkId: string;
  relation: TicketRelation;
  otherTicketId: string;
  otherNumber: number;
  otherTitle: string;
  otherStatus: TicketStatus;
  createdAt: string;
}

/** Le relazioni che coinvolgono il ticket (come source o target). */
export function getTicketLinks(id: string): Promise<TicketLinkView[]> {
  return api.get(`/api/tickets/${id}/links`);
}

/** Crea una relazione source(id) → target con la kind data. */
export function createTicketLink(
  id: string,
  link: { targetTicketId: string; kind: TicketLinkKind },
): Promise<TicketLink> {
  return api.post(`/api/tickets/${id}/links`, link);
}

/** Rimuove un link che coinvolge il ticket (come source o target). */
export function deleteTicketLink(id: string, linkId: string): Promise<void> {
  return request("DELETE", `/api/tickets/${id}/links/${linkId}`);
}

// --- Users ---

/**
 * Utente nella prospettiva della pagina Team: l'identità pubblica più
 * l'istante di registrazione ("membro dal …"). `/api/users` è accessibile a
 * ogni utente autenticato (serve anche al selettore assegnatari).
 */
export interface TeamUser extends PublicUser {
  createdAt: string;
  /** Username Bitbucket linkato, o null se non linkato. */
  bitbucketUsername: string | null;
  /** Email git aliasate a questo membro (per il picker di link in /team). */
  gitIdentities: { id: string; email: string; authorName: string | null }[];
}

export function getUsers(): Promise<TeamUser[]> {
  return api.get("/api/users");
}

/**
 * Membro del workspace Slack per il picker di link (solo admin). Email e
 * avatar sono derivati server-side da Slack. `linkedUserId` è l'utente
 * Stubwise già collegato a questo Slack id, o null.
 */
export interface SlackWorkspaceUser {
  id: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  linkedUserId: string | null;
}

/** Membri del workspace Slack col link Stubwise (solo admin). */
export function getSlackWorkspaceUsers(): Promise<SlackWorkspaceUser[]> {
  return api.get("/api/slack/workspace-users");
}

/**
 * Collega un utente a uno Slack user id (solo admin). L'avatar viene derivato
 * server-side dal profilo Slack. Ritorna l'utente aggiornato.
 */
export function linkUserSlack(userId: string, slackUserId: string): Promise<TeamUser> {
  return api.put(`/api/users/${encodeURIComponent(userId)}/slack`, { slackUserId });
}

/** Scollega l'identità Slack di un utente (solo admin). */
export function unlinkUserSlack(userId: string): Promise<void> {
  return request("DELETE", `/api/users/${encodeURIComponent(userId)}/slack`);
}

/**
 * Autore git realmente osservato dai repo (auto-raccolto dal poller), per il
 * picker di link in /team. `linkedUserId` è l'utente Stubwise già collegato a
 * questa email git (via git_identities), o null.
 */
export interface ObservedAuthor {
  email: string;
  authorName: string | null;
  lastSeenAt: string;
  linkedUserId: string | null;
}

/** Autori git osservati col link Stubwise (solo admin). */
export function getObservedAuthors(): Promise<ObservedAuthor[]> {
  return api.get("/api/git/observed-authors");
}

/**
 * Alia un'email git a un membro (solo admin). Ritorna l'elenco aggiornato
 * delle git identities del membro.
 */
export function linkGitIdentity(
  userId: string,
  email: string,
): Promise<{ id: string; email: string; authorName: string | null }[]> {
  return api.post(`/api/users/${encodeURIComponent(userId)}/git-identities`, { email });
}

/** Rimuove l'alias di un'email git da un membro (solo admin). */
export function unlinkGitIdentity(userId: string, email: string): Promise<void> {
  return request(
    "DELETE",
    `/api/users/${encodeURIComponent(userId)}/git-identities/${encodeURIComponent(email)}`,
  );
}

/**
 * Collega lo username Bitbucket di un utente (solo admin). Ritorna l'utente
 * aggiornato (id + username). 409 `bitbucket_identity_taken` se già di un altro.
 */
export function linkUserBitbucket(
  userId: string,
  username: string,
): Promise<{ id: string; bitbucketUsername: string | null }> {
  return api.put(`/api/users/${encodeURIComponent(userId)}/bitbucket`, { username });
}

/** Scollega lo username Bitbucket di un utente (solo admin). */
export function unlinkUserBitbucket(userId: string): Promise<void> {
  return request("DELETE", `/api/users/${encodeURIComponent(userId)}/bitbucket`);
}

/**
 * Cambia il ruolo di un utente (solo admin). Il server applica i safeguard
 * autoritativi (no auto-cambio, no declassamento dell'ultimo admin): 400
 * `cannot_change_own_role`, 409 `last_admin`, 404 `user_not_found`. Ritorna
 * l'utente aggiornato.
 */
export function updateUserRole(userId: string, role: "admin" | "member"): Promise<TeamUser> {
  return api.patch(`/api/users/${encodeURIComponent(userId)}/role`, { role });
}

// --- Repositories (ex "Project" = singolo repo git) ---

/**
 * Proiezione pubblica di un REPOSITORY: un singolo repo git. Appartiene a
 * esattamente un progetto-gruppo (`projectId`). Porta tutto ciò che è specifico
 * del repo git/webhook/docs. La chiave di ingestion NON ne fa più parte: è
 * salita al {@link Project} (gruppo) in Fase 3 — il repo eredita l'ingestion del
 * progetto. Anche le impostazioni di prodotto (provider AI, auto-update docs)
 * sono sul {@link Project}.
 */
export interface Repository {
  id: string;
  /** Progetto (gruppo) a cui il repository appartiene. */
  projectId: string;
  name: string;
  slug: string;
  provider: GitProviderKind;
  repoUrl: string;
  defaultBranch: string;
  /** Account git che fornisce le credenziali del repository. */
  gitAccountId: string;
  /** Nome dell'account git collegato (per la UI). */
  gitAccountName: string;
  /** ISO dell'ultima configurazione del webhook git, o null se mai configurato. */
  webhookConfiguredAt: string | null;
  /** Comando di test custom della pipeline AI; null = auto-detect (script test del package.json). */
  testCommand: string | null;
  /** Comando di installazione dipendenze custom; null = auto-detect (dal lockfile). */
  installCommand: string | null;
  createdAt: string;
}

/**
 * Credenziali git: write-only. Si inviano alla creazione di un account git o
 * per sostituirle, il server non le restituisce mai.
 */
export interface GitCredentials {
  /** Identità git (username Bitbucket per gli API token / app password legacy). */
  username?: string;
  /** Identità REST API (email Atlassian): solo per gli API token di Bitbucket. */
  email?: string;
  token: string;
}

export interface RepositoryDraft {
  /** Progetto (gruppo) a cui il repository appartiene. */
  projectId: string;
  name: string;
  /** Account git riutilizzabile da cui il repository eredita provider e credenziali. */
  gitAccountId: string;
  repoUrl: string;
  defaultBranch?: string;
  /** Comando di test custom; null/assente = auto-detect (script test del package.json). */
  testCommand?: string | null;
  /** Comando di installazione custom; null/assente = auto-detect (dal lockfile). */
  installCommand?: string | null;
}

export interface RepositoryPatch {
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  /** Assente = l'account collegato resta invariato. */
  gitAccountId?: string;
  /** null = svuota (torna all'auto-detect); assente = invariato. */
  testCommand?: string | null;
  /** null = svuota (torna all'auto-detect dal lockfile); assente = invariato. */
  installCommand?: string | null;
}

/** Elenca i repository, opzionalmente filtrati per progetto (gruppo). */
export function getRepositories(projectId?: string): Promise<Repository[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return api.get(`/api/repositories${qs}`);
}

export function getRepository(slug: string): Promise<Repository> {
  return api.get(`/api/repositories/${encodeURIComponent(slug)}`);
}

/**
 * Config del webhook git di un repository: segreto HMAC + path su cui il
 * provider consegna gli eventi di merge. Endpoint solo admin: i member
 * ricevono 403. Il segreto permette di forgiare webhook, quindi non compare
 * mai nella proiezione pubblica del repository.
 */
export interface RepositoryWebhook {
  webhookSecret: string;
  webhookPath: string;
}

export function getRepositoryWebhook(slug: string): Promise<RepositoryWebhook> {
  return api.get(`/api/repositories/${encodeURIComponent(slug)}/webhook`);
}

export function postRepository(draft: RepositoryDraft): Promise<Repository> {
  return api.post("/api/repositories", draft);
}

export function patchRepository(slug: string, patch: RepositoryPatch): Promise<Repository> {
  return api.patch(`/api/repositories/${encodeURIComponent(slug)}`, patch);
}

// --- Projects (gruppi: raggruppano 1:N repository) ---

/**
 * Proiezione pubblica di un PROGETTO (gruppo): raggruppa 1:N repository. È il
 * livello "prodotto" (ticket e milestone) e porta le impostazioni che valgono
 * per tutti i suoi repository: il provider AI generale (Docs e fix; null =
 * automatico) e l'auto-aggiornamento della documentazione ai push.
 */
export interface Project {
  id: string;
  name: string;
  slug: string;
  /** Descrizione del progetto; null = assente. */
  description: string | null;
  /**
   * Provider AI del progetto (vale per Docs e fix di tutti i suoi repository);
   * null = automatico (catena dei provider abilitati con failover).
   */
  aiProviderId: string | null;
  /** Se true, ogni push sul branch di default di un repo rigenera i suoi Docs. */
  docAutoUpdate: boolean;
  /**
   * Se true, il worker genera ogni notte uno standup dai commit del giorno di
   * tutti i repository del progetto (report attività). Default false.
   */
  dailyReportEnabled: boolean;
  /**
   * Chiave di ingestion del progetto (Fase 3): gli SDK e i webhook inbound la
   * usano per autenticare l'invio di errori/ticket. Salita dal repository al
   * progetto; tutti i repo del gruppo condividono questa chiave.
   */
  ingestionKey: string;
  /** Prossimo numero di ticket del progetto (numerazione per-progetto). */
  nextTicketNumber: number;
  createdAt: string;
}

/** Riepilogo sintetico di un repository nel dettaglio progetto. */
export interface RepositorySummary {
  id: string;
  name: string;
  slug: string;
  provider: GitProviderKind;
}

/** Progetto nella lista: con il conteggio dei repository del gruppo. */
export interface ProjectListItem extends Project {
  repositoryCount: number;
}

/** Dettaglio del progetto: con l'elenco (sintetico) dei suoi repository. */
export interface ProjectDetail extends Project {
  repositories: RepositorySummary[];
}

/** Dati di creazione di un progetto (gruppo). */
export interface ProjectDraft {
  name: string;
  description?: string | null;
  aiProviderId?: string | null;
  docAutoUpdate?: boolean;
  dailyReportEnabled?: boolean;
}

/** Campi modificabili di un progetto (gruppo). Patch parziale. */
export interface ProjectPatch {
  name?: string;
  description?: string | null;
  /** Provider AI del progetto (Docs e fix); null = automatico; assente = invariato. */
  aiProviderId?: string | null;
  /** Toggle auto-aggiornamento Docs ai push; assente = invariato. */
  docAutoUpdate?: boolean;
  /** Toggle standup giornaliero (report attività); assente = invariato. */
  dailyReportEnabled?: boolean;
}

export function getProjects(): Promise<ProjectListItem[]> {
  return api.get("/api/projects");
}

export function getProject(projectId: string): Promise<ProjectDetail> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function postProject(draft: ProjectDraft): Promise<Project> {
  return api.post("/api/projects", draft);
}

export function patchProject(projectId: string, patch: ProjectPatch): Promise<Project> {
  return api.patch(`/api/projects/${encodeURIComponent(projectId)}`, patch);
}

export function deleteProject(projectId: string): Promise<void> {
  return request("DELETE", `/api/projects/${encodeURIComponent(projectId)}`);
}

// --- Repository env files ---

/**
 * Variabile di un file d'ambiente nella proiezione pubblica: solo la CHIAVE e
 * il flag `valueSet` (sempre true: la riga esiste perché un valore è salvato).
 * Il valore è write-only e cifrato at-rest: l'API non lo restituisce MAI.
 */
export interface ProjectEnvVar {
  key: string;
  valueSet: true;
}

/**
 * File d'ambiente di un repository (solo admin): un percorso (es. `.env.local`)
 * con l'elenco delle sue variabili. I valori non transitano mai in lettura.
 */
export interface ProjectEnvFile {
  id: string;
  path: string;
  vars: ProjectEnvVar[];
}

/** Esito di un import: quante chiavi sono state importate e quali. Mai i valori. */
export interface EnvImportResult {
  count: number;
  imported: string[];
}

/** File d'ambiente di un repository (solo admin): 403 per i member. */
export function listEnvFiles(repositoryId: string): Promise<ProjectEnvFile[]> {
  return api.get(`/api/repositories/${encodeURIComponent(repositoryId)}/env-files`);
}

/** Crea un file d'ambiente (solo admin): 400 path non valido, 409 duplicato. */
export function createEnvFile(repositoryId: string, path: string): Promise<ProjectEnvFile> {
  return api.post(`/api/repositories/${encodeURIComponent(repositoryId)}/env-files`, { path });
}

/**
 * Importa variabili da un blob `.env` in un file (solo admin): il server fa il
 * parse di `content`, cifra e salva i valori, e restituisce le sole chiavi
 * importate (mai i valori).
 */
export function importEnvFile(
  repositoryId: string,
  fileId: string,
  content: string,
): Promise<EnvImportResult> {
  return api.post(
    `/api/repositories/${encodeURIComponent(repositoryId)}/env-files/${encodeURIComponent(fileId)}/import`,
    { content },
  );
}

/** Imposta/sostituisce il valore (write-only) di una variabile (solo admin). */
export function setEnvVar(
  repositoryId: string,
  fileId: string,
  key: string,
  value: string,
): Promise<ProjectEnvVar> {
  return api.put(
    `/api/repositories/${encodeURIComponent(repositoryId)}/env-files/${encodeURIComponent(fileId)}/vars/${encodeURIComponent(key)}`,
    { value },
  );
}

/** Elimina una variabile da un file d'ambiente (solo admin). */
export function deleteEnvVar(repositoryId: string, fileId: string, key: string): Promise<void> {
  return request(
    "DELETE",
    `/api/repositories/${encodeURIComponent(repositoryId)}/env-files/${encodeURIComponent(fileId)}/vars/${encodeURIComponent(key)}`,
  );
}

/** Elimina un file d'ambiente con tutte le sue variabili (solo admin). */
export function deleteEnvFile(repositoryId: string, fileId: string): Promise<void> {
  return request(
    "DELETE",
    `/api/repositories/${encodeURIComponent(repositoryId)}/env-files/${encodeURIComponent(fileId)}`,
  );
}

// --- Git accounts ---

/** Esito di un singolo controllo di validazione credenziali (gemello del tipo server). */
export interface CredentialCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidateCredentialsResult {
  ok: boolean;
  checks: CredentialCheck[];
}

/**
 * Account git riutilizzabile: proiezione pubblica (mai le credenziali, che
 * vivono cifrate at-rest e write-only sul server). Un account può essere
 * collegato a più progetti.
 */
export interface GitAccount {
  id: string;
  name: string;
  provider: GitProviderKind;
  // Slug del workspace Bitbucket (null per GitHub). Serve a elencare/validare i
  // repo Bitbucket: gli endpoint account/globali sono stati dismessi (410).
  workspace: string | null;
  createdAt: string;
}

/** Creazione di un account git (solo admin): nome, provider, credenziali e
 * (solo Bitbucket) lo slug del workspace. */
export interface GitAccountDraft {
  name: string;
  provider: GitProviderKind;
  credentials: GitCredentials;
  workspace?: string;
}

/**
 * Modifica di un account git (solo admin): nome, credenziali e/o workspace.
 * Credenziali assenti = quelle salvate restano invariate (non si possono svuotare).
 */
export interface GitAccountPatch {
  name?: string;
  credentials?: GitCredentials;
  workspace?: string;
}

/** Repository scoperto su un account git (per il picker del wizard). */
export interface RepoSummary {
  fullName: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string | null;
}

/** Branch di un repository: elenco + branch di default dichiarato dal provider. */
export interface AccountBranches {
  branches: string[];
  defaultBranch: string | null;
}

/** Account git visibili (auth): serve al selettore in creazione progetto. */
export function getGitAccounts(): Promise<GitAccount[]> {
  return api.get("/api/git-accounts");
}

export function getGitAccount(id: string): Promise<GitAccount> {
  return api.get(`/api/git-accounts/${id}`);
}

export function postGitAccount(draft: GitAccountDraft): Promise<GitAccount> {
  return api.post("/api/git-accounts", draft);
}

export function patchGitAccount(id: string, patch: GitAccountPatch): Promise<GitAccount> {
  return api.patch(`/api/git-accounts/${id}`, patch);
}

/** Elimina un account git (solo admin): 409 se è collegato a un progetto. */
export function deleteGitAccount(id: string): Promise<void> {
  return request("DELETE", `/api/git-accounts/${encodeURIComponent(id)}`);
}

/**
 * Valida le credenziali memorizzate di un account git (solo admin): autentica
 * e verifica gli scope per push git + PR + webhook. Ritorna i singoli check.
 */
export function postValidateGitAccount(id: string): Promise<ValidateCredentialsResult> {
  return api.post(`/api/git-accounts/${id}/validate`);
}

// --- Provider AI ---

/** Tipo di credenziale di un provider AI: chiave API o account/abbonamento. */
export type AiProviderKind = "api_key" | "account";

/**
 * Stato dell'ultimo test della credenziale: `idle` (mai testata), `pending`
 * (richiesta, in attesa del worker che esegue il `claude -p` di prova),
 * `passed`/`failed` (esito).
 */
export type AiProviderTestStatus = "idle" | "pending" | "passed" | "failed";

/**
 * Provider AI configurato dall'admin: proiezione pubblica (mai la secret, che
 * vive cifrata at-rest e write-only sul server). `position` dà l'ordine di
 * failover; `secretSet` è sempre true (la secret esiste, non si espone). I campi
 * `test*` riportano l'esito dell'ultimo test della credenziale (lo esegue il
 * worker; `testError` è il messaggio dell'ultimo fallimento, mai il segreto).
 */
export interface AiProvider {
  id: string;
  kind: AiProviderKind;
  label: string;
  position: number;
  enabled: boolean;
  secretSet: boolean;
  createdAt: string;
  testStatus: AiProviderTestStatus;
  testRequestedAt: string | null;
  testCheckedAt: string | null;
  testError: string | null;
}

/** Creazione di un provider AI (solo admin): la secret è write-only. */
export interface AiProviderDraft {
  kind: AiProviderKind;
  label: string;
  secret: string;
  position?: number;
}

/**
 * Modifica di un provider AI (solo admin). `secret` assente = quella salvata
 * resta invariata (non si può svuotare: per rimuoverla si elimina il provider).
 */
export interface AiProviderPatch {
  label?: string;
  secret?: string;
  enabled?: boolean;
  position?: number;
}

/** Provider AI configurati (solo admin), ordinati per position di failover. */
export function listAiProviders(): Promise<AiProvider[]> {
  return api.get("/api/ai-providers");
}

export function createAiProvider(draft: AiProviderDraft): Promise<AiProvider> {
  return api.post("/api/ai-providers", draft);
}

export function updateAiProvider(id: string, patch: AiProviderPatch): Promise<AiProvider> {
  return api.patch(`/api/ai-providers/${id}`, patch);
}

export function deleteAiProvider(id: string): Promise<void> {
  return request("DELETE", `/api/ai-providers/${encodeURIComponent(id)}`);
}

/**
 * Riordina i provider AI (solo admin): `orderedIds` deve elencare ESATTAMENTE
 * tutti i provider esistenti nell'ordine di failover desiderato. Il server
 * riscrive le position 0..n-1 in transazione e restituisce la lista aggiornata.
 */
export function reorderAiProviders(orderedIds: string[]): Promise<AiProvider[]> {
  return api.post("/api/ai-providers/reorder", { orderedIds });
}

/**
 * Richiede un test della credenziale (solo admin): il server marca la richiesta
 * `pending` e il worker esegue un `claude -p` di prova con quella credenziale,
 * poi scrive l'esito (`passed`/`failed`). La UI fa polling sulla lista finché lo
 * stato non lascia `pending`. Restituisce il provider con `testStatus: pending`.
 */
export function testAiProvider(id: string): Promise<AiProvider> {
  return api.post(`/api/ai-providers/${encodeURIComponent(id)}/test`);
}

/**
 * Verifica REPO-SPECIFICA delle credenziali dell'account su un repo scelto
 * (solo admin): sonda i tre check che richiedono un repo reale — push git,
 * REST/PR e webhook. Advisory nel wizard: anche se rossa non blocca la
 * creazione del progetto (la config webhook è opzionale).
 */
export function getValidateAccountRepo(
  id: string,
  repoFullName: string,
): Promise<ValidateCredentialsResult> {
  return api.get(`/api/git-accounts/${id}/validate-repo?repo=${encodeURIComponent(repoFullName)}`);
}

/** Elenca i repository accessibili dall'account git (solo admin). */
export function getAccountRepositories(id: string): Promise<RepoSummary[]> {
  return api.get(`/api/git-accounts/${id}/repositories`);
}

/** Elenca i branch di un repository dell'account git (solo admin). */
export function getAccountBranches(id: string, repoFullName: string): Promise<AccountBranches> {
  return api.get(`/api/git-accounts/${id}/branches?repo=${encodeURIComponent(repoFullName)}`);
}

/** Esito della configurazione automatica del webhook (gemello del tipo server). */
export interface ConfigureWebhookResult {
  ok: true;
  created: boolean;
  updated: boolean;
  detail: string;
  url: string;
}

/**
 * Registra in modo idempotente il webhook PR-merged sul provider git usando le
 * credenziali del repository. Endpoint solo admin. Su scope insufficiente l'API
 * risponde con un 4xx e un messaggio di guida, propagato come errore.
 */
export function postConfigureWebhook(slug: string): Promise<ConfigureWebhookResult> {
  return api.post(`/api/repositories/${encodeURIComponent(slug)}/configure-webhook`);
}

// --- Settings: automazione AI ---

/**
 * Regola di automazione AI per un tipo di ticket: l'auto-fix parte solo se
 * `autoFix` è attivo E l'effort stimato è <= `maxEffort`. Una per ciascuno
 * dei 4 tipi.
 */
export interface AutomationRule {
  type: TicketType;
  autoFix: boolean;
  /** Soglia di sforzo 1–5: auto-fix solo se effort <= maxEffort. */
  maxEffort: number;
  /**
   * Soglia di sforzo 1–5 oltre la quale (effort >= soglia) il fix richiede
   * l'approvazione umana del piano. null = mai (nessun gate di approvazione).
   */
  planApprovalMinEffort: number | null;
  /**
   * Tetto di costo USD per singolo ticket: se la spesa AI lo supera, il job
   * viene tenuto in attesa (held). null = nessun tetto.
   */
  maxCostUsd: number | null;
}

/**
 * Impostazioni della review automatica delle PR: se attiva, un agente AI
 * recensisce ogni pull request aperta o aggiornata sul repo collegato.
 */
export interface PrReviewSettings {
  enabled: boolean;
  /** Tetto di costo USD per singola review; null = nessun limite. */
  maxCostUsd: number | null;
}

export interface AutomationSettings {
  rules: AutomationRule[];
  prReview: PrReviewSettings;
}

/** Regole di automazione AI (solo admin): 403 per i member. */
export function getAutomationSettings(): Promise<AutomationSettings> {
  return api.get("/api/settings/automation");
}

/** Upsert delle regole di automazione AI (solo admin). Ritorna lo stato aggiornato. */
export function putAutomationSettings(
  rules: AutomationRule[],
  prReview: PrReviewSettings,
): Promise<AutomationSettings> {
  return api.put("/api/settings/automation", { rules, prReview });
}

// --- Settings: notifiche webhook ---

/** Formato del messaggio del webhook di notifica in uscita. */
export type NotificationFormat = "slack" | "discord" | "generic";

/**
 * Configurazione (riga singola) del webhook di notifica in uscita. Il webhook
 * non è un segreto (lo conosce chi lo configura): viene restituito così com'è.
 */
export interface NotificationSettings {
  /** URL https del webhook; null = nessun webhook configurato. */
  webhookUrl: string | null;
  format: NotificationFormat;
  /** Interruttore generale: false = nessuna notifica, qualunque sia il toggle. */
  enabled: boolean;
  notifyTicketCreated: boolean;
  notifyPrOpened: boolean;
  /** PR chiusa senza merge → il ticket viene riaperto. */
  notifyPrClosed: boolean;
  notifyJobHeld: boolean;
  /** Un piano AI è in attesa di approvazione umana. */
  notifyPlanReview: boolean;
  /** Il budget di costo è stato superato e il job è stato tenuto in attesa. */
  notifyBudgetHeld: boolean;
  /** La review AI di una PR è stata completata (verdetto pubblicato). */
  notifyReviewCompleted: boolean;
  notifyJobFailed: boolean;
  /** Generazione Docs in pausa per limite di utilizzo del provider. */
  notifyDocsLimitPaused: boolean;
  /** Alert di monitoraggio server (allarme superamento soglia/offline e recovery). */
  notifyMonitor: boolean;
}

/** Esito dell'invio di una notifica di test (lo restituisce l'endpoint /test). */
export interface TestNotificationResult {
  ok: boolean;
  detail: string;
}

/** Impostazioni notifiche (solo admin): 403 per i member. */
export function getNotificationSettings(): Promise<NotificationSettings> {
  return api.get("/api/settings/notifications");
}

/** Upsert della configurazione notifiche (solo admin). Ritorna lo stato aggiornato. */
export function putNotificationSettings(
  settings: NotificationSettings,
): Promise<NotificationSettings> {
  return api.put("/api/settings/notifications", {
    // webhookUrl null → "" (il server lo ritrasforma in null): il body è sempre
    // ben formato qualunque sia lo stato del campo.
    webhookUrl: settings.webhookUrl ?? "",
    format: settings.format,
    enabled: settings.enabled,
    notifyTicketCreated: settings.notifyTicketCreated,
    notifyPrOpened: settings.notifyPrOpened,
    notifyPrClosed: settings.notifyPrClosed,
    notifyJobHeld: settings.notifyJobHeld,
    notifyPlanReview: settings.notifyPlanReview,
    notifyBudgetHeld: settings.notifyBudgetHeld,
    // Il server ha un default (true) su questo campo: va inviato SEMPRE
    // esplicitamente per non resettare la scelta dell'utente.
    notifyReviewCompleted: settings.notifyReviewCompleted,
    notifyJobFailed: settings.notifyJobFailed,
    // Anche qui il default server è true: inviarlo sempre esplicitamente.
    notifyDocsLimitPaused: settings.notifyDocsLimitPaused,
    // Default server true: inviarlo sempre esplicitamente per non resettarlo.
    notifyMonitor: settings.notifyMonitor,
  });
}

/** Invia una notifica di test al webhook configurato (solo admin). */
export function postTestNotification(): Promise<TestNotificationResult> {
  return api.post("/api/settings/notifications/test");
}

// --- Settings: lingua dei contenuti d'istanza ---

/**
 * Impostazioni d'istanza (riga singola). `contentLanguage` è la lingua usata
 * per i CONTENUTI generati dalla piattaforma — commenti AI, report PR e
 * messaggi di notifica — distinta dalla lingua dell'interfaccia del singolo
 * utente (vedi `patchMyLanguage`).
 */
export interface InstanceSettings {
  contentLanguage: Language;
  /**
   * Budget di costo AI mensile in USD per l'intera istanza; superato il tetto i
   * nuovi job vengono tenuti in attesa. null = nessun budget.
   */
  monthlyBudgetUsd: number | null;
  /** Endpoint dello storage S3-compatibile; null = non impostato. */
  s3Endpoint: string | null;
  /** Region S3 (gli S3-compatibili usano spesso "auto"); null = non impostato. */
  s3Region: string | null;
  s3Bucket: string | null;
  s3AccessKey: string | null;
  /**
   * La secret S3 è write-only: il server NON la restituisce mai. Questo flag dice
   * solo SE una secret è salvata, così la UI può mostrare il placeholder "set".
   */
  s3SecretKeySet: boolean;
  /** true se la config S3 è completa e valida → gli allegati sono attivi. */
  attachmentsEnabled: boolean;
  /**
   * Il signing secret Slack è write-only: il server NON lo restituisce mai.
   * Questo flag dice solo SE è salvato, così la UI mostra il placeholder "set".
   */
  slackSigningSecretSet: boolean;
  /** Come sopra per il bot token Slack: write-only, mai restituito. */
  slackBotTokenSet: boolean;
  /** true se entrambi i segreti Slack sono presenti → l'integrazione è attiva. */
  slackEnabled: boolean;
}

/**
 * Patch delle impostazioni d'istanza. `contentLanguage` è sempre richiesto (il
 * PUT del server lo riscrive). I campi S3 sono opzionali: presenti → aggiornano
 * ("" azzera lato server); assenti → invariati. La secret segue la regola
 * write-only: ASSENTE → non tocca; "" → azzera; valore → cifra e salva.
 */
export interface InstanceSettingsPatch {
  contentLanguage: Language;
  monthlyBudgetUsd?: number | null;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  /**
   * Segreti Slack write-only, stessa regola della secret S3: ASSENTE → non
   * tocca; "" → azzera; valore → cifra e salva.
   */
  slackSigningSecret?: string;
  slackBotToken?: string;
}

/** Impostazioni d'istanza (solo admin): 403 per i member. */
export function getInstanceSettings(): Promise<InstanceSettings> {
  return api.get("/api/settings/instance");
}

/**
 * Upsert delle impostazioni d'istanza (solo admin). Il PUT del server riscrive
 * sempre contentLanguage e monthlyBudgetUsd, quindi si invia sempre lo stato
 * completo per quei campi. I campi S3 si inviano solo quando li si vuole
 * modificare (vedi {@link InstanceSettingsPatch}). Ritorna lo stato aggiornato.
 */
export function putInstanceSettings(patch: InstanceSettingsPatch): Promise<InstanceSettings> {
  return api.put("/api/settings/instance", patch);
}

// --- Dashboard consumi AI (costi/token) ---

/** Totali del periodo: costo USD, token (in/out/cache) e job conteggiati. */
export interface AiUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  jobs: number;
}

/** Una riga della serie temporale: consumi aggregati di un giorno (UTC). */
export interface AiUsageByDay {
  /** Giorno YYYY-MM-DD (UTC). */
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  jobs: number;
}

/** Consumi aggregati per modello. */
export interface AiUsageByModel {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Consumi aggregati per progetto (con nome). */
export interface AiUsageByProject {
  projectId: string;
  projectName: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Consumi aggregati per provider AI. `providerId`/`providerLabel` null = job
 * eseguiti senza provider configurato (credenziale da env/default).
 */
export interface AiUsageByProvider {
  providerId: string | null;
  providerLabel: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Dashboard consumi AI: totali del periodo più le ripartizioni per giorno,
 * modello, progetto e provider. `range` riporta gli istanti ISO effettivamente
 * applicati dal server (default: ultimi 30 giorni). I costi NULL contano 0.
 */
export interface AiUsageCosts {
  range: { from: string; to: string };
  totals: AiUsageTotals;
  byDay: AiUsageByDay[];
  byModel: AiUsageByModel[];
  byProject: AiUsageByProject[];
  byProvider: AiUsageByProvider[];
}

/** Filtro del range della dashboard consumi: date ISO YYYY-MM-DD. */
export interface AiUsageCostsParams {
  from?: string;
  to?: string;
}

/**
 * Aggregazione dei consumi AI nel range (solo admin). Senza parametri il server
 * applica gli ultimi 30 giorni; `from`/`to` (YYYY-MM-DD) restringono la finestra.
 */
export function getAiUsageCosts(params: AiUsageCostsParams = {}): Promise<AiUsageCosts> {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const qs = search.toString();
  return api.get(`/api/ai-usage/costs${qs ? `?${qs}` : ""}`);
}

// --- Usage residuo abbonamento (ultimo snapshot per credenziale account) ---

/**
 * Finestra di consumo normalizzata: percentuale usata e residua, più
 * `resetsLabel`, l'orario di reset come label testuale della TUI di claude
 * (non-ISO, es. "2:39pm (Europe/Rome)"); null/assente se non disponibile.
 */
export interface UsageWindow {
  percentUsed: number;
  percentRemaining: number;
  resetsLabel?: string | null;
}

/**
 * Ultimo snapshot di consumo di una credenziale `account` (solo admin).
 * `rawText` è presente SOLO quando `parseOk=false`: è l'output grezzo di
 * `/usage` da cui il parser deterministico non ha estratto nulla, mostrato nel
 * banner di diagnosi. Con `parseOk=true` è assente/null.
 */
export interface AiUsageSnapshot {
  providerId: string;
  providerLabel: string;
  capturedAt: string;
  sessionRemaining: UsageWindow | null;
  weeklyRemaining: UsageWindow | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  source: "deterministic" | "llm_fallback";
  parseOk: boolean;
  rawText?: string | null;
}

/**
 * Ultimo snapshot di consumo per ciascuna credenziale `account` (solo admin).
 * Un item per account; nessuno per le credenziali senza snapshot ancora.
 */
export function getAiUsageSnapshots(): Promise<AiUsageSnapshot[]> {
  return api.get("/api/ai-usage/snapshots");
}

// --- Ricerca globale (spotlight Cmd/K) ---

export type {
  SearchResults,
  SearchTicketHit,
  SearchProjectHit,
  SearchRepositoryHit,
  SearchDocHit,
  SearchDocSemanticHit,
  SearchDocsSemanticResults,
  SearchHistoryItem,
  SearchEntityType,
} from "@stubwise/shared";

/**
 * Corsia VELOCE della ricerca globale: full-text federato su ticket/progetti/
 * repository/docs. `repositoryId` (scope Docs) ristringe SOLO il gruppo docs; gli
 * altri gruppi restano globali. Gemella di `GET /api/search`.
 */
export function getSearch(q: string, repositoryId?: string): Promise<SearchResults> {
  const params = new URLSearchParams({ q });
  if (repositoryId) params.set("repositoryId", repositoryId);
  return api.get(`/api/search?${params.toString()}`);
}

/**
 * Corsia LENTA della ricerca globale: retrieval SEMANTICO sui Docs, che il client
 * fonde nel gruppo Docs (dedup per `(repositoryId, slug)`, semantica prima).
 * `repositoryId` restringe il retrieval a quel repository; altrimenti globale.
 * Best-effort lato server (mai un errore): lista vuota se non disponibile.
 */
export function getDocsSemantic(
  q: string,
  repositoryId?: string,
): Promise<SearchDocsSemanticResults> {
  const params = new URLSearchParams({ q });
  if (repositoryId) params.set("repositoryId", repositoryId);
  return api.get(`/api/search/docs-semantic?${params.toString()}`);
}

/**
 * Cronologia unificata (recenti) dell'utente corrente: a query vuota alimenta i
 * "recenti" della palette. `repositoryId` (scope Docs) filtra a quel repository.
 */
export function getSearchHistory(repositoryId?: string): Promise<SearchHistoryItem[]> {
  const qs = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
  return api.get(`/api/search/history${qs}`);
}

/** Registra (upsert) un risultato cliccato nella cronologia: ritorna 204. */
export function postSearchHistory(body: RecordSearchHistoryBody): Promise<void> {
  return api.post("/api/search/history", body);
}

/** Rimuove una singola voce (per tipo+entità) della cronologia: ritorna 204. */
export function deleteSearchHistoryEntry(
  type: SearchEntityType,
  entityId: string,
): Promise<void> {
  return request(
    "DELETE",
    `/api/search/history/${encodeURIComponent(type)}/${encodeURIComponent(entityId)}`,
  );
}

/** Svuota tutta la cronologia dell'utente corrente: ritorna 204. */
export function deleteSearchHistory(): Promise<void> {
  return request("DELETE", "/api/search/history");
}

// --- Widget di assistenza (CRUD per-progetto) ---

/**
 * Un widget di assistenza di un progetto, come lo espone la lista
 * `/api/projects/:projectId/widgets`. Estende la config (gemella di
 * `widgetSettingsSchema` di @stubwise/shared) con l'identità (`name`), la
 * `key` (chiave immutabile che entra nel DSN dello snippet), i cap giornalieri
 * per-widget (`null` = default d'istanza) e i conteggi (`conversationCount`).
 * `enabledRepositoryIds` è la whitelist dei repository i cui Docs alimentano il
 * retrieval della chat: vuota = nessuna fonte (il widget risponderà di non
 * avere informazioni).
 */
export interface Widget extends WidgetSettings {
  id: string;
  name: string;
  /**
   * Filtro FINE per-repo (path filter): per ogni repository esposto, i prefissi
   * di `sourcePath`, gli `slugs` espliciti e/o i `kinds` (interi gruppi
   * doc_page_kind, semantica viva) a cui limitare il retrieval della chat. Le
   * chiavi sono un sottoinsieme di `enabledRepositoryIds` (garantito in
   * scrittura). Round-trip completo verso la SPA; `{}` = nessun filtro fine.
   */
  repositoryFilters: WidgetRepositoryFilters;
  /** Chiave immutabile del widget: entra nel DSN dello snippet (al posto della ingestionKey). */
  key: string;
  /** Cap giornaliero di messaggi; null = usa il default d'istanza (env). */
  dailyMessageCap: number | null;
  /** Cap giornaliero di ticket; null = usa il default d'istanza (env). */
  dailyTicketCap: number | null;
  createdAt: string;
  /** Numero di conversazioni collegate a questo widget. */
  conversationCount: number;
}

/**
 * Lista dei widget di un progetto, ordinata per createdAt asc. Lettura per ogni
 * utente autenticato; le scritture (create/update/delete) sono solo admin.
 */
export function getWidgets(projectId: string): Promise<{ widgets: Widget[] }> {
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/widgets`);
}

/**
 * Crea un widget (solo admin). 422 `invalid_repository` se un id in
 * `enabledRepositoryIds` non è un repository di questo progetto. Ritorna il
 * widget creato (con la sua `key` appena generata).
 */
export function createWidget(
  projectId: string,
  body: WidgetUpsertBody,
): Promise<{ widget: Widget }> {
  return api.post(`/api/projects/${encodeURIComponent(projectId)}/widgets`, body);
}

/**
 * Aggiorna un widget esistente (solo admin). Il PUT è completo: si invia sempre
 * lo stato intero (la `key` è immutabile e non fa parte del body). 422
 * `invalid_repository` come in create. Ritorna il widget aggiornato.
 */
export function updateWidget(
  projectId: string,
  widgetId: string,
  body: WidgetUpsertBody,
): Promise<{ widget: Widget }> {
  return api.put(
    `/api/projects/${encodeURIComponent(projectId)}/widgets/${encodeURIComponent(widgetId)}`,
    body,
  );
}

/**
 * Elimina un widget (solo admin). Le conversazioni restano (widgetId nullato);
 * lo snippet installato con la sua `key` smette di funzionare. 204 No Content.
 */
export function deleteWidget(projectId: string, widgetId: string): Promise<void> {
  return api.delete(
    `/api/projects/${encodeURIComponent(projectId)}/widgets/${encodeURIComponent(widgetId)}`,
  );
}

// --- Widget: viewer conversazioni (superficie SPA read-only) ---

/**
 * Riepilogo di una conversazione widget nel viewer interno: identità
 * dell'utente esterno (name/email/id, name ed email possono mancare), istanti
 * di creazione e ultimo messaggio, più i conteggi aggregati di messaggi e di
 * messaggi che hanno aperto un ticket. `widgetId`/`widgetName` identificano il
 * widget d'origine e sono null per le conversazioni orfane (widget eliminato).
 * Ordinato dal server per lastMessageAt desc.
 */
export interface WidgetConversationSummary {
  id: string;
  externalUserId: string;
  externalUserEmail: string | null;
  externalUserName: string | null;
  widgetId: string | null;
  widgetName: string | null;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  ticketCount: number;
}

/**
 * Un messaggio nel filo di una conversazione widget. `citations` è jsonb a forma
 * libera (le fonti Docs della risposta RAG), tipato `unknown`: la UI lo legge con
 * un type guard. `ticketId` non nullo = il messaggio ha aperto un ticket.
 */
export interface WidgetConversationMessage {
  id: string;
  role: string;
  content: string;
  citations: unknown;
  ticketId: string | null;
  createdAt: string;
}

/**
 * Identità dell'utente esterno di una conversazione (header del dettaglio).
 * `widgetName` è il nome del widget d'origine, null per le conversazioni orfane
 * (widget eliminato).
 */
export interface WidgetConversationIdentity {
  id: string;
  externalUserId: string;
  externalUserEmail: string | null;
  externalUserName: string | null;
  widgetName: string | null;
  createdAt: string;
}

/** Filo completo di una conversazione: identità + messaggi in ordine cronologico. */
export interface WidgetConversationThread {
  conversation: WidgetConversationIdentity;
  messages: WidgetConversationMessage[];
}

/**
 * Elenco delle conversazioni widget di un progetto per il viewer interno,
 * ordinate lastMessageAt desc. Con `ticketId` si restringe alla sola
 * conversazione che contiene un messaggio con quel ticket (link "Vedi
 * conversazione" dal dettaglio ticket). Con `widgetId` si filtra al singolo
 * widget d'origine; i due filtri sono componibili.
 */
export function getWidgetConversations(
  projectId: string,
  opts?: { limit?: number; ticketId?: string; widgetId?: string },
): Promise<{ conversations: WidgetConversationSummary[] }> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.ticketId) params.set("ticketId", opts.ticketId);
  if (opts?.widgetId) params.set("widgetId", opts.widgetId);
  const qs = params.toString();
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/widget/conversations${qs ? `?${qs}` : ""}`,
  );
}

/** Filo completo di una conversazione widget (identità + messaggi). 404 se la
 * conversazione non appartiene al progetto. */
export function getWidgetConversationMessages(
  projectId: string,
  conversationId: string,
): Promise<WidgetConversationThread> {
  return api.get(
    `/api/projects/${encodeURIComponent(projectId)}/widget/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
}

// --- Server monitoring (sezione Monitor) ---

// Enum e schemi condivisi col server/agente: ri-esportati così i componenti
// della sezione Monitor importano tutto il dominio da ./api (come i tipi propri).
export type {
  AlertThresholds,
  CheckStatus,
  CheckType,
  CreateCheckInput,
  DiscoveredService,
  ServerStatus,
  ServiceSource,
  UpdateCheckInput,
  UpdateServerInput,
} from "@stubwise/shared";

/** Progetto associato a un server, ridotto ai campi per la UI (id + nome). */
export interface ServerProjectSummary {
  id: string;
  name: string;
}

/**
 * Proiezione pubblica di un server monitorato (lista e base del dettaglio):
 * anagrafica, stato calcolato dall'heartbeat, progetti associati, conteggi
 * check e la coda di CPU recente per la sparkline. Non contiene MAI la chiave
 * dell'agente (esposta solo da {@link ServerWithKey} a creazione/rigenerazione).
 * Gemella di `serverViewSchema` di apps/server/src/routes/servers.ts.
 */
export interface ServerView {
  id: string;
  name: string;
  /** Hostname dichiarato dall'agente al primo ingest; null se mai connesso. */
  hostname: string | null;
  status: ServerStatus;
  sampleIntervalSeconds: number;
  /** Versione dell'agente all'ultimo ingest; null se mai connesso. */
  agentVersion: string | null;
  alertThresholds: AlertThresholds;
  /** ISO dell'ultimo heartbeat; null se il server non ha mai inviato campioni. */
  lastSeenAt: string | null;
  createdAt: string;
  projects: ServerProjectSummary[];
  checksUp: number;
  checksDown: number;
  /** Ultimi valori di CPU dai campioni fini, dal più vecchio al più recente. */
  recentCpu: number[];
}

/**
 * Server con la chiave dell'agente (`sk_…`) in chiaro: restituito SOLO da
 * creazione e rigenerazione, una sola volta (in DB vive solo l'hash).
 */
export interface ServerWithKey extends ServerView {
  key: string;
}

/** Uso di un disco per punto di mount (dettaglio server, ultimo campione). */
export interface ServerDisk {
  mount: string;
  usedBytes: number;
  totalBytes: number;
}

/**
 * Dettaglio di un server (solo GET /:id): la proiezione base più lo snapshot
 * corrente dall'ultimo campione — servizi auto-scoperti (docker/pm2), dischi per
 * mount e il ts del campione (`metricsAt`, per marcare dati stantii in UI).
 * Vuoti/null se il server non ha mai inviato campioni. Gemella di
 * `serverDetailSchema`.
 */
export interface ServerDetail extends ServerView {
  services: DiscoveredService[];
  disks: ServerDisk[];
  metricsAt: string | null;
}

/**
 * Proiezione pubblica di un check di servizio. Il DSN dei check DB non esce MAI
 * dall'API: al suo posto il flag `hasDsn` (per i check DB `target` è sempre
 * vuoto). Gemella di `checkViewSchema` di apps/server/src/routes/servers-checks.ts.
 */
export interface ServerCheck {
  id: string;
  serverId: string;
  type: CheckType;
  name: string;
  /** URL/host:porta/pattern in chiaro; vuoto per i check DB (DSN → `hasDsn`). */
  target: string;
  hasDsn: boolean;
  intervalSeconds: number;
  enabled: boolean;
  lastStatus: CheckStatus;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  downSince: string | null;
  createdAt: string;
}

/** Punto metrica a risoluzione piena (campione host grezzo). */
export interface RawMetricPoint {
  ts: string;
  cpuPct: number;
  load1m: number;
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}

/** Punto metrica aggregato a 5 minuti (rollup): coppie avg/max + somme di rete. */
export interface RollupMetricPoint {
  ts: string;
  cpuPctAvg: number;
  cpuPctMax: number;
  load1mAvg: number;
  load1mMax: number;
  memUsedBytesAvg: number;
  memUsedBytesMax: number;
  memTotalBytes: number;
  diskUsedBytesAvg: number;
  diskUsedBytesMax: number;
  diskTotalBytes: number;
  netRxBytesSum: number;
  netTxBytesSum: number;
}

/** Esito di check a risoluzione piena. */
export interface RawCheckPoint {
  ts: string;
  status: CheckStatus;
  latencyMs: number | null;
}

/** Esito di check aggregato a 5 minuti (rollup). */
export interface RollupCheckPoint {
  ts: string;
  upCount: number;
  downCount: number;
  latencyMsAvg: number | null;
  latencyMsMax: number | null;
}

/**
 * Serie temporale di un server nel range richiesto: UNIONE DISCRIMINATA su
 * `resolution`, scelta dal server dall'ampiezza del range (`raw` fino a 48h,
 * `5m` oltre). Un `if (res.resolution === "raw")` restringe in blocco sia
 * `points` sia `checkPoints` alla forma giusta (mai serie miste). `checkPoints`
 * è presente solo se la query passa un `checkId`. `truncated` = una serie ha
 * saturato il tetto di punti e la finestra mostrata è la coda più recente del
 * range. Gemella di `metricsResponseSchema`.
 */
export type ServerMetricsResponse =
  | {
      resolution: "raw";
      truncated: boolean;
      points: RawMetricPoint[];
      checkPoints?: RawCheckPoint[];
    }
  | {
      resolution: "5m";
      truncated: boolean;
      points: RollupMetricPoint[];
      checkPoints?: RollupCheckPoint[];
    };

/** Finestra temporale (ISO datetime) di una query metriche, con check opzionale. */
export interface ServerMetricsRange {
  from: string;
  to: string;
  checkId?: string;
}

/** Elenca i server monitorati, opzionalmente filtrati per progetto associato. */
export function listServers(projectId?: string): Promise<ServerView[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return api.get(`/api/servers${qs}`);
}

/** Dettaglio di un server (snapshot corrente incluso). 404 se inesistente. */
export function getServer(id: string): Promise<ServerDetail> {
  return api.get(`/api/servers/${encodeURIComponent(id)}`);
}

/**
 * Registra un nuovo server (solo admin): l'utente fornisce solo il nome. La
 * risposta include la chiave dell'agente in chiaro, mostrata una sola volta.
 */
export function createServer(name: string): Promise<ServerWithKey> {
  return api.post("/api/servers", { name });
}

/**
 * Patch parziale di un server (solo admin). ATTENZIONE `alertThresholds`:
 * full-replacement (i campi omessi tornano ai default), inviare sempre le soglie
 * complete correnti; `projectIds` sostituisce l'intero insieme di progetti.
 */
export function updateServer(id: string, body: UpdateServerInput): Promise<ServerView> {
  return api.patch(`/api/servers/${encodeURIComponent(id)}`, body);
}

/** Elimina un server con metriche/check associati (solo admin): 204. */
export function deleteServer(id: string): Promise<void> {
  return request("DELETE", `/api/servers/${encodeURIComponent(id)}`);
}

/**
 * Rigenera la chiave dell'agente di un server (solo admin): invalida la
 * precedente e restituisce la nuova in chiaro, una sola volta.
 */
export function regenerateServerKey(id: string): Promise<ServerWithKey> {
  return api.post(`/api/servers/${encodeURIComponent(id)}/regenerate-key`);
}

/** Elenca i check di servizio di un server. 404 se il server non esiste. */
export function listServerChecks(id: string): Promise<ServerCheck[]> {
  return api.get(`/api/servers/${encodeURIComponent(id)}/checks`);
}

/**
 * Crea un check su un server (solo admin). Per i tipi `postgres`/`mysql`,
 * `target` è la connection string in chiaro: il server la cifra e non la
 * restituisce mai (la proiezione espone solo `hasDsn`).
 */
export function createServerCheck(id: string, body: CreateCheckInput): Promise<ServerCheck> {
  return api.post(`/api/servers/${encodeURIComponent(id)}/checks`, body);
}

/**
 * Aggiorna un check (solo admin): patch parziale. Cambiare `type` richiede un
 * nuovo `target` (400 altrimenti); `target` assente = invariato (DSN incluso).
 */
export function updateServerCheck(
  id: string,
  checkId: string,
  body: UpdateCheckInput,
): Promise<ServerCheck> {
  return api.put(
    `/api/servers/${encodeURIComponent(id)}/checks/${encodeURIComponent(checkId)}`,
    body,
  );
}

/** Elimina un check di un server (solo admin): 204. 404 se non appartiene al server. */
export function deleteServerCheck(id: string, checkId: string): Promise<void> {
  return request(
    "DELETE",
    `/api/servers/${encodeURIComponent(id)}/checks/${encodeURIComponent(checkId)}`,
  );
}

/**
 * Serie temporale delle metriche di un server nel range `[from, to]` (ISO
 * datetime). Con `checkId` aggiunge la serie di esiti del check (`checkPoints`).
 * La risoluzione (raw/5m) la sceglie il server dall'ampiezza del range.
 */
export function getServerMetrics(
  id: string,
  range: ServerMetricsRange,
): Promise<ServerMetricsResponse> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (range.checkId) params.set("checkId", range.checkId);
  return api.get(`/api/servers/${encodeURIComponent(id)}/metrics?${params.toString()}`);
}

// --- Report attività (daily standup asincrono, PER-COMMIT) ---

/** Membro Stubwise risolto dall'email git (via git_identities), o null se non risolto. */
export interface ActivityResolvedUser {
  id: string;
  email: string;
  avatarUrl: string | null;
}

/** Progetto riferito dalle due viste. */
export interface ActivityProjectRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * Un singolo commit del giorno. Nella vista per-progetto include l'autore
 * (`authorName` + `resolvedUser`); nella vista per-dev l'autore è implicito
 * (già raggruppato) e quei campi sono assenti. `aiDescription` è markdown
 * NON FIDATO (prodotto da un agente): renderlo SEMPRE via `<Markdown>`.
 */
export interface ActivityCommit {
  sha: string;
  /**
   * Email git dell'autore. Presente solo nella vista per-progetto (serve
   * all'admin per associare l'email a un membro del team); nella vista per-dev
   * l'autore è già raggruppato e il campo è assente.
   */
  authorEmail?: string;
  authorName?: string | null;
  resolvedUser?: ActivityResolvedUser | null;
  committedAt: string;
  subject: string;
  additions: number;
  deletions: number;
  aiDescription: string | null;
}

/** Totali di intestazione della vista per-progetto. */
export interface ActivityProjectHeader {
  commitCount: number;
  additions: number;
  deletions: number;
  authorCount: number;
}

/** Totali di intestazione della vista per-sviluppatore. */
export interface ActivityDeveloperHeader {
  commitCount: number;
  additions: number;
  deletions: number;
  projectCount: number;
}

/** Vista per-progetto del giorno: header coi totali + la lista dei commit. */
export interface ActivityProjectView {
  project: ActivityProjectRef;
  status: string;
  header: ActivityProjectHeader;
  commits: ActivityCommit[];
  /**
   * Riassunto narrativo del giorno per il progetto (markdown NON FIDATO,
   * prodotto da un agente: renderlo via `<Markdown>`). `null` se il report è
   * ancora in generazione o se la run è fallita senza produrne uno.
   */
  summary: string | null;
}

/** Vista per-dev del giorno: header coi totali + i commit raggruppati per progetto. */
export interface ActivityDeveloperView {
  resolvedUser: ActivityResolvedUser | null;
  gitEmail: string | null;
  authorName: string | null;
  header: ActivityDeveloperHeader;
  byProject: {
    project: ActivityProjectRef;
    commits: ActivityCommit[];
  }[];
  /**
   * Riassunto narrativo del giorno per lo sviluppatore (markdown NON FIDATO:
   * renderlo via `<Markdown>`). `null` se il rollup dei riassunti dev è ancora
   * in corso (vedi `developersSummaryPending`) o se non è stato prodotto.
   */
  summary: string | null;
}

/**
 * Report di attività di una data: entrambe le viste (per-progetto e per-dev)
 * sugli stessi commit. Alimenta la sezione SPA "Attività".
 */
export interface ActivityReport {
  date: string;
  projects: ActivityProjectView[];
  developers: ActivityDeveloperView[];
  /**
   * `true` mentre il rollup dei riassunti per-sviluppatore è ancora in corso
   * (i `developers[].summary` possono essere `null` in attesa). La UI mostra un
   * placeholder e il polling continua finché resta `true`.
   */
  developersSummaryPending: boolean;
}

/**
 * Report di attività di una data (`YYYY-MM-DD`, UTC). Visibile a ogni membro
 * autenticato; una data senza report restituisce liste vuote.
 */
export function getActivity(date: string): Promise<ActivityReport> {
  return api.get(`/api/activity?date=${encodeURIComponent(date)}`);
}

/**
 * Accoda la generazione manuale dei report attività per una data (solo admin,
 * arbitrato dal server). Ritorna il numero di report NUOVI accodati (`queued`):
 * `0` può significare "nessun progetto ha il report attività abilitato" OPPURE
 * "esistono già report per quel giorno" (l'insert è `onConflictDoNothing`, non
 * riaccoda). La UI mostra il pulsante solo quando non c'è alcun report per il
 * giorno, quindi lì `queued: 0` implica "nessun progetto abilitato"; ma le due
 * condizioni NON sono equivalenti in generale.
 */
export function generateActivity(date: string): Promise<{ queued: number }> {
  return api.post(`/api/activity/generate`, { date });
}
