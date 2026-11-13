import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// I rilasci (area 8, F1): i percorsi, i metodi e i corpi che il server si aspetta.

function client(body: unknown, { status = 200 } = {}) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "https://x.test", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof client>["fetchImpl"], i = 0) => {
  const [url, init] = f.mock.calls[i]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

describe("client.releases", () => {
  it("elenco, dettaglio, «Fai sistemare a Claude», PR aperte, coda, Home", async () => {
    const { c, fetchImpl } = client({ items: [] });
    await c.releases.list("p1");
    await c.releases.get("AUD-V7");
    await c.releases.fix("AUD-V7", { note: "n", start: true });
    await c.releases.pulls("p1");
    await c.releases.queue();
    await c.releases.mine();
    expect(fetchImpl.mock.calls.map((_, i) => `${call(fetchImpl, i).method} ${call(fetchImpl, i).url}`)).toEqual([
      "GET https://x.test/api/projects/p1/releases",
      "GET https://x.test/api/releases/AUD-V7",
      "POST https://x.test/api/releases/AUD-V7/fix",
      "GET https://x.test/api/projects/p1/pulls",
      "GET https://x.test/api/release-queue",
      "GET https://x.test/api/me/releases",
    ]);
    expect(call(fetchImpl, 2).body).toEqual({ note: "n", start: true });
  });

  it("le note di una PR e «Solo analisi»", async () => {
    const { c, fetchImpl } = client({});
    await c.releases.releaseNotes("r1", 42);
    await c.releases.putReleaseNotes("r1", 42, "testo");
    await c.releases.analysisOnly("r1", 42, true);
    await c.releases.analysisOnly("r1", 42, false);
    expect(call(fetchImpl)).toMatchObject({ method: "GET", url: "https://x.test/api/repositories/r1/pulls/42/release-notes" });
    expect(call(fetchImpl, 1)).toMatchObject({ method: "PUT", url: "https://x.test/api/repositories/r1/pulls/42/release-notes", body: { body: "testo" } });
    expect(call(fetchImpl, 2)).toMatchObject({ method: "POST", url: "https://x.test/api/repositories/r1/pulls/42/analysis-only" });
    expect(call(fetchImpl, 3)).toMatchObject({ method: "DELETE", url: "https://x.test/api/repositories/r1/pulls/42/analysis-only" });
  });
});

describe("client.environments", () => {
  const env = { id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", name: "production", kind: "production", url: null, serverId: null, createdAt: "2026-11-13T10:00:00.000Z", updatedAt: "2026-11-13T10:00:00.000Z" };

  it("un ambiente di un server di prima, SENZA `servers`, si legge con `servers: []`", async () => {
    const { c } = client([env]);
    const [read] = await c.environments.list("p1");
    expect(read!.servers).toEqual([]);
  });

  it("crea e modifica coi server per repository", async () => {
    const { c, fetchImpl } = client({ ...env, servers: [] });
    await c.environments.create("p1", { name: "production", kind: "production", servers: [{ repositoryId: env.id, serverId: env.projectId }] });
    await c.environments.update("p1", "e1", { servers: [{ repositoryId: env.id, serverId: null }] });
    expect(call(fetchImpl)).toMatchObject({ method: "POST", url: "https://x.test/api/projects/p1/environments", body: { servers: [{ repositoryId: env.id }] } });
    expect(call(fetchImpl, 1)).toMatchObject({ method: "PATCH", url: "https://x.test/api/projects/p1/environments/e1", body: { servers: [{ serverId: null }] } });
  });
});
