import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// Le iscrizioni agli avvisi (area 8, F2, S8): percorsi, metodi, corpi, e una
// risposta di un server che non manda i campi facoltativi.

const P = "11111111-1111-4111-8111-111111111111";
function client(body: unknown) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "https://x.test", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof client>["fetchImpl"], i = 0) => {
  const [url, init] = f.mock.calls[i]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};
const row = { type: "release.failed", group: "releases", labelKey: "k", app: true, phone: false, state: "on" };

describe("client.alerts", () => {
  it("l'elenco; una riga senza `suspendedReason` né `mandatory` si legge coi default", async () => {
    const { c, fetchImpl } = client({ items: [{ projectId: P, projectCode: "AUD", projectName: "Audin", rows: [row] }] });
    const out = await c.alerts.list();
    expect(call(fetchImpl)).toMatchObject({ url: "https://x.test/api/me/alert-subscriptions", method: "GET" });
    expect(out.items[0]!.rows[0]).toMatchObject({ suspendedReason: null, mandatory: [] });
  });

  it("set (patch, il tipo nel percorso), copy, mute", async () => {
    const { c, fetchImpl } = client({ ...row, before: [row] });
    await c.alerts.set(P, "server.trouble", { app: true });
    await c.alerts.copy(P, "22222222-2222-4222-8222-222222222222");
    await c.alerts.mute(P);
    expect(call(fetchImpl)).toMatchObject({ url: `https://x.test/api/me/alert-subscriptions/${P}/server.trouble`, method: "PUT", body: { app: true } });
    expect(call(fetchImpl, 1)).toMatchObject({ url: `https://x.test/api/me/alert-subscriptions/${P}/copy`, method: "POST", body: { fromProjectId: "22222222-2222-4222-8222-222222222222" } });
    expect(call(fetchImpl, 2)).toMatchObject({ url: `https://x.test/api/me/alert-subscriptions/${P}/mute`, method: "POST" });
  });

  it("uno stato sconosciuto (un server più nuovo) non fa crollare la lista", async () => {
    const { c } = client({ items: [{ projectId: P, projectCode: "AUD", projectName: "Audin", rows: [{ ...row, state: "snoozed" }] }] });
    expect((await c.alerts.list()).items[0]!.rows[0]!.state).toBeDefined();
  });
});
