import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { docs, forgetDocsCaches } from "./docs";
import { resolveCitations } from "./claudeChat";
import { installFakeServer, me, ME_ID, PROJECT_ID, serverProject } from "./fakeServer";
import { getSessionPerson } from "./session";

// I Docs nella build app (area 5, fetta 1): gli spazi, l'albero, la pagina, la
// ricerca, il brief e la pagina iniziale del progetto, letti dalle rotte del
// server nella forma del prototipo. Chi legge e chi scrive lo dice il server
// (i permessi di progetto di chi guarda); un campo che il server non dà resta
// vuoto (le differenze stanno nella parità).

const REPO = "7f1c2a1e-0000-4000-8000-0000000000a1";
const P1 = "7f1c2a1e-0000-4000-8000-0000000000b1";
const P2 = "7f1c2a1e-0000-4000-8000-0000000000b2";
const P3 = "7f1c2a1e-0000-4000-8000-0000000000b3";
const REL = "7f1c2a1e-0000-4000-8000-0000000000b9";

const space = { repositoryId: REPO, slug: "audin-app", name: "audin-app", pageCount: 3, lastGenerationAt: null, lastCommitSha: null };
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
const tree = [
  node({}),
  node({ id: P2, slug: "dialer", title: "Dialer", parentId: P1, code: "AUD-D2", viewCount: 7 }),
  node({ id: P3, slug: "notes", title: "Team notes", kind: "manual", isManual: true, code: "AUD-D3" }),
  node({ id: REL, slug: "release-2026-11-10", title: "Nov 10", kind: "releases", significant: true, code: null }),
];
const page = (over: Record<string, unknown> = {}) => ({
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
  links: [{ type: "related", slug: "notes", title: "Team notes" }],
  updatedAt: "2026-11-09T10:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
  viewCount: 7,
  significant: null,
  staleSince: [{ sha: "def456", subject: "Rework dialer", summary: "", committedAt: "2026-11-10T09:00:00.000Z" }],
  code: "AUD-D2",
  ...over,
});
const highlights = {
  countsByKind: { technical: 0, functional: 2, product: 0, manual: 1, releases: 1 },
  topViewed: [{ slug: "dialer", title: "Dialer", kind: "functional", viewCount: 7, code: "AUD-D2" }],
  recentlyUpdated: [{ slug: "notes", title: "Team notes", kind: "manual", viewCount: 0, code: "AUD-D3" }],
  latestReleases: [],
};

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

function install(routes: Record<string, unknown> = {}, permissions = ["docs.view", "docs.edit"]) {
  return installFakeServer({
    "GET /api/auth/me": { body: me({ projectPermissions: { [PROJECT_ID]: permissions } }) },
    "GET /api/projects": { body: [serverProject({ memberIds: [ME_ID] })] },
    [`GET /api/projects/${PROJECT_ID}/docs/spaces`]: { body: [space] },
    [`GET /api/repositories/${REPO}/docs/tree`]: { body: tree },
    [`GET /api/repositories/${REPO}/docs/highlights`]: { body: highlights },
    [`GET /api/repositories/${REPO}/docs/status`]: { body: { generation: null, latestJob: null, pinnedProvider: null } },
    [`GET /api/repositories/${REPO}/docs/brief`]: { status: 404, body: { code: "not_found", message: "x" } },
    [`GET /api/repositories/${REPO}/docs/pages/dialer`]: { body: page() },
    [`POST /api/repositories/${REPO}/docs/pages/dialer/view`]: { status: 204 },
    ...routes,
  } as Parameters<typeof installFakeServer>[0]);
}

describe("gli spazi e l'albero", () => {
  it("lo spazio di un repository: pagine, manuali, più lette e recenti, i permessi di chi guarda", async () => {
    install();
    await getSessionPerson();
    const [view] = await docs.listDocSpaces(PROJECT_ID);
    expect(view).toMatchObject({
      repositoryId: REPO,
      projectId: PROJECT_ID,
      name: "audin-app",
      pageCount: 3,
      manualOnly: false,
      permissions: { edit: true, generate: false, manageRepository: false },
      chatAvailable: true,
      generation: { status: "never" },
      brief: null,
    });
    expect(view!.mostRead.map((p) => p.code)).toEqual(["AUD-D2"]);
    expect(view!.recent.map((p) => p.code)).toEqual(["AUD-D3"]);
    expect(view!.releases.map((r) => r.version)).toEqual(["Nov 10"]);
  });

  it("l'albero: le quattro categorie; una pagina figlia sta sotto il titolo della madre", async () => {
    install();
    await getSessionPerson();
    const categories = await docs.listDocTree(REPO);
    expect(categories.map((c) => [c.kind, c.count])).toEqual([
      ["technical", 0],
      ["functional", 2],
      ["product", 0],
      ["manual", 1],
    ]);
    const functional = categories.find((c) => c.kind === "functional")!;
    const folder = functional.nodes.find((n) => n.page === null)!;
    expect(folder.name).toBe("Guide");
    expect(folder.children.map((c) => c.page?.code)).toEqual(["AUD-D2"]);
  });

  it("un progetto senza Docs per chi guarda: nessuno spazio", async () => {
    install({ [`GET /api/projects/${PROJECT_ID}/docs/spaces`]: { status: 404, body: { code: "not_found", message: "x" } } });
    await getSessionPerson();
    expect(await docs.listDocSpaces(PROJECT_ID)).toEqual([]);
  });
});

describe("la pagina", () => {
  it("il corpo, il codice, i commit dopo l'aggiornamento, i collegamenti risolti sull'albero", async () => {
    install();
    await getSessionPerson();
    const view = (await docs.getDocPage(REPO, "dialer"))!;
    expect(view).toMatchObject({
      id: P2,
      code: "AUD-D2",
      projectId: PROJECT_ID,
      repositoryId: REPO,
      kind: "functional",
      path: "Guide",
      documentsPath: "src/dialer",
      generatedAtCommit: "abc123",
      views: 7,
      repositoryName: "audin-app",
      staleCommits: [{ sha: "def456", message: "Rework dialer", at: "2026-11-10T09:00:00.000Z" }],
      permissions: { edit: false, delete: false },
    });
    expect(view.excerpt).toBe("Calls the leads in order.");
    expect(view.resolvedLinks).toMatchObject([{ type: "related", page: { code: "AUD-D3", slug: "notes" } }]);
  });

  it("una manuale si modifica ed elimina con docs.edit; una pagina che non c'è è null", async () => {
    install({
      [`GET /api/repositories/${REPO}/docs/pages/notes`]: {
        body: page({ id: P3, slug: "notes", title: "Team notes", kind: "manual", isManual: true, parentId: null, links: null, staleSince: null, code: "AUD-D3" }),
      },
    });
    await getSessionPerson();
    expect((await docs.getDocPage(REPO, "notes"))!.permissions).toEqual({ edit: true, delete: true });
    expect(await docs.getDocPage(REPO, "missing")).toBeNull();
  });

  it("aprirla registra una visita (fire-and-forget)", async () => {
    const { seen } = install();
    await getSessionPerson();
    await docs.getDocPage(REPO, "dialer");
    await docs.recordDocView(P2);
    expect(seen.some((r) => r.method === "POST" && r.path === `/api/repositories/${REPO}/docs/pages/dialer/view`)).toBe(true);
  });
});

describe("la ricerca e il brief", () => {
  it("la ricerca del progetto: la pagina, il repository, il codice e il passaggio", async () => {
    install({
      [`GET /api/projects/${PROJECT_ID}/docs/search`]: {
        body: [
          {
            slug: "dialer",
            title: "Dialer",
            kind: "functional",
            snippet: "Calls the leads in order.",
            score: 0.9,
            source: "hybrid",
            repositoryId: REPO,
            repositorySlug: "audin-app",
            repositoryName: "audin-app",
            code: "AUD-D2",
          },
        ],
      },
    });
    await getSessionPerson();
    const hits = await docs.searchDocs("dialer", { repositoryId: REPO });
    expect(hits).toMatchObject([
      { page: { code: "AUD-D2", slug: "dialer", repositoryId: REPO }, repositoryName: "audin-app", projectCode: "AUD", passage: "Calls the leads in order." },
    ]);
  });

  it("il brief nella forma del prototipo; un campo che il server non dà resta vuoto", async () => {
    install({
      [`GET /api/repositories/${REPO}/docs/brief`]: {
        body: {
          brief: {
            identity: "A dialer for sales teams.",
            actors: [{ name: "Agent", description: "Calls leads", internal: false }],
            surfaces: [{ name: "Web app", type: "web", rootPath: "apps/web", audience: "Agents", internal: false }],
            glossary: [{ term: "Lead", definition: "A contact to call" }],
            invariants: ["A lead is called once a day"],
            confidentialFacts: [{ fact: "Uses provider X", reason: "contract", source: "src/x.ts", avoid: "naming X" }],
            journeys: [{ actor: "Agent", title: "Call a lead", summary: "Open, call, log" }],
            existingSources: ["README.md"],
          },
          generation: { createdAt: "2026-11-01T10:00:00.000Z", commitSha: null },
          productExclusions: [{ title: "Billing", fact: "internal only" }],
        },
      },
    });
    await getSessionPerson();
    expect(await docs.getRepoBrief(REPO)).toEqual({
      identity: "A dialer for sales teams.",
      actors: [{ name: "Agent", description: "Calls leads" }],
      surfaces: [{ name: "Web app", audience: "Agents" }],
      glossary: [{ term: "Lead", definition: "A contact to call" }],
      invariants: ["A lead is called once a day"],
      journeys: [{ name: "Call a lead", steps: ["Open, call, log"] }],
      sources: [{ label: "README.md", path: "README.md" }],
      confidentialFacts: [{ fact: "Uses provider X", reason: "contract", where: "src/x.ts", mustNotAppearAs: "naming X" }],
      excludedPages: [{ title: "Billing", reason: "internal only" }],
    });
  });
});

describe("la pagina iniziale del progetto", () => {
  it("gli spazi, «inizia da qui», le decisioni recenti col totale vero, nessuno spazio Prodotto", async () => {
    install({
      [`GET /api/projects/${PROJECT_ID}/decisions`]: {
        body: [
          {
            id: "7f1c2a1e-0000-4000-8000-0000000000c1",
            projectId: PROJECT_ID,
            source: "manual",
            ticketId: null,
            ticketNumber: null,
            title: "Use the new dialer",
            context: null,
            decision: "Yes",
            consequences: null,
            decidedBy: null,
            decidedAt: "2026-11-10T10:00:00.000Z",
            supersededById: null,
            createdAt: "2026-11-10T10:00:00.000Z",
          },
        ],
      },
    });
    await getSessionPerson();
    const home = (await docs.getProjectDocsHome(PROJECT_ID))!;
    expect(home).toMatchObject({
      projectId: PROJECT_ID,
      startHere: { repositoryId: REPO, name: "audin-app", hasBrief: false },
      chatAvailable: true,
      product: null,
      decisions: { total: 1, recent: [{ title: "Use the new dialer" }] },
    });
    expect(home.spaces).toHaveLength(1);
    expect(home.whatsNew.map((r) => r.version)).toEqual(["Nov 10"]);
  });
});

describe("le pagine manuali e la generazione", () => {
  const manual = (over: Record<string, unknown> = {}) =>
    page({ id: P3, slug: "notes", title: "Team notes", kind: "manual", isManual: true, parentId: null, links: null, staleSince: null, sourcePath: null, commitSha: null, code: "AUD-D3", ...over });

  it("crea, modifica ed elimina una manuale con le rotte di oggi; il codice resta", async () => {
    const { seen } = install({
      [`POST /api/repositories/${REPO}/docs/manual`]: { status: 201, body: manual() },
      [`PATCH /api/repositories/${REPO}/docs/manual/${P3}`]: { body: manual({ title: "Team notes v2", body: "New" }) },
      [`DELETE /api/repositories/${REPO}/docs/manual/${P3}`]: { status: 204 },
    });
    await getSessionPerson();
    await docs.listDocTree(REPO);
    const created = await docs.createManualPage(REPO, { title: "Team notes", slug: "notes", body: "# Notes" });
    expect(created).toMatchObject({ id: P3, code: "AUD-D3", kind: "manual", slug: "notes", repositoryId: REPO, projectId: PROJECT_ID });
    const updated = await docs.updateManualPage(P3, { title: "Team notes v2", slug: "notes", body: "New" });
    expect(updated).toMatchObject({ code: "AUD-D3", title: "Team notes v2" });
    await docs.deleteManualPage(P3);
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", `/api/repositories/${REPO}/docs/manual`, { title: "Team notes", slug: "notes", body: "# Notes" }],
      ["PATCH", `/api/repositories/${REPO}/docs/manual/${P3}`, { title: "Team notes v2", body: "New" }],
      ["DELETE", `/api/repositories/${REPO}/docs/manual/${P3}`, undefined],
    ]);
  });

  it("i rifiuti negli errori del form: slug già usato; lo slug di una pagina non cambia", async () => {
    install({
      [`POST /api/repositories/${REPO}/docs/manual`]: { status: 409, body: { code: "doc_page_slug_conflict", message: "x" } },
      [`GET /api/repositories/${REPO}/docs/pages/notes`]: { body: manual() },
    });
    await getSessionPerson();
    await expect(docs.createManualPage(REPO, { title: "Notes", slug: "notes", body: "" })).rejects.toThrow("slug_conflict");
    await docs.getDocPage(REPO, "notes");
    await expect(docs.updateManualPage(P3, { title: "Notes", slug: "renamed", body: "" })).rejects.toThrow("slug_fixed");
  });

  it("avvia e riprende la generazione: lo stato riletto dal server; i rifiuti del prototipo", async () => {
    const job = { id: "7f1c2a1e-0000-4000-8000-0000000000f1", status: "queued", trigger: "manual", error: null, createdAt: "2026-11-11T10:00:00.000Z", startedAt: null, finishedAt: null };
    let generated = false;
    const { seen } = install({
      [`POST /api/repositories/${REPO}/docs/generate`]: () => {
        generated = true;
        return { status: 202, body: job };
      },
      [`GET /api/repositories/${REPO}/docs/status`]: () => ({ body: { generation: null, latestJob: generated ? job : null, pinnedProvider: null } }),
      [`POST /api/repositories/${REPO}/docs/resume`]: { status: 409, body: { code: "generation_not_paused", message: "x" } },
    });
    await getSessionPerson();
    expect(await docs.startGeneration(REPO)).toMatchObject({ status: "queued" });
    expect(seen.some((r) => r.method === "POST" && r.path.endsWith("/docs/generate"))).toBe(true);
    await expect(docs.resumeGeneration(REPO)).rejects.toThrow("generation not paused");
    expect(docs.generationHistory(REPO)).toEqual([]);
  });
});

describe("la chat dei Docs (senza streaming, come il prototipo)", () => {
  const answer = {
    answer: "The dialer calls leads in order (AUD-D2).",
    sessionId: "7f1c2a1e-0000-4000-8000-0000000000e9",
    sources: [{ slug: "dialer", title: "Dialer", kind: "functional", repositoryId: REPO, repositorySlug: "audin-app", repositoryName: "audin-app", code: "AUD-D2" }],
  };

  it("la domanda del progetto: la risposta, le pagine citate col codice e il link, da quale repository", async () => {
    const { seen } = install({ [`POST /api/projects/${PROJECT_ID}/docs/chat`]: { body: answer } });
    await getSessionPerson();
    const out = await docs.askDocs({ projectId: PROJECT_ID, question: "How does the dialer work?" });
    expect(seen.find((r) => r.method === "POST")).toMatchObject({
      path: `/api/projects/${PROJECT_ID}/docs/chat?stream=false`,
      body: { message: "How does the dialer work?" },
    });
    expect(out.text).toBe(answer.answer);
    expect(out.sources).toEqual([{ pageId: out.refs[0]!.id, repositoryName: "audin-app" }]);
    expect(await resolveCitations(out.refs)).toMatchObject([
      { kind: "doc", visible: true, code: "AUD-D2", name: "Dialer", route: "#/p/AUD/docs/audin-app/dialer" },
    ]);
  });

  it("la domanda di un repository va alla sua chat; senza provider è «chat_unavailable»", async () => {
    const { seen } = install({
      [`POST /api/repositories/${REPO}/docs/chat`]: { status: 503, body: { code: "chat_unavailable", message: "x" } },
    });
    await getSessionPerson();
    await expect(docs.askDocs({ projectId: PROJECT_ID, repositoryId: REPO, question: "Hi" })).rejects.toThrow("chat_unavailable");
    expect(seen.some((r) => r.path === `/api/repositories/${REPO}/docs/chat?stream=false`)).toBe(true);
  });
});

describe("il grafo del codice", () => {
  const graph = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    status: "done",
    commitSha: "abc",
    nodeCount: 120,
    edgeCount: 300,
    communityCount: 2,
    labeled: true,
    generatedAt: "2026-11-10T10:00:00.000Z",
    setupPrUrl: "https://git.example/acme/app/pull/9",
    error: null,
    jobPending: false,
    setupPrJobPending: false,
    setupPrError: null,
    ...over,
  });
  const report = [
    "# Graph Report - app (2026-11-10)",
    "## Communities (2 total, 0 thin omitted)",
    "",
    '### Community 0 - "dialer.ts"',
    "Cohesion: 0.10",
    "Nodes (12): Dialer, callNext(), Lead (+9 more)",
    "",
    '### Community 1 - "api.ts"',
    "Cohesion: 0.20",
    "Nodes (30): request(), ApiError (+28 more)",
  ].join("\n");

  it("lo stato nello spazio: pronto coi conteggi, la PR di setup, le comunità dalla più grande", async () => {
    install({
      [`GET /api/repositories/${REPO}/graph`]: { body: graph() },
      [`GET /api/repositories/${REPO}/graph/report`]: { body: report, contentType: "text/markdown; charset=utf-8" },
    });
    await getSessionPerson();
    await docs.listDocSpaces(PROJECT_ID);
    const view = (await docs.getDocSpace(REPO))!;
    expect(view.graph).toMatchObject({
      status: "ready",
      nodes: 120,
      edges: 300,
      communities: 2,
      updatedAt: "2026-11-10T10:00:00.000Z",
      setupPr: { url: "https://git.example/acme/app/pull/9", open: true },
    });
    expect(view.graph.report?.map((c) => [c.name, c.size, c.nodes])).toEqual([
      ["api.ts", 30, ["request()", "ApiError"]],
      ["dialer.ts", 12, ["Dialer", "callNext()", "Lead"]],
    ]);
  });

  it("spento, mai fatto, in coda, fallito (troppo grande)", async () => {
    for (const [g, status, reason] of [
      [graph({ enabled: false }), "disabled", undefined],
      [graph({ status: "none", nodeCount: null }), "never", undefined],
      [graph({ jobPending: true }), "queued", undefined],
      [graph({ status: "failed", error: "repository too large for graphify" }), "failed", "repository_too_large"],
      [graph({ status: "failed", error: "boom" }), "failed", "graphify_error"],
    ] as const) {
      install({ [`GET /api/repositories/${REPO}/graph`]: { body: g } });
      await getSessionPerson();
      const [view] = await docs.listDocSpaces(PROJECT_ID);
      expect(view!.graph.status, status).toBe(status);
      expect(view!.graph.reason).toBe(reason);
    }
  });

  it("le azioni: genera, rigenera, ricostruisci da zero, la PR di setup; lo stato riletto", async () => {
    const { seen } = install({
      [`GET /api/repositories/${REPO}/graph`]: { body: graph({ jobPending: true }) },
      [`POST /api/repositories/${REPO}/graph/generate`]: { status: 202, body: { queued: true } },
      [`POST /api/repositories/${REPO}/graph/setup-pr`]: { status: 202, body: { queued: true } },
    });
    await getSessionPerson();
    await docs.listDocSpaces(PROJECT_ID);
    expect(await docs.graphAction(REPO, "generate")).toMatchObject({ status: "queued" });
    await docs.graphAction(REPO, "regenerate");
    await docs.graphAction(REPO, "rebuild");
    await docs.graphAction(REPO, "setup_pr");
    expect(seen.filter((r) => r.method === "POST").map((r) => [r.path.split("/").pop(), r.body])).toEqual([
      ["generate", {}],
      ["generate", {}],
      ["generate", { force: true }],
      ["setup-pr", undefined],
    ]);
  });
});

