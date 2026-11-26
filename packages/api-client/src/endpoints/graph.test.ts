import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Il grafo del codice di un repository (area 5, fetta 1): lo stato, la
// generazione (anche da zero), la PR di setup e il resoconto in Markdown.

const REPO = "7f1c2a1e-0000-4000-8000-0000000000a1";
const state = {
  enabled: true,
  status: "done",
  commitSha: "abc",
  nodeCount: 10,
  edgeCount: 20,
  communityCount: 3,
  labeled: true,
  generatedAt: "2026-11-10T10:00:00.000Z",
  setupPrUrl: null,
  error: null,
  jobPending: false,
  setupPrJobPending: false,
  setupPrError: null,
};

function client(body: unknown, { status = 200, type = "application/json" } = {}) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof client>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

describe("endpoints graph", () => {
  it("lo stato del grafo", async () => {
    const g = client(state);
    expect(await g.c.graph.state(REPO)).toMatchObject({ status: "done", nodeCount: 10 });
    expect(last(g.fetchImpl)).toMatchObject({ url: `/api/repositories/${REPO}/graph`, method: "GET" });
  });

  it("genera (anche da zero) e la PR di setup: 202 «in coda»", async () => {
    const q = client({ queued: true }, { status: 202 });
    await q.c.graph.generate(REPO);
    expect(last(q.fetchImpl)).toEqual({ url: `/api/repositories/${REPO}/graph/generate`, method: "POST", body: {} });
    await q.c.graph.generate(REPO, { force: true });
    expect(last(q.fetchImpl).body).toEqual({ force: true });
    await q.c.graph.setupPr(REPO);
    expect(last(q.fetchImpl)).toMatchObject({ url: `/api/repositories/${REPO}/graph/setup-pr`, method: "POST" });
  });

  it("il resoconto è Markdown, non JSON: torna il testo", async () => {
    const r = client('# Graph Report\n### Community 0 - "app.ts"', { type: "text/markdown; charset=utf-8" });
    expect(await r.c.graph.report(REPO)).toContain("### Community 0");
    expect(last(r.fetchImpl)).toMatchObject({ url: `/api/repositories/${REPO}/graph/report`, method: "GET" });
  });
});
