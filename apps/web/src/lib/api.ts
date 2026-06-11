import type {
  GitProviderKind,
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
 * Status 0 = errore di rete (il server non ha mai risposto).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
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
      throw new ApiError(0, "Impossibile contattare il server", { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    // Il server risponde sempre { message } sugli errori; il fallback copre
    // risposte non-JSON (proxy, gateway, ecc.).
    const fallback = `Errore ${response.status}`;
    const message = await response
      .json()
      .then((data: unknown) =>
        typeof data === "object" && data !== null && "message" in data
          ? String((data as { message: unknown }).message)
          : fallback,
      )
      .catch(() => fallback);
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
};

// --- Auth ---

export interface PublicUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

export interface Credentials {
  email: string;
  password: string;
}

export function getMe(): Promise<{ user: PublicUser }> {
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

export interface Invite {
  token: string;
  expiresAt: string;
}

/** Crea un invito (solo admin): il token va consegnato fuori banda. */
export function postInvite(email: string): Promise<Invite> {
  return api.post("/api/auth/invites", { email });
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

// --- AI Jobs ---

export type AIJobStatus = "queued" | "triaging" | "fixing" | "pr_opened" | "failed" | "skipped";

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
}

export function getTicketJobs(ticketId: string): Promise<AIJob[]> {
  return api.get(`/api/tickets/${ticketId}/jobs`);
}

// --- Users ---

export function getUsers(): Promise<PublicUser[]> {
  return api.get("/api/users");
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
  createdAt: string;
}

/**
 * Credenziali git di un progetto: write-only. Si inviano alla creazione o
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
  provider: GitProviderKind;
  repoUrl: string;
  defaultBranch: string;
  credentials: GitCredentials;
}

export interface ProjectPatch {
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  /** Assente = le credenziali salvate restano invariate. */
  credentials?: GitCredentials;
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

/** Esito di un singolo controllo di validazione credenziali (gemello del tipo server). */
export interface CredentialCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidateCredentialsBody {
  provider: GitProviderKind;
  repoUrl: string;
  credentials: GitCredentials;
}

export interface ValidateCredentialsResult {
  ok: boolean;
  checks: CredentialCheck[];
}

/**
 * Verifica (senza salvare) che le credenziali git inserite autentichino e
 * abbiano gli scope necessari alla pipeline: push git + apertura PR. Endpoint
 * solo admin.
 */
export function postValidateCredentials(
  body: ValidateCredentialsBody,
): Promise<ValidateCredentialsResult> {
  return api.post("/api/projects/validate-credentials", body);
}

export function patchProject(slug: string, patch: ProjectPatch): Promise<Project> {
  return api.patch(`/api/projects/${slug}`, patch);
}
