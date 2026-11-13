import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Le Automations (area 7, F1): i percorsi, i metodi e i corpi che il server
// si aspetta; le decisioni sono 204 (le applica il worker).

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

describe("client.automations", () => {
  it("l'elenco coi filtri, il dettaglio per codice", async () => {
    const { c, fetchImpl } = client({ items: [] });
    await c.automations.list({ project: "p1", status: "active", mine: true });
    expect(call(fetchImpl)).toMatchObject({ url: "https://x.test/api/automations?project=p1&status=active&mine=true", method: "GET" });
    await c.automations.get("AUD-A1");
    expect(call(fetchImpl, 1).url).toBe("https://x.test/api/automations/AUD-A1");
  });

  it("le scritture: bozza con expectedRev, pubblica, accendi, pausa, duplica, elimina la bozza, check, tested", async () => {
    const { c, fetchImpl } = client({});
    const flow = { trigger: { kind: "manual" as const }, steps: [], titleTemplate: "R" };
    await c.automations.saveDraft("AUD-A1", { flow, expectedRev: 3 });
    expect(call(fetchImpl)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/draft", method: "PUT", body: { flow, expectedRev: 3 } });
    await c.automations.publish("AUD-A1", { expectedRev: 3 });
    expect(call(fetchImpl, 1)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/publish", method: "POST", body: { expectedRev: 3 } });
    await c.automations.activate("AUD-A1", { mailboxAccountId: "box-1" });
    expect(call(fetchImpl, 2)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/activate", method: "POST", body: { mailboxAccountId: "box-1" } });
    await c.automations.pause("AUD-A1");
    expect(call(fetchImpl, 3)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/pause", method: "POST" });
    await c.automations.duplicate("AUD-A1", { name: "Copia", version: 1 });
    expect(call(fetchImpl, 4).body).toEqual({ name: "Copia", version: 1 });
    await c.automations.check("AUD-A1", flow);
    expect(call(fetchImpl, 5)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/check", body: { flow } });
  });

  it("le esecuzioni: l'elenco globale coi filtri, una per numero, le decisioni col passo atteso", async () => {
    const { c, fetchImpl } = client(null, { status: 204 });
    await c.automations.approve("AUD-A1", 2, { expectedPath: "0", expectedRound: 0, edited: { titolo: "X" } });
    expect(call(fetchImpl)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/runs/2/approve", method: "POST", body: { expectedPath: "0", expectedRound: 0, edited: { titolo: "X" } } });
    await c.automations.reject("AUD-A1", 2, { expectedPath: "0" });
    expect(call(fetchImpl, 1).url).toBe("https://x.test/api/automations/AUD-A1/runs/2/reject");
    await c.automations.cancelRun("AUD-A1", 2);
    await c.automations.retryStep("AUD-A1", 2);
    await c.automations.skipStep("AUD-A1", 2);
    expect([2, 3, 4].map((i) => call(fetchImpl, i).url.split("/").at(-1))).toEqual(["cancel", "retry", "skip"]);
    await c.automations.deleteDraft("AUD-A1", { expectedRev: 4 });
    expect(call(fetchImpl, 5)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/draft?expectedRev=4", method: "DELETE" });
  });

  it("le letture personali", async () => {
    const { c, fetchImpl } = client({ items: [] });
    await c.automations.myApprovals();
    await c.automations.myRuns();
    await c.automations.myRuns({ log: "none" });
    expect([0, 1, 2].map((i) => call(fetchImpl, i).url)).toEqual(["https://x.test/api/me/automation-approvals", "https://x.test/api/me/automation-runs", "https://x.test/api/me/automation-runs?log=none"]);
  });

  it("l'elenco delle esecuzioni", async () => {
    const { c, fetchImpl } = client({ items: [], nextCursor: null });
    await c.automations.runs({ automation: "AUD-A1", status: "failed", cursor: "c1" });
    expect(call(fetchImpl).url).toBe("https://x.test/api/automation-runs?automation=AUD-A1&status=failed&cursor=c1");
    await c.automations.runs({ project: "p1", log: "none" });
    expect(call(fetchImpl, 1).url).toBe("https://x.test/api/automation-runs?project=p1&log=none");
  });

  it("area 7, F3: la stima e il passo di Claude della prova", async () => {
    const { c, fetchImpl } = client({ claudeSteps: 2, estimateUsd: 0.01, model: "claude-sonnet" });
    await c.automations.testEstimate("AUD-A1", { version: "draft", event: { avvio: { data: "x" } } });
    expect(call(fetchImpl)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/test/estimate", method: "POST", body: { version: "draft", event: { avvio: { data: "x" } } } });
    await c.automations.testClaude("AUD-A1", { version: 2, path: "1", vars: {} });
    expect(call(fetchImpl, 1)).toMatchObject({ url: "https://x.test/api/automations/AUD-A1/test/claude", method: "POST", body: { version: 2, path: "1", vars: {} } });
  });
});

