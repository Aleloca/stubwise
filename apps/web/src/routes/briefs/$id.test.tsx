import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBriefWeekly } from "../../lib/api";
import { BriefPage } from "./$id";

/*
 * NOTA: le asserzioni sono in INGLESE — i test girano con la lingua iniziale
 * dell'i18n (`en`, vedi `initialLanguage`), come già fa il test della roadmap.
 */

/**
 * Pagina di UN brief settimanale (Fase 5): il testo per intero, "Copia come
 * testo" e — per un maintainer — "Rigenera".
 *
 * Ciò che si sorveglia qui: che un brief SENZA testo non si mostri come una
 * pagina vuota (è il caso previsto dell'istanza senza provider AI, e va detto),
 * che "Rigenera" non compaia a un member, e che la copia porti via il markdown
 * e non il testo renderizzato.
 */

const { getMe, getBrief, getProject, generateProjectBrief } = vi.hoisted(() => ({
  getMe: vi.fn(),
  getBrief: vi.fn(),
  getProject: vi.fn(),
  generateProjectBrief: vi.fn(),
}));

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, getMe, getBrief, getProject, generateProjectBrief };
});

const BRIEF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function brief(overrides: Partial<ProjectBriefWeekly> = {}): ProjectBriefWeekly {
  return {
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    periodStart: "2026-08-31",
    periodEnd: "2026-09-06",
    status: "done",
    summary: "## Dove siamo\n\nIl progetto è a metà del lavoro sul login.",
    sections: { whereWeAre: "Il progetto è a metà del lavoro sul login." },
    notificationId: null,
    createdAt: "2026-09-07T07:30:00.000Z",
    finishedAt: "2026-09-07T07:31:00.000Z",
    ...overrides,
  };
}

function renderBrief() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
  const briefRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/briefs/$id",
    component: BriefPage,
  });
  // La rotta bersaglio del link "torna alla roadmap" deve esistere.
  const roadmapRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$projectId/roadmap",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([authedRoute.addChildren([briefRoute, roadmapRoute])]),
    history: createMemoryHistory({ initialEntries: [`/briefs/${BRIEF_ID}`] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMe.mockResolvedValue({ user: { id: "u1", email: "ada@example.com", role: "admin" } });
  getBrief.mockResolvedValue(brief());
  getProject.mockResolvedValue({
    id: PROJECT_ID,
    name: "Prodotto Acme",
    slug: "prodotto-acme",
    repositories: [],
  });
  generateProjectBrief.mockResolvedValue(brief({ status: "queued" }));
});

afterEach(() => {
  getMe.mockReset();
  getBrief.mockReset();
  getProject.mockReset();
  generateProjectBrief.mockReset();
  vi.unstubAllGlobals();
});

describe("BriefPage", () => {
  it("mostra il periodo, il progetto e il testo del brief", async () => {
    renderBrief();
    expect(await screen.findByText(/Il progetto è a metà del lavoro sul login\./)).toBeInTheDocument();
    expect(screen.getByText("Prodotto Acme")).toBeInTheDocument();
  });

  it("brief senza testo: lo DICHIARA invece di mostrare una pagina vuota", async () => {
    getBrief.mockResolvedValue(brief({ summary: null, sections: null }));
    renderBrief();
    expect(await screen.findByText(/no text/i)).toBeInTheDocument();
  });

  it("brief ancora in coda: lo dice, e non promette un testo che non c'è", async () => {
    getBrief.mockResolvedValue(brief({ status: "queued", summary: null, sections: null }));
    renderBrief();
    expect(await screen.findByText(/being written/i)).toBeInTheDocument();
  });

  it("«Copia come testo» copia il MARKDOWN, non il testo renderizzato", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderBrief();
    await userEvent.click(await screen.findByRole("button", { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toContain("## Dove siamo");
  });

  it("un maintainer può rigenerare; il member non vede il bottone", async () => {
    renderBrief();
    const regenerate = await screen.findByRole("button", { name: /regenerate/i });
    await userEvent.click(regenerate);
    await waitFor(() => expect(generateProjectBrief).toHaveBeenCalledWith(PROJECT_ID, { force: true }));
  });

  it("il member NON vede «Rigenera»: è un run AI, lo decide un maintainer", async () => {
    getMe.mockResolvedValue({ user: { id: "u2", email: "bob@example.com", role: "member" } });
    renderBrief();
    await screen.findByText(/Il progetto è a metà del lavoro sul login\./);
    expect(screen.queryByRole("button", { name: /regenerate/i })).not.toBeInTheDocument();
    // La copia resta a tutti: leggere e inoltrare non è un privilegio.
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });
});
