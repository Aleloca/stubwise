import { vi } from "vitest";

// Un server finto per i test dell'implementazione vera: risponde per metodo
// e percorso, e registra le richieste. Si installa come `fetch` globale (la
// build app nel browser usa `fetch` sulla stessa origine).

export interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
  authorization: string | null;
}

type Answer = { status?: number; body?: unknown; contentType?: string } | undefined;
/** Una risposta subito o più tardi (una promessa: la richiesta resta in volo finché non si risolve). */
type Handler = (req: SeenRequest) => Answer | Promise<Answer>;

export function installFakeServer(
  routes: Record<string, Handler | { status?: number; body?: unknown; contentType?: string }>,
) {
  const seen: SeenRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const req: SeenRequest = {
      method,
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      credentials: init.credentials,
      authorization: new Headers(init.headers).get("authorization"),
    };
    seen.push(req);
    const bare = path.split("?")[0]!;
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${bare}`];
    const out = typeof route === "function" ? await route(req) : route;
    if (!out)
      return new Response(JSON.stringify({ code: "not_found", message: path }), { status: 404 });
    const status = out.status ?? 200;
    if (status === 204) return new Response(null, { status });
    // Un `contentType` non JSON (il resoconto del grafo, `text/markdown`): il corpo così com'è.
    const contentType = out.contentType;
    if (contentType)
      return new Response(String(out.body ?? ""), {
        status,
        headers: { "content-type": contentType },
      });
    // Un `body: null` esplicito resta null (una risposta «nessuno»); assente, un oggetto vuoto.
    return new Response(JSON.stringify("body" in out ? out.body : {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

export const ME_ID = "11111111-1111-4111-8111-111111111111";
export const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

export const me = (over: Record<string, unknown> = {}) => ({
  user: {
    id: ME_ID,
    email: "ada@example.com",
    role: "member",
    language: "en",
    avatarUrl: null,
    slackUserId: null,
  },
  instancePermissions: ["users.view_all"],
  projectPermissions: { [PROJECT_ID]: ["tickets.create", "tickets.edit"] },
  ...over,
});

/** Un progetto come lo dà `GET /api/projects` (passa `projectListItemSchema`). */
export const serverProject = (over: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: "Audin AI",
  slug: "audin-ai",
  code: "AUD",
  description: null,
  aiProviderId: null,
  docAutoUpdate: false,
  dailyReportEnabled: false,
  backlogEnabled: false,
  pulseEnabled: false,
  pulseEveryDays: 7,
  ingestionKey: "key",
  nextTicketNumber: 13,
  createdAt: "2026-01-01T00:00:00.000Z",
  repositoryCount: 0,
  stallThresholds: { activeDays: 7, todoDays: 14 },
  ...over,
});

export const TICKET_ID = "44444444-4444-4444-8444-444444444444";
export const STATUS_TODO = "99999999-9999-4999-8999-999999999991";
export const DEPT_ID = "66666666-6666-4666-8666-666666666666";

/** Una task come la dà `/api/tasks` (passa `taskViewSchema`). */
export const serverTask = (over: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  ticketId: TICKET_ID,
  number: 12,
  code: "AUD-12",
  projectId: PROJECT_ID,
  title: "Export the report",
  description: "",
  statusId: STATUS_TODO,
  departmentId: DEPT_ID,
  assigneeId: null,
  createdById: null,
  followerIds: [],
  size: "M",
  milestoneId: null,
  labels: [],
  type: "activity",
  priority: "medium",
  links: [],
  attachments: [],
  manualStall: null,
  claude: "none",
  createdAt: "2026-11-01T10:00:00.000Z",
  closedAt: null,
  lastActivityAt: "2026-11-08T10:00:00.000Z",
  ...over,
});

/** Un ticket minimo valido per `ticketDetailSchema` (le azioni di Claude leggono `repositories`). */
export const serverTicketDetail = (over: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  projectId: PROJECT_ID,
  number: 12,
  title: "Export the report",
  body: "",
  type: "task",
  priority: "medium",
  status: "open",
  source: "manual",
  assigneeId: null,
  milestoneId: null,
  effort: null,
  labels: [],
  technicalPayload: null,
  occurrences: 1,
  lastSeenAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  implementationPlan: null,
  originContent: null,
  planSummary: null,
  repositories: [],
  ...over,
});

/** Un commento come lo rilegge `POST /api/tickets/:id/comments`. */
export const serverComment = (body: string) => ({
  id: "eeeeeeee-0000-4000-8000-000000000001",
  ticketId: TICKET_ID,
  authorType: "user",
  authorId: ME_ID,
  body,
  createdAt: "2026-11-10T10:00:00.000Z",
});

/**
 * `/range` come il server vero (F3b, task 6): con `fields=summary` la riga è
 * LEGGERA — niente descrizione, invitati, conferenza e promemoria (li dà
 * `event(id)`); senza, com'era.
 */
export const calendarRangeRoute = (items: readonly unknown[]) => (req: { path: string }) => {
  const light = new URLSearchParams(req.path.split("?")[1] ?? "").get("fields") === "summary";
  // La mia risposta la calcola il server dalla mia casella fra gli invitati (`toCalendarItem`).
  const withResponse = (items as readonly Record<string, unknown>[]).map((i) => {
    const mine = (
      (i.attendees as { email: string; responseStatus: string | null }[] | undefined) ?? []
    ).find((a) => a.email.toLowerCase() === String(i.accountEmail).toLowerCase());
    return { myResponse: mine?.responseStatus ?? null, ...i };
  });
  const rows = light
    ? withResponse.map((i) => ({
        ...i,
        attendees: [],
        descriptionHtml: null,
        descriptionText: null,
        conferenceEntryPoints: [],
        reminders: [],
      }))
    : withResponse;
  return { body: { items: rows, nextCursor: null } };
};
