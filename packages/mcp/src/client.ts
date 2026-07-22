import type {
  BacklogItemStatus,
  Project,
  TicketPriority,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";

import type { StubwiseConfig } from "./config.js";

/**
 * Errore parlante di un'operazione contro l'API Stubwise. Porta lo `status`
 * HTTP (0 = errore di rete/nessuna risposta) e un `code` stabile (quando il
 * server lo fornisce o quando lo assegniamo noi, es. `network_error`), così i
 * tool MCP possono decidere il messaggio da mostrare senza fare parsing del
 * testo.
 */
export class StubwiseApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "StubwiseApiError";
    this.status = status;
    this.code = code;
  }
}

/** Priorità/urgenza: riusa la scala priority dei ticket. */
export type Urgency = TicketPriority;

/**
 * Forma difensiva di un ticket nelle risposte API: solo i campi che ci servono,
 * tipizzati dalle enum condivise. Campi extra del server (technicalPayload,
 * occurrences, ...) restano ignorati.
 */
export interface Ticket {
  id: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  assigneeId: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/** Voce del backlog nelle risposte di lista/dettaglio (forma difensiva). */
export interface BacklogItem {
  id: string;
  projectId: string;
  title: string;
  status: BacklogItemStatus;
  effort: number | null;
  risk: string | null;
  urgency: Urgency | null;
  createdAt: string;
  updatedAt: string;
}

/** Stato di un job del backlog per il polling dell'intake. */
export interface BacklogJob {
  status: "queued" | "running" | "done" | "failed";
  resultItemId: string | null;
  error: string | null;
}

/** Pagina generica cursor-based dell'API. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListBacklogParams {
  projectId: string;
  status?: string;
  urgency?: Urgency;
  q?: string;
  limit?: number;
}

export interface CreateBacklogItemParams {
  projectId: string;
  title: string;
  body: string;
}

export interface CreateTicketParams {
  projectId: string;
  title: string;
  body?: string;
  type: TicketType;
  priority?: TicketPriority;
  assigneeId?: string;
  labels?: string[];
}

export interface ListTicketsParams {
  projectId: string;
  statuses?: TicketStatus[];
  type?: TicketType;
  priority?: TicketPriority;
  q?: string;
  limit?: number;
}

/** Patch parziale di un ticket. Solo i campi valorizzati vengono inviati. */
export interface TicketPatch {
  status?: TicketStatus;
  assigneeId?: string | null;
  title?: string;
  body?: string;
  type?: TicketType;
  priority?: TicketPriority;
  labels?: string[];
}

/** Dipendenze iniettabili: `fetch` è iniettabile per testabilità. */
export interface StubwiseClientDeps {
  fetch?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Forma dell'errore standard del server: `{ code?, message }`. */
interface ApiErrorBody {
  code?: string;
  message?: string;
}

/**
 * Client HTTP verso l'API Stubwise. Incapsula baseUrl + token (Bearer) e mappa
 * gli errori HTTP/di rete in `StubwiseApiError` parlanti. Non contiene segreti:
 * tutto arriva dalla `StubwiseConfig`.
 */
export class StubwiseClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  /** Cache in-memory dei progetti per la vita del processo (risoluzione slug→id). */
  private projectsCache: Project[] | null = null;

  constructor(config: StubwiseConfig, deps: StubwiseClientDeps = {}) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.fetchFn = deps.fetch ?? fetch;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = `${this.baseUrl}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body } = options;
    const url = this.buildUrl(path, query);

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, { method, headers, body: payload });
    } catch (err) {
      // fetch lancia (TypeError) su host irraggiungibile / DNS / connessione.
      throw new StubwiseApiError(
        `Impossibile raggiungere Stubwise a ${this.baseUrl} (${(err as Error).message})`,
        0,
        "network_error",
      );
    }

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    // 204 No Content e simili: nessun corpo da leggere.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Traduce una risposta non-2xx in un `StubwiseApiError` parlante. */
  private async toApiError(response: Response): Promise<StubwiseApiError> {
    const errorBody = await this.readErrorBody(response);
    const serverCode = errorBody?.code;
    const serverMessage = errorBody?.message;

    switch (response.status) {
      case 401:
        return new StubwiseApiError(
          "Token non valido o scaduto: rigenera STUBWISE_TOKEN nelle impostazioni Stubwise",
          401,
          serverCode ?? "unauthorized",
        );
      case 403:
        return new StubwiseApiError(
          "Permessi insufficienti per questa operazione (il token eredita i permessi del tuo utente)",
          403,
          serverCode ?? "forbidden",
        );
      case 404:
        return new StubwiseApiError(
          serverMessage ?? "Risorsa non trovata su Stubwise",
          404,
          serverCode ?? "not_found",
        );
      default:
        return new StubwiseApiError(
          serverMessage ?? `Errore Stubwise (HTTP ${response.status})`,
          response.status,
          serverCode ?? "api_error",
        );
    }
  }

  private async readErrorBody(response: Response): Promise<ApiErrorBody | null> {
    try {
      const text = await response.text();
      if (!text) return null;
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as ApiErrorBody;
      return null;
    } catch {
      return null;
    }
  }

  // --- Progetti -----------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    if (this.projectsCache) return this.projectsCache;
    const projects = await this.request<Project[]>("/api/projects");
    this.projectsCache = projects;
    return projects;
  }

  /** Risolve uno slug in un progetto (o null). Usa la cache di `listProjects`. */
  async getProjectBySlug(slug: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.slug === slug) ?? null;
  }

  // --- Backlog ------------------------------------------------------------

  async listBacklog(params: ListBacklogParams): Promise<Page<BacklogItem>> {
    return this.request<Page<BacklogItem>>("/api/backlog", {
      query: {
        projectId: params.projectId,
        status: params.status,
        urgency: params.urgency,
        q: params.q,
        limit: params.limit,
      },
    });
  }

  async getBacklogItem(id: string): Promise<BacklogItem> {
    return this.request<BacklogItem>(`/api/backlog/${id}`);
  }

  async createBacklogItem(
    params: CreateBacklogItemParams,
  ): Promise<{ queued: boolean; jobId: string }> {
    return this.request<{ queued: boolean; jobId: string }>("/api/backlog", {
      method: "POST",
      body: params,
    });
  }

  async getBacklogJob(jobId: string): Promise<BacklogJob> {
    return this.request<BacklogJob>(`/api/backlog/jobs/${jobId}`);
  }

  async convertBacklogToTicket(
    id: string,
  ): Promise<{ ticketId: string; ticketNumber: number }> {
    return this.request<{ ticketId: string; ticketNumber: number }>(
      `/api/backlog/${id}/convert`,
      { method: "POST" },
    );
  }

  // --- Ticket -------------------------------------------------------------

  async createTicket(params: CreateTicketParams): Promise<Ticket> {
    return this.request<Ticket>("/api/tickets", { method: "POST", body: params });
  }

  async getTicket(id: string): Promise<Ticket> {
    return this.request<Ticket>(`/api/tickets/${id}`);
  }

  async listTickets(params: ListTicketsParams): Promise<Page<Ticket>> {
    return this.request<Page<Ticket>>("/api/tickets", {
      query: {
        projectId: params.projectId,
        statuses: params.statuses?.join(","),
        type: params.type,
        priority: params.priority,
        q: params.q,
        limit: params.limit,
      },
    });
  }

  async patchTicket(id: string, patch: TicketPatch): Promise<Ticket> {
    return this.request<Ticket>(`/api/tickets/${id}`, { method: "PATCH", body: patch });
  }

  /** Scorciatoia per il cambio di stato (PATCH con solo `{ status }`). */
  async setTicketStatus(id: string, status: TicketStatus): Promise<Ticket> {
    return this.patchTicket(id, { status });
  }
}
