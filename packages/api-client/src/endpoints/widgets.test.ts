import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

// I widget di Support (area 8, F3): percorsi, metodi, corpi, e una risposta di
// un server più vecchio senza `canManage`.

const P = "11111111-1111-4111-8111-111111111111";
const W = "22222222-2222-4222-8222-222222222222";
const widget = {
  id: W,
  name: "Sito",
  key: "abc",
  enabled: true,
  enabledRepositoryIds: [],
  repositoryFilters: {},
  title: "Help",
  welcomeMessage: "Hi",
  instructions: "",
  accentColor: "#22c55e",
  language: "it",
  dailyMessageCap: null,
  dailyTicketCap: null,
  createdAt: "2026-11-14T10:00:00.000Z",
  conversationCount: 3,
};
function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
  return { c: createStubwiseClient({ baseUrl: "https://x.test", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof client>["fetchImpl"], i = 0) => {
  const [url, init] = f.mock.calls[i]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
};
const body = { name: "Sito", enabled: true, enabledRepositoryIds: [], title: "Help", welcomeMessage: "Hi", instructions: "", accentColor: "#22c55e", language: "it" as const, dailyMessageCap: null, dailyTicketCap: null, repositoryFilters: {} };

describe("client.widgets", () => {
  it("list: i widget col numero di conversazioni; un server senza `canManage` → false", async () => {
    const { c, fetchImpl } = client({ widgets: [widget] });
    const out = await c.widgets.list(P);
    expect(call(fetchImpl)).toMatchObject({ url: `https://x.test/api/projects/${P}/widgets`, method: "GET" });
    expect(out).toMatchObject({ canManage: false, widgets: [{ id: W, conversationCount: 3, origins: [] }] });
  });

  it("i siti ammessi (S16): nel corpo, facoltativi; nella risposta", async () => {
    const { c, fetchImpl } = client({ widget: { ...widget, origins: ["https://shop.it"] } });
    const out = await c.widgets.update(P, W, { ...body, origins: ["https://shop.it"] });
    expect(call(fetchImpl).body).toMatchObject({ origins: ["https://shop.it"] });
    expect(out.widget.origins).toEqual(["https://shop.it"]);
  });

  it("create, update (corpo INTERO: è una sostituzione), delete", async () => {
    const { c, fetchImpl } = client({ widget });
    await c.widgets.create(P, body);
    await c.widgets.update(P, W, body);
    expect(call(fetchImpl)).toMatchObject({ url: `https://x.test/api/projects/${P}/widgets`, method: "POST", body: { name: "Sito" } });
    expect(call(fetchImpl, 1)).toMatchObject({ url: `https://x.test/api/projects/${P}/widgets/${W}`, method: "PUT", body: { repositoryFilters: {} } });
    const del = client(null, 204);
    await del.c.widgets.delete(P, W);
    expect(call(del.fetchImpl)).toMatchObject({ url: `https://x.test/api/projects/${P}/widgets/${W}`, method: "DELETE" });
  });
});

describe("widgets: l'identità dei clienti (area 8, «L'API per i siti»)", () => {
  it("un widget di un server più vecchio, senza i campi d'identità: segreto assente, data null, obbligo spento", async () => {
    const { c } = client({ widgets: [widget], canManage: true });
    const res = await c.widgets.list(P);
    expect(res.widgets[0]).toMatchObject({ identitySecretSet: false, identitySecretRotatedAt: null, identityRequired: false });
  });

  it("regenerateIdentitySecret: POST …/identity-secret, il segreto e la data", async () => {
    const { c, fetchImpl } = client({ secret: "s3gr3t0", rotatedAt: "2026-11-16T09:00:00.000Z" });
    const res = await c.widgets.regenerateIdentitySecret(P, W);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://x.test/api/projects/${P}/widgets/${W}/identity-secret`);
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe("POST");
    expect(res).toEqual({ secret: "s3gr3t0", rotatedAt: "2026-11-16T09:00:00.000Z" });
  });
});

