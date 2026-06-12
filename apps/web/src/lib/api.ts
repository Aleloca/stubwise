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
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
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
  | "skipped";

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

/**
 * Avvio manuale dell'AI su un ticket: rimette in coda l'ultimo job con il
 * flag manual_trigger, così il worker rifà il triage e procede sul fix
 * scavalcando il gate di automazione (soglia/auto-fix). 202 con l'id del job.
 */
export function postRunAi(ticketId: string): Promise<{ jobId: string }> {
  return api.post(`/api/tickets/${ticketId}/run-ai`);
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
}

export interface ProjectPatch {
  name?: string;
  repoUrl?: string;
  defaultBranch?: string;
  /** Assente = l'account collegato resta invariato. */
  gitAccountId?: string;
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
