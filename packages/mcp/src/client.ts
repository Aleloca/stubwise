import type {
  BacklogItemStatus,
  Project,
  TicketPriority,
  TicketStatus,
  TicketType,
} from "@stubwise/shared";
import { z } from "zod";

import type { StubwiseConfig } from "./config.js";

// Inline: il pacchetto pubblicato non deve dipendere dal package shared a
// runtime. Questi due schemi erano gli unici import di VALORE dallo shared;
// li replichiamo qui nella forma minima che il client legge (i restanti
// import dallo shared sono `import type`, cancellati a runtime).

/** Stato di un job del backlog (enum condiviso, replicato localmente). */
const backlogJobStatusSchema = z.enum(["queued", "running", "done", "failed"]);

/**
 * Progetto nelle risposte API, forma permissiva: valida i soli campi che il
 * client legge (id/slug/name) e ignora gli extra (repositoryCount, flag, ...).
 */
const projectSchema = z.object({ id: z.string(), slug: z.string(), name: z.string() }).loose();

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
 * Forma difensiva di un ticket nelle risposte di LISTA/CREATE (`listTickets`,
 * `createTicket`) e nelle PATCH (`patchTicket`/`setTicketStatus`): solo i campi
 * che ci servono, tipizzati dalle enum condivise. Campi extra del server
 * (technicalPayload, occurrences, repositoryCount, ...) restano ignorati.
 *
 * NON include `implementationPlan`/`originContent`: quei due campi sono nel
 * SOLO dettaglio del server (`ticketDetailSchema`), non nelle risposte base
 * (`ticketSchema`/`ticketListItemSchema`) → a runtime sarebbero `undefined`,
 * non `null`. Per leggerli si usa {@link TicketDetail}.
 */
export interface TicketSummary {
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

/**
 * Forma difensiva di un ticket nelle risposte di DETTAGLIO (`getTicket`) e in
 * quelle degli endpoint design/piano (`setDesign`/`deleteDesign`/`setPlan`/
 * `deletePlan`, che rispondono col dettaglio): la forma base più i due campi
 * design/piano, garantiti presenti (`string | null`) solo qui.
 */
export type TicketDetail = TicketSummary & {
  /** Piano di implementazione collegato (markdown), o null se assente. */
  implementationPlan: string | null;
  /** Corpo originale preservato quando un design ne ha sostituito il body, o null. */
  originContent: string | null;
};

/**
 * Voce del backlog nelle risposte di LISTA (forma difensiva, leggera). La lista
 * (`GET /api/backlog`) volutamente NON include `document`: per il contenuto si
 * usa il dettaglio ({@link BacklogItemDetail}).
 */
export interface BacklogItemSummary {
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

/**
 * Voce del backlog nella risposta di DETTAGLIO (`GET /api/backlog/:id`): oltre
 * ai metadati porta `document`, il contenuto testuale dell'item, che i tool MCP
 * (es. `get_backlog_item`) devono poter leggere. Forma difensiva: i campi
 * pesanti/accessori del server (tickets, messages, suggested, embedding, ...)
 * restano ignorati.
 */
export interface BacklogItemDetail {
  id: string;
  projectId: string;
  title: string;
  document: string;
  status: BacklogItemStatus;
  effort: number | null;
  risk: string | null;
  riskNote: string | null;
  urgency: Urgency | null;
  /** Piano di implementazione collegato (markdown), o null se assente. */
  implementationPlan: string | null;
  /** Documento originale preservato quando un design ne ha sostituito il body, o null. */
  originContent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Esito dell'avvio di un run AI su un ticket (`POST /api/tickets/:id/run-ai`). */
export interface RunTicketResult {
  jobId: string;
  /**
   * `queued`: il job è in coda, il worker lo prenderà in carico.
   * `awaiting_plan_approval`: il job esiste ma attende che un maintainer approvi
   * il piano prima di eseguire.
   */
  status: "queued" | "awaiting_plan_approval";
}

/** Bersaglio delle operazioni design/plan: una voce di backlog o un ticket. */
export type DesignPlanTarget = "backlog" | "ticket";

/** Stato di un job del backlog per il polling dell'intake. */
export interface BacklogJob {
  status: "queued" | "running" | "done" | "failed";
  resultItemId: string | null;
  error: string | null;
}

// --- Schemi di validazione runtime delle risposte del flusso critico --------
// Validiamo le risposte piccole ad alto valore (polling job, create, convert,
// progetti): una risposta malformata/di forma diversa dà un errore parlante
// invece di propagare "garbage" tipizzato a forza. Le risposte GROSSE (dettaglio
// backlog, liste di ticket/backlog) NON sono validate: lo schema condiviso non
// combacerebbe campo-per-campo con la forma difensiva del client e il costo di
// tenerli allineati supererebbe il valore → cast tipizzato documentato.

/** `POST /api/backlog` → job accodato. */
const createBacklogResultSchema = z.object({ queued: z.literal(true), jobId: z.uuid() });

/** `GET /api/backlog/jobs/:jobId` → stato del job. */
const backlogJobResultSchema = z.object({
  status: backlogJobStatusSchema,
  resultItemId: z.uuid().nullable(),
  error: z.string().nullable(),
});

/** `POST /api/backlog/:id/convert` → ticket creato. */
const convertResultSchema = z.object({ ticketId: z.uuid(), ticketNumber: z.number().int() });

/** `POST /api/backlog/from-design` → voce creata sincrona (id + URL del dettaglio). */
const fromDesignResultSchema = z.object({ itemId: z.uuid(), url: z.string() });

/**
 * `POST /api/tickets/:id/run-ai` → job accodato (202). `status` distingue il run
 * già in coda per il worker da quello nato fermo sul gate del piano (quando chi
 * lancia è un operator/`member`: serve l'approvazione di un maintainer).
 */
const runTicketResultSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(["queued", "awaiting_plan_approval"]),
});

/** Pagina generica cursor-based dell'API. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListBacklogParams {
  projectId: string;
  status?: BacklogItemStatus;
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

  /**
   * Valida una risposta già parsata contro uno schema zod. Su fallimento lancia
   * un `StubwiseApiError` parlante (`invalid_response`, status 0) invece di
   * lasciar propagare dati di forma sbagliata: chi chiama vede subito che è il
   * SERVER ad aver risposto in modo inatteso, non un bug del client.
   */
  private parseResponse<S extends z.ZodType>(
    schema: S,
    data: unknown,
    operation: string,
  ): z.infer<S> {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new StubwiseApiError(
        `Risposta inattesa dal server per ${operation}`,
        0,
        "invalid_response",
      );
    }
    return result.data;
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
    // La risposta reale di GET /api/projects è projectSchema + repositoryCount:
    // valida l'intero projectSchema (i campi extra sono ignorati, lo schema non
    // è strict) così uno slug→id risolto su dati skewed fallisce parlante.
    const raw = await this.request<unknown>("/api/projects");
    // projectSchema è permissivo (id/slug/name + extra ignorati): il suo tipo
    // inferito è più largo di Project, ma la forma reale della lista è quella.
    const projects = this.parseResponse(
      projectSchema.array(),
      raw,
      "l'elenco dei progetti",
    ) as Project[];
    this.projectsCache = projects;
    return projects;
  }

  /** Risolve uno slug in un progetto (o null). Usa la cache di `listProjects`. */
  async getProjectBySlug(slug: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find((p) => p.slug === slug) ?? null;
  }

  // --- Backlog ------------------------------------------------------------

  // Risposta di lista grande e con forma difensiva ≠ schema condiviso: cast
  // tipizzato, nessuna validazione runtime (vedi nota sugli schemi sopra).
  async listBacklog(params: ListBacklogParams): Promise<Page<BacklogItemSummary>> {
    return this.request<Page<BacklogItemSummary>>("/api/backlog", {
      query: {
        projectId: params.projectId,
        status: params.status,
        urgency: params.urgency,
        q: params.q,
        limit: params.limit,
      },
    });
  }

  // Dettaglio grande (document + tickets + messages + ...): cast tipizzato sulla
  // forma difensiva {@link BacklogItemDetail}, nessuna validazione runtime.
  async getBacklogItem(id: string): Promise<BacklogItemDetail> {
    return this.request<BacklogItemDetail>(`/api/backlog/${id}`);
  }

  async createBacklogItem(params: CreateBacklogItemParams): Promise<{ queued: true; jobId: string }> {
    const raw = await this.request<unknown>("/api/backlog", { method: "POST", body: params });
    return this.parseResponse(createBacklogResultSchema, raw, "la creazione della voce di backlog");
  }

  /**
   * Crea una voce di backlog da un design doc GIÀ COMPLETO: il server salva il
   * design VERBATIM come corpo della voce (nessuna sintesi AI) e accoda un job
   * async che stima solo i metadati. Risposta piccola ad alto valore → validata
   * runtime (id + URL del dettaglio) come gli altri metodi critici.
   */
  async createBacklogFromDesign(
    projectId: string,
    title: string,
    design: string,
  ): Promise<{ itemId: string; url: string }> {
    const raw = await this.request<unknown>("/api/backlog/from-design", {
      method: "POST",
      body: { projectId, title, design },
    });
    return this.parseResponse(fromDesignResultSchema, raw, "la creazione della voce da design");
  }

  async getBacklogJob(jobId: string): Promise<BacklogJob> {
    const raw = await this.request<unknown>(`/api/backlog/jobs/${jobId}`);
    return this.parseResponse(backlogJobResultSchema, raw, "lo stato del job di backlog");
  }

  async convertBacklogToTicket(id: string): Promise<{ ticketId: string; ticketNumber: number }> {
    const raw = await this.request<unknown>(`/api/backlog/${id}/convert`, { method: "POST" });
    return this.parseResponse(convertResultSchema, raw, "la conversione della voce in ticket");
  }

  // --- Ticket -------------------------------------------------------------

  async createTicket(params: CreateTicketParams): Promise<TicketSummary> {
    return this.request<TicketSummary>("/api/tickets", { method: "POST", body: params });
  }

  async getTicket(id: string): Promise<TicketDetail> {
    return this.request<TicketDetail>(`/api/tickets/${id}`);
  }

  async listTickets(params: ListTicketsParams): Promise<Page<TicketSummary>> {
    return this.request<Page<TicketSummary>>("/api/tickets", {
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

  // PATCH risponde con la forma base (`toPublicTicket`), senza i campi
  // design/piano → TicketSummary (non TicketDetail).
  async patchTicket(id: string, patch: TicketPatch): Promise<TicketSummary> {
    return this.request<TicketSummary>(`/api/tickets/${id}`, { method: "PATCH", body: patch });
  }

  /** Scorciatoia per il cambio di stato (PATCH con solo `{ status }`). */
  async setTicketStatus(id: string, status: TicketStatus): Promise<TicketSummary> {
    return this.patchTicket(id, { status });
  }

  /**
   * Avvia l'esecuzione AI del ticket sul worker. `mode: "ai_plan"` forza il
   * flusso triage+pianificazione anche quando il ticket ha un piano salvato
   * (senza `mode`, con un piano salvato, il worker esegue direttamente quello).
   *
   * Risposta piccola ad alto valore (202 `{ jobId, status }`) → validata a
   * runtime come gli altri metodi critici. NON serve un `listTicketJobs`
   * successivo: lo `status` del 202 è già l'informazione che il chiamante deve
   * riportare. Gli errori attesi arrivano come `StubwiseApiError`: 404 (ticket
   * inesistente), 409 `job_in_flight` (un job è già in volo), 403 (permessi).
   */
  async runTicket(id: string, body?: { mode?: "ai_plan" }): Promise<RunTicketResult> {
    const raw = await this.request<unknown>(`/api/tickets/${id}/run-ai`, {
      method: "POST",
      // Corpo sempre inviato (anche vuoto): la rotta accetta `nullish`, ma un
      // oggetto esplicito evita differenze di comportamento tra i due rami.
      body: body?.mode ? { mode: body.mode } : {},
    });
    return this.parseResponse(runTicketResultSchema, raw, "l'avvio dell'esecuzione del ticket");
  }

  // --- Design / piano (backlog e ticket) ----------------------------------
  //
  // Superficie unificata sulle risorse omogenee `backlog`/`ticket`: entrambe
  // espongono gli stessi endpoint `/:id/design` e `/:id/plan`. Il target sceglie
  // solo il prefisso di path. Le risposte (l'oggetto aggiornato) sono grandi e di
  // forma difensiva ≠ schema condiviso → cast tipizzato, nessuna validazione
  // runtime (stessa scelta di getBacklogItem/getTicket).

  /** Prefisso di path per il target (`/api/backlog` o `/api/tickets`). */
  private basePath(target: DesignPlanTarget): string {
    return target === "backlog" ? "/api/backlog" : "/api/tickets";
  }

  /** PUT del design: sostituisce il corpo con `content`, preservando l'origine lato server. */
  async setDesign(
    target: DesignPlanTarget,
    id: string,
    content: string,
  ): Promise<BacklogItemDetail | TicketDetail> {
    return this.request<BacklogItemDetail | TicketDetail>(`${this.basePath(target)}/${id}/design`, {
      method: "PUT",
      body: { content },
    });
  }

  /** DELETE del design: ripristina il corpo d'origine e azzera `originContent` lato server. */
  async deleteDesign(target: DesignPlanTarget, id: string): Promise<BacklogItemDetail | TicketDetail> {
    return this.request<BacklogItemDetail | TicketDetail>(`${this.basePath(target)}/${id}/design`, {
      method: "DELETE",
    });
  }

  /** PUT del piano di implementazione: imposta/aggiorna `implementationPlan`. */
  async setPlan(
    target: DesignPlanTarget,
    id: string,
    content: string,
  ): Promise<BacklogItemDetail | TicketDetail> {
    return this.request<BacklogItemDetail | TicketDetail>(`${this.basePath(target)}/${id}/plan`, {
      method: "PUT",
      body: { content },
    });
  }

  /** DELETE del piano di implementazione: azzera `implementationPlan`. */
  async deletePlan(target: DesignPlanTarget, id: string): Promise<BacklogItemDetail | TicketDetail> {
    return this.request<BacklogItemDetail | TicketDetail>(`${this.basePath(target)}/${id}/plan`, {
      method: "DELETE",
    });
  }
}
