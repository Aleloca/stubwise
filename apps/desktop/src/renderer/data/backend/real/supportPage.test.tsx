import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { support } from "./index";
import { useSupportSearch } from "../../queries";
import { ViewerProvider } from "../../viewer";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";

// Area 8, F3: Support nella build app, sulle rotte vere di 72. La sezione la
// decide il test (accesa); i widget e la ricerca ⌘K restano spenti, e
// nessuna loro lettura parte.
vi.mock("@backend/api", async () => await import("./index"));
vi.mock("../../integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integration")>();
  const on = (name: string) => name === "support" || name === "support-read";
  const off = (name: string) => name === "support-widgets" || name === "support-search";
  return {
    ...actual,
    isIntegrated: (t: Parameters<typeof actual.isIntegrated>[0]) =>
      (t.kind === "projectSection" && t.name === "support") ||
      (t.kind === "feature" && on(t.name)) ||
      (!(t.kind === "feature" && off(t.name)) && actual.isIntegrated(t)),
    featureIntegrated: (name: string) => on(name) || (!off(name) && actual.featureIntegrated(name)),
  };
});

const CONV = "77777777-7777-4777-8777-777777777777";
const TASK = "88888888-8888-4888-8888-888888888888";
const MSG = "99999999-9999-4999-8999-999999999999";
const CODE = "AUD-S1";
const BY_CODE = `/api/support/conversations/by-code/${CODE}`;

const message = {
  id: MSG,
  from: "customer",
  authorId: null,
  body: "The invoices page is empty.",
  at: "2026-11-14T10:00:00.000Z",
};

const conversation = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  code: CODE,
  projectId: PROJECT_ID,
  projectCode: "AUD",
  channel: "widget",
  widgetId: null,
  widgetName: "Portal",
  customer: { name: "Lucia Benedetti", email: "lucia@example.com" },
  messages: [message],
  lastMessage: message,
  state: "waiting_us",
  waitingSince: "2026-11-14T10:00:00.000Z",
  rewrittenWish: null,
  confirmedAt: null,
  triage: null,
  request: null,
  task: { id: TASK, code: "AUD-12", title: "Invoices page is empty", customerStatus: "planned" },
  claudeDraft: null,
  claudeDraftAt: null,
  claudeDraftPending: false,
  following: false,
  canReply: true,
  replyClosed: null,
  canOpenRequest: false,
  canMarkNotConcluded: false,
  emailBlocked: "no_mailbox",
  createdAt: "2026-11-14T09:59:00.000Z",
  lastMessageAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

function install(routes: Record<string, unknown> = {}) {
  installFakeServer({
    "GET /api/auth/me": {
      body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "support.reply"] } }),
    },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": {
      body: [
        {
          id: ME_ID,
          name: "Ada",
          initials: "AD",
          departmentIds: [DEPT_ID],
          email: "ada@example.com",
        },
      ],
    },
    "GET /api/departments": {
      body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }],
    },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    [`GET /api/projects/${PROJECT_ID}/support/conversations`]: {
      body: { items: [conversation({ messages: [] })] },
    },
    [`GET ${BY_CODE}`]: { body: conversation() },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const detail = () =>
  waitFor(
    () => {
      const el = document.querySelector<HTMLElement>(`[data-support-detail="${CODE}"]`);
      if (!el) throw new Error("no detail");
      return el;
    },
    { timeout: 3000 },
  );

describe("Support nella build app (area 8, F3)", () => {
  it("l'esito è un ticket del widget: il blocco mostra la task e cosa vede il cliente", async () => {
    install();
    renderRoute(`/p/AUD/support/${CODE}`);
    const d = await detail();
    const block = await within(d).findByRole("region", { name: "Task" });
    expect(
      within(block).getByRole("link", { name: /AUD-12.*Invoices page is empty/ }),
    ).toBeInTheDocument();
    expect(block).toHaveTextContent("The customer sees: Planned");
  });

  it("i widget restano spenti (support-widgets): la pagina non li legge", async () => {
    // Il namespace è un Proxy sopra le funzioni integrate: si assegna, e alla fine si toglie.
    const widgets = vi.fn(async () => ({ canManage: false, widgets: [] }));
    (support as unknown as Record<string, unknown>).listWidgets = widgets;
    install();
    renderRoute(`/p/AUD/support/${CODE}`);
    await detail();
    await within(await detail()).findByRole("region", { name: "Task" });
    expect(widgets).not.toHaveBeenCalled();
    delete (support as unknown as Record<string, unknown>).listWidgets;
  });

  it("una bozza automatica in arrivo: la casella dice che Claude la sta preparando", async () => {
    install({ [`GET ${BY_CODE}`]: { body: conversation({ claudeDraftPending: true }) } });
    renderRoute(`/p/AUD/support/${CODE}`);
    const d = await detail();
    expect(await within(d).findByText("Claude is preparing a draft…")).toBeInTheDocument();
  });
});

describe("la ricerca ⌘K di Support non è nella F3 (support-search)", () => {
  it("con `support` accesa la ricerca non chiama il server", async () => {
    install();
    const search = vi.fn(async () => []);
    (support as unknown as Record<string, unknown>).searchSupport = search;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ViewerProvider>{children}</ViewerProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useSupportSearch("lucia"), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.fetchStatus).toBe("idle");
    expect(search).not.toHaveBeenCalled();
    delete (support as unknown as Record<string, unknown>).searchSupport;
  });
});
