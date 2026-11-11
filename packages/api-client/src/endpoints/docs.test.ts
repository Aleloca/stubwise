import { describe, expect, it, vi } from "vitest";
import { UNKNOWN } from "@stubwise/shared";
import { createStubwiseClient } from "../index.js";

/**
 * Le letture della documentazione che l'app aggiunge («la documentazione
 * nell'app, come sul web», 25 set 2026): highlights, brief, ricerca di
 * progetto e il ping delle visite.
 */
const REPO = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientReturning(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(status, body));
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

const COUNTS = { technical: 1, functional: 0, product: 0, manual: 0, releases: 1 };

describe("endpoints docs — highlights, brief, ricerca, visite", () => {
  it("repoHighlights: GET /api/repositories/:id/docs/highlights", async () => {
    const body = { countsByKind: COUNTS, topViewed: [], recentlyUpdated: [], latestReleases: [] };
    const { c, fetchImpl } = clientReturning(200, body);
    expect(await c.docs.repoHighlights(REPO)).toEqual(body);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/highlights`);
  });

  it("projectHighlights: GET /api/projects/:id/docs/highlights, e un kind nuovo arriva come UNKNOWN", async () => {
    const body = {
      countsByKind: COUNTS,
      topViewed: [
        { slug: "x", title: "X", kind: "diagrams", viewCount: 1, repositoryId: REPO, repositorySlug: "web", repositoryName: "Web" },
      ],
      latestReleases: [],
    };
    const { c, fetchImpl } = clientReturning(200, body);
    const result = await c.docs.projectHighlights(PROJECT);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/projects/${PROJECT}/docs/highlights`);
    expect(result.topViewed[0]?.kind).toBe(UNKNOWN);
  });

  it("brief: GET /api/repositories/:id/docs/brief", async () => {
    const body = {
      brief: {
        identity: "Un gestionale.",
        actors: [],
        surfaces: [],
        glossary: [],
        invariants: [],
        confidentialFacts: [],
        journeys: [],
        existingSources: [],
      },
      generation: { createdAt: "2026-09-25T10:30:00.000Z", commitSha: "abc1234" },
      productExclusions: [],
    };
    const { c, fetchImpl } = clientReturning(200, body);
    expect((await c.docs.brief(REPO)).brief.identity).toBe("Un gestionale.");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/brief`);
  });

  it("projectSearch: GET /api/projects/:id/docs/search?q=, con la query codificata", async () => {
    const hit = {
      slug: "api",
      title: "API",
      kind: "technical",
      snippet: "…",
      score: 0.8,
      source: "hybrid",
      repositoryId: REPO,
      repositorySlug: "web",
      repositoryName: "Web",
    };
    const { c, fetchImpl } = clientReturning(200, [hit]);
    // Un server di prima dell'area 5 non manda `code`: il client lo legge null.
    expect(await c.docs.projectSearch(PROJECT, "login & sso")).toEqual([{ ...hit, code: null }]);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/projects/${PROJECT}/docs/search?q=login+%26+sso`);
  });

  it("viewPage: POST .../docs/pages/:slug/view, 204 senza corpo", async () => {
    const { c, fetchImpl } = clientReturning(204, null);
    await expect(c.docs.viewPage(REPO, "guida/api")).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/repositories/${REPO}/docs/pages/guida%2Fapi/view`);
    expect(init?.method).toBe("POST");
  });
});

describe("endpoints docs — area 5, fetta 1: pagine manuali, generazione, codici", () => {
  const PAGE = {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "runbook",
    title: "Runbook",
    kind: "manual",
    parentId: null,
    position: 0,
    sourcePath: null,
    body: "passi",
    isManual: true,
    commitSha: null,
    commitUrl: null,
    links: null,
    updatedAt: "2026-11-11T10:00:00.000Z",
    createdAt: "2026-11-11T10:00:00.000Z",
    viewCount: 0,
    significant: null,
    staleSince: null,
    code: "AUD-D7",
  };
  const JOB = { id: PAGE.id, status: "queued", trigger: "manual", error: null, createdAt: PAGE.createdAt, startedAt: null, finishedAt: null };

  it("createManualPage: POST …/docs/manual col body, e la pagina col codice", async () => {
    const { c, fetchImpl } = clientReturning(201, PAGE);
    expect(await c.docs.createManualPage(REPO, { title: "Runbook", body: "passi" })).toMatchObject({ code: "AUD-D7" });
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/repositories/${REPO}/docs/manual`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Runbook", body: "passi" });
  });

  it("updateManualPage e deleteManualPage: PATCH e DELETE …/docs/manual/:id", async () => {
    const upd = clientReturning(200, PAGE);
    await upd.c.docs.updateManualPage(REPO, PAGE.id, { body: "nuovi passi" });
    expect(upd.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/manual/${PAGE.id}`);
    expect(upd.fetchImpl.mock.calls.at(-1)![1]?.method).toBe("PATCH");
    const del = clientReturning(204, null);
    await del.c.docs.deleteManualPage(REPO, PAGE.id);
    expect(del.fetchImpl.mock.calls.at(-1)![1]?.method).toBe("DELETE");
  });

  it("generate, resume, status", async () => {
    const gen = clientReturning(202, JOB);
    expect(await gen.c.docs.generate(REPO)).toMatchObject({ status: "queued" });
    expect(gen.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/generate`);
    const res = clientReturning(200, { id: PAGE.id, status: "running", commitSha: null, model: null, cost: null, stats: null, startedAt: null, finishedAt: null, createdAt: PAGE.createdAt });
    expect(await res.c.docs.resume(REPO)).toMatchObject({ status: "running" });
    expect(res.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/resume`);
    const st = clientReturning(200, { generation: null, latestJob: JOB, pinnedProvider: null });
    expect(await st.c.docs.status(REPO)).toMatchObject({ generation: null, latestJob: { status: "queued" } });
    expect(st.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/repositories/${REPO}/docs/status`);
  });

  it("exportPath e resolveCode", async () => {
    const { c, fetchImpl } = clientReturning(200, { code: "AUD-D7", projectId: PROJECT, repositoryId: REPO, repositorySlug: "web", slug: "runbook", available: true });
    expect(c.docs.exportPath(REPO, "manual")).toBe(`/api/repositories/${REPO}/docs/export?kind=manual`);
    expect(await c.docs.resolveCode("AUD-D7")).toMatchObject({ slug: "runbook", available: true });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/docs/codes/AUD-D7");
  });

  it("una pagina da un server che non conosce i codici: code null", async () => {
    const { code: _code, ...old } = PAGE;
    void _code;
    const { c } = clientReturning(200, old);
    expect((await c.docs.page(REPO, "runbook")).code).toBeNull();
  });
});

describe("endpoints docs — stato e spazi da un server di prima (area 5, fetta 1)", () => {
  it("lo stato senza reasonCode, resumesAt e progress li legge null; uno spazio senza projectId lo legge null", async () => {
    const st = clientReturning(200, { generation: null, latestJob: null, pinnedProvider: null });
    expect(await st.c.docs.status(REPO)).toEqual({ generation: null, latestJob: null, pinnedProvider: null, reasonCode: null, resumesAt: null, progress: null });
    const sp = clientReturning(200, [{ repositoryId: REPO, slug: "web", name: "Web", pageCount: 1, lastGenerationAt: null, lastCommitSha: null }]);
    expect((await sp.c.docs.spaces())[0]!.projectId).toBeNull();
  });
});

