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
    expect(await c.docs.projectSearch(PROJECT, "login & sso")).toEqual([hit]);
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
