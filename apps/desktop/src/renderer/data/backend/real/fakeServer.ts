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

type Handler = (req: SeenRequest) => { status?: number; body?: unknown } | undefined;

export function installFakeServer(routes: Record<string, Handler | { status?: number; body?: unknown }>) {
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
    const out = typeof route === "function" ? route(req) : route;
    if (!out) return new Response(JSON.stringify({ code: "not_found", message: path }), { status: 404 });
    const status = out.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(out.body ?? {}), {
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
