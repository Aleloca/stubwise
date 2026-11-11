import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoute } from "../../../test/renderRoute";
import { setAppClientForTests } from "./client";
import { forgetDocsCaches } from "./docs";
import { DEPT_ID, installFakeServer, me, ME_ID, PROJECT_ID, serverProject, type SeenRequest } from "./fakeServer";

// I Docs nelle pagine della build app (area 5, fetta 1): la sezione accesa,
// sulle rotte del server. La pagina iniziale, lo spazio con l'albero, una
// pagina (col suo codice), la chat senza streaming e il grafo.
vi.mock("@backend/api", async () => await import("./index"));

const REPO = "7f1c2a1e-0000-4000-8000-0000000000a1";
const P1 = "7f1c2a1e-0000-4000-8000-0000000000b1";
const P2 = "7f1c2a1e-0000-4000-8000-0000000000b2";
let seen: SeenRequest[] = [];

const node = (over: Record<string, unknown>) => ({
  id: P1,
  slug: "guide",
  title: "Guide",
  kind: "functional",
  parentId: null,
  position: 0,
  sourcePath: null,
  isManual: false,
  createdAt: "2026-11-01T10:00:00.000Z",
  viewCount: 0,
  significant: null,
  code: "AUD-D1",
  ...over,
});
const page = {
  id: P2,
  slug: "dialer",
  title: "Dialer",
  kind: "functional",
  parentId: P1,
  position: 0,
  sourcePath: "src/dialer",
  body: "# Dialer\n\nCalls the leads in order.\n",
  isManual: false,
  commitSha: "abc123",
  commitUrl: null,
  links: null,
  updatedAt: "2026-11-09T10:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
  viewCount: 7,
  significant: null,
  code: "AUD-D2",
};
const graph = {
  enabled: true,
  status: "done",
  commitSha: "abc",
  nodeCount: 120,
  edgeCount: 300,
  communityCount: 1,
  labeled: true,
  generatedAt: "2026-11-10T10:00:00.000Z",
  setupPrUrl: null,
  error: null,
  jobPending: false,
  setupPrJobPending: false,
  setupPrError: null,
};

function install(routes: Record<string, unknown> = {}) {
  seen = installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: ["tickets.view_all", "docs.view", "docs.edit"] } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    "GET /api/me/follows": { body: { projectIds: [PROJECT_ID] } },
    "GET /api/decisions": { body: [] },
    "GET /api/me/claude-decisions": { body: [] },
    "GET /api/inbox": { body: { items: [], nextCursor: null } },
    "GET /api/people": { body: [{ id: ME_ID, name: "Ada", initials: "AD", departmentIds: [DEPT_ID], email: "ada@example.com" }] },
    "GET /api/departments": { body: [{ id: DEPT_ID, name: "General", colorToken: "--dept-1", isDefault: true }] },
    "GET /api/agent-sessions": { body: { live: [], recent: [] } },
    "GET /api/claude/conversations/status": { body: { budgetExhausted: false } },
    [`GET /api/projects/${PROJECT_ID}/decisions`]: { body: [] },
    [`GET /api/projects/${PROJECT_ID}/docs/spaces`]: {
      body: [{ repositoryId: REPO, projectId: PROJECT_ID, slug: "audin-app", name: "audin-app", pageCount: 2, lastGenerationAt: null, lastCommitSha: null }],
    },
    "GET /api/docs/spaces": {
      body: [{ repositoryId: REPO, projectId: PROJECT_ID, slug: "audin-app", name: "audin-app", pageCount: 2, lastGenerationAt: null, lastCommitSha: null }],
    },
    [`GET /api/repositories/${REPO}/docs/tree`]: { body: [node({}), node({ id: P2, slug: "dialer", title: "Dialer", parentId: P1, code: "AUD-D2", viewCount: 7 })] },
    [`GET /api/repositories/${REPO}/docs/highlights`]: {
      body: {
        countsByKind: { technical: 0, functional: 2, product: 0, manual: 0, releases: 0 },
        topViewed: [{ slug: "dialer", title: "Dialer", kind: "functional", viewCount: 7, code: "AUD-D2" }],
        recentlyUpdated: [],
        latestReleases: [],
      },
    },
    [`GET /api/repositories/${REPO}/docs/status`]: { body: { generation: null, latestJob: null, pinnedProvider: null } },
    [`GET /api/repositories/${REPO}/docs/brief`]: { status: 404, body: { code: "not_found", message: "x" } },
    [`GET /api/repositories/${REPO}/docs/pages/dialer`]: { body: page },
    [`POST /api/repositories/${REPO}/docs/pages/dialer/view`]: { status: 204 },
    [`GET /api/repositories/${REPO}/graph`]: { body: graph },
    [`GET /api/repositories/${REPO}/graph/report`]: {
      body: '## Communities (1 total)\n\n### Community 0 - "dialer.ts"\nCohesion: 0.10\nNodes (12): Dialer, callNext() (+10 more)\n',
      contentType: "text/markdown",
    },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]).seen;
}

beforeEach(() => {
  setAppClientForTests(null);
  forgetDocsCaches();
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("i Docs nella build app", () => {
  it("la pagina iniziale del progetto: gli spazi, non «Coming soon»", async () => {
    install();
    renderRoute("/p/AUD/docs");
    expect(await screen.findByRole("heading", { level: 1, name: "Docs" }, { timeout: 3000 })).toBeInTheDocument();
    const spaces = await screen.findByRole("list", { name: "Code" });
    expect(within(spaces).getByRole("link", { name: /audin-app/ })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).toBeNull();
  });

  it("lo spazio: le categorie coi conteggi dell'albero, le più lette", async () => {
    install();
    renderRoute("/p/AUD/docs/audin-app");
    expect(await screen.findByRole("heading", { level: 1, name: "audin-app" }, { timeout: 3000 })).toBeInTheDocument();
    // Le categorie dello spazio coi loro conteggi dall'albero del server.
    expect(await screen.findByText("2 pages")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Most read" })).toHaveTextContent("AUD-D2");
  });

  it("una pagina: titolo, codice e corpo; aprirla registra la visita", async () => {
    install();
    renderRoute("/p/AUD/docs/audin-app/dialer");
    expect(await screen.findByRole("heading", { level: 1, name: "Dialer" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getAllByText("AUD-D2").length).toBeGreaterThan(0);
    expect(screen.getByText("Calls the leads in order.")).toBeInTheDocument();
    await waitFor(() => expect(seen.some((r) => r.method === "POST" && r.path.endsWith("/docs/pages/dialer/view"))).toBe(true));
  });

  it("la chat del progetto: la domanda va al server senza streaming, la risposta cita la pagina", async () => {
    install({
      [`POST /api/projects/${PROJECT_ID}/docs/chat`]: {
        body: {
          answer: "It calls leads in order.",
          sessionId: "7f1c2a1e-0000-4000-8000-0000000000e9",
          sources: [{ slug: "dialer", title: "Dialer", kind: "functional", repositoryId: REPO, repositorySlug: "audin-app", repositoryName: "audin-app", code: "AUD-D2" }],
        },
      },
    });
    const ue = userEvent.setup();
    renderRoute("/p/AUD/docs");
    const field = await screen.findByRole("textbox", { name: "Ask the docs" }, { timeout: 3000 });
    await ue.type(field, "How does the dialer work?{Enter}");
    expect(await screen.findByText("It calls leads in order.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(seen.find((r) => r.method === "POST" && r.path.includes("/docs/chat"))).toMatchObject({
      path: `/api/projects/${PROJECT_ID}/docs/chat?stream=false`,
      body: { message: "How does the dialer work?" },
    });
  });

  it("il grafo: pronto, coi conteggi e le comunità", async () => {
    install();
    renderRoute("/p/AUD/docs/audin-app/graph");
    expect((await screen.findAllByText("dialer.ts", {}, { timeout: 3000 })).length).toBeGreaterThan(0);
  });
  it("modificare una manuale: lo slug non cambia sul server, il form lo dice", async () => {
    const P3 = "7f1c2a1e-0000-4000-8000-0000000000b3";
    const notes = { ...page, id: P3, slug: "notes", title: "Team notes", kind: "manual", isManual: true, parentId: null, sourcePath: null, commitSha: null, code: "AUD-D3", body: "Notes" };
    install({
      [`GET /api/repositories/${REPO}/docs/pages/notes`]: { body: notes },
      [`GET /api/repositories/${REPO}/docs/tree`]: { body: [node({ id: P3, slug: "notes", title: "Team notes", kind: "manual", isManual: true, code: "AUD-D3" })] },
    });
    const ue = userEvent.setup();
    renderRoute("/p/AUD/docs/audin-app/notes/edit");
    const slug = await screen.findByLabelText(/^Slug/, {}, { timeout: 3000 });
    await ue.clear(slug);
    await ue.type(slug, "renamed");
    await ue.click(screen.getByRole("button", { name: "Save page" }));
    expect(await screen.findByText("A page's address can't change after it's created: keep the slug as it is.")).toBeInTheDocument();
    expect(seen.some((r) => r.method === "PATCH")).toBe(false);
  });
  it("un repository col nome diverso dallo slug: i link per slug si aprono (e quelli vecchi per nome)", async () => {
    install({
      [`GET /api/projects/${PROJECT_ID}/docs/spaces`]: {
        body: [{ repositoryId: REPO, projectId: PROJECT_ID, slug: "audin-app", name: "Audin App", pageCount: 2, lastGenerationAt: null, lastCommitSha: null }],
      },
    });
    const router = renderRoute("/p/AUD/docs/audin-app/dialer");
    expect(await screen.findByRole("heading", { level: 1, name: "Dialer" }, { timeout: 3000 })).toBeInTheDocument();
    // Un link vecchio, col nome del repository.
    void router.navigate({ to: "/p/$code/docs/$repo/$slug", params: { code: "AUD", repo: "Audin App", slug: "dialer" } });
    await waitFor(() => expect(decodeURIComponent(router.state.location.pathname)).toBe("/p/AUD/docs/Audin App/dialer"));
    expect(await screen.findByRole("heading", { level: 1, name: "Dialer" }, { timeout: 3000 })).toBeInTheDocument();
  });
});
