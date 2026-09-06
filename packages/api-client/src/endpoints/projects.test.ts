import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Endpoint `projects` costruiti dal CLIENT: url, metodo e querystring. Non c'è
 * un server dietro — `fetch` è finto — e non è una lacuna: i test del server
 * iniettano già il payload e non vedono MAI come il client compone il path.
 */
const ID = "11111111-1111-4111-8111-111111111111";

function clientVuoto() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ from: "", to: "", entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createStubwiseClient({
    baseUrl: "",
    getAuthHeader: () => null,
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

function lastUrl(fetchImpl: ReturnType<typeof clientVuoto>["fetchImpl"]): string {
  return String(fetchImpl.mock.calls.at(-1)![0]);
}

describe("endpoints projects: reviews e timeline (fase 5)", () => {
  it("reviews: GET sotto il progetto, senza limit se non richiesto", async () => {
    const { client, fetchImpl } = clientVuoto();
    fetchImpl.mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await client.projects.reviews(ID);
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/reviews`);
  });

  it("reviews: il limit finisce in querystring", async () => {
    const { client, fetchImpl } = clientVuoto();
    fetchImpl.mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await client.projects.reviews(ID, { limit: 5 });
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/reviews?limit=5`);
  });

  it("timeline: senza parametri il path è nudo (i default sono del server)", async () => {
    const { client, fetchImpl } = clientVuoto();
    await client.projects.timeline(ID);
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/timeline`);
  });

  it("timeline: `kinds` viaggia come elenco separato da virgole", async () => {
    const { client, fetchImpl } = clientVuoto();
    await client.projects.timeline(ID, {
      from: "2026-08-01T00:00:00.000Z",
      kinds: ["pr_merged", "brief"],
    });
    const url = new URL(lastUrl(fetchImpl), "https://example.test");
    expect(url.pathname).toBe(`/api/projects/${ID}/timeline`);
    expect(url.searchParams.get("from")).toBe("2026-08-01T00:00:00.000Z");
    expect(url.searchParams.get("kinds")).toBe("pr_merged,brief");
  });

  it("timeline: un `kinds` VUOTO non diventa `kinds=` (che il server leggerebbe come parametro presente)", async () => {
    const { client, fetchImpl } = clientVuoto();
    await client.projects.timeline(ID, { kinds: [] });
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/timeline`);
  });
});

/** Client il cui `fetch` finto risponde SEMPRE il body dato (schemi validati). */
function clientCon(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = createStubwiseClient({
    baseUrl: "",
    getAuthHeader: () => null,
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

const BRIEF = {
  id: ID,
  projectId: ID,
  periodStart: "2026-08-31",
  periodEnd: "2026-09-06",
  status: "done",
  summary: "## Dove siamo\n\nTutto bene.",
  sections: { whereWeAre: "Tutto bene." },
  notificationId: null,
  createdAt: "2026-09-07T07:30:00.000Z",
  finishedAt: "2026-09-07T07:31:00.000Z",
};

describe("endpoints projects: brief settimanale (fase 5)", () => {
  it("briefs: GET sotto il progetto, col limit in querystring quando c'è", async () => {
    const { client, fetchImpl } = clientCon([BRIEF]);
    await client.projects.briefs(ID);
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/briefs`);
    await client.projects.briefs(ID, { limit: 5 });
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/briefs?limit=5`);
  });

  it("generateBrief: POST col force nel corpo, non in querystring", async () => {
    const { client, fetchImpl } = clientCon(BRIEF);
    await client.projects.generateBrief(ID, { force: true });
    expect(lastUrl(fetchImpl)).toBe(`/api/projects/${ID}/briefs/generate`);
    const init = fetchImpl.mock.calls.at(-1)![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ force: true });
  });

  it("brief: rotta di PRIMO LIVELLO per id, non annidata sotto il progetto", async () => {
    const { client, fetchImpl } = clientCon(BRIEF);
    await client.projects.brief(ID);
    expect(lastUrl(fetchImpl)).toBe(`/api/briefs/${ID}`);
  });
});
