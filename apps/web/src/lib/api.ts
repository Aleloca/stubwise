import type {
  GitProviderKind,
  Language,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";

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

export interface Ticket {
  id: string;
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
  items: Ticket[];
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

export function patchTicket(id: string, patch: TicketPatch): Promise<Ticket> {
  return api.patch(`/api/tickets/${id}`, patch);
}

/** Creazione manuale di un ticket dalla UI (source "manual" lato server). */
export interface TicketDraft {
  projectId: string;
  title: string;
  body?: string;
  type: TicketType;
  priority: TicketPriority;
}

export function postTicket(draft: TicketDraft): Promise<Ticket> {
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

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  slug: string;
  provider: GitProviderKind;
  repoUrl: string;
  defaultBranch: string;
  ingestionKey: string;
  /** Account git che fornisce le credenziali del progetto. */
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

export interface ProjectDraft {
  name: string;
  /** Account git riutilizzabile da cui il progetto eredita provider e credenziali. */
  gitAccountId: string;
  repoUrl: string;
  defaultBranch?: string;
  /** Comando di test custom; null/assente = auto-detect (script test del package.json). */
  testCommand?: string | null;
  /** Comando di installazione custom; null/assente = auto-detect (dal lockfile). */
  installCommand?: string | null;
}

export interface ProjectPatch {
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

export function getProjects(): Promise<Project[]> {
  return api.get("/api/projects");
}

export function getProject(slug: string): Promise<Project> {
  return api.get(`/api/projects/${slug}`);
}

/**
 * Config del webhook git di un progetto: segreto HMAC + path su cui il
 * provider consegna gli eventi di merge. Endpoint solo admin: i member
 * ricevono 403. Il segreto permette di forgiare webhook, quindi non compare
 * mai nella proiezione pubblica del progetto.
 */
export interface ProjectWebhook {
  webhookSecret: string;
  webhookPath: string;
}

export function getProjectWebhook(slug: string): Promise<ProjectWebhook> {
  return api.get(`/api/projects/${slug}/webhook`);
}

export function postProject(draft: ProjectDraft): Promise<Project> {
  return api.post("/api/projects", draft);
}

export function patchProject(slug: string, patch: ProjectPatch): Promise<Project> {
  return api.patch(`/api/projects/${slug}`, patch);
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
 * credenziali del progetto. Endpoint solo admin. Su scope insufficiente l'API
 * risponde con un 4xx e un messaggio di guida, propagato come errore.
 */
export function postConfigureWebhook(slug: string): Promise<ConfigureWebhookResult> {
  return api.post(`/api/projects/${slug}/configure-webhook`);
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

export interface AutomationSettings {
  rules: AutomationRule[];
}

/** Regole di automazione AI (solo admin): 403 per i member. */
export function getAutomationSettings(): Promise<AutomationSettings> {
  return api.get("/api/settings/automation");
}

/** Upsert delle regole di automazione AI (solo admin). Ritorna lo stato aggiornato. */
export function putAutomationSettings(rules: AutomationRule[]): Promise<AutomationSettings> {
  return api.put("/api/settings/automation", { rules });
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
  notifyJobFailed: boolean;
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
    notifyJobFailed: settings.notifyJobFailed,
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
