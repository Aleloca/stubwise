import { isUnknown } from "@stubwise/shared";
import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Endpoint `servers` costruito dal CLIENT: url, metodo e lettura della
 * risposta. Come i gemelli accanto, non c'è un server dietro — `fetch` è
 * finto.
 */
const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const VIEW = {
  id: SERVER_ID,
  name: "prod-web-1",
  hostname: "web1.acme.test",
  status: "online",
  sampleIntervalSeconds: 30,
  agentVersion: "1.4.0",
  alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
  lastSeenAt: "2026-09-23T10:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
  projects: [{ id: PROJECT_ID, name: "Portale B2B" }],
  checksUp: 3,
  checksDown: 1,
  recentCpu: [12, 18, 25],
};

const DETAIL = {
  ...VIEW,
  services: [
    { source: "docker", name: "api", state: "running", cpuPct: 4.2, memBytes: 1024, restarts: null },
  ],
  disks: [{ mount: "/", usedBytes: 40, totalBytes: 100 }],
  metricsAt: "2026-09-23T10:00:00.000Z",
};

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

describe("endpoints servers", () => {
  it("list: senza progetto il path è nudo", async () => {
    const { client, fetchImpl } = clientReturning([VIEW]);
    await client.servers.list();
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/servers");
    expect(fetchImpl.mock.calls.at(-1)![1]?.method).toBe("GET");
  });

  // ⌘K (rimandi, lotto 5, voce 1; 72, a7557fe21): la ricerca, con `q` in query.
  it("search: `q` in query, gli elementi letti dallo schema", async () => {
    const item = { code: "SRV-2", name: "prod-web-1", projectCode: "AUD" };
    const { client, fetchImpl } = clientReturning({ items: [item] });
    expect(await client.servers.search("web 1")).toEqual([item]);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("/api/servers/search?q=web+1");
  });

  it("list: il progetto viaggia in query", async () => {
    const { client, fetchImpl } = clientReturning([VIEW]);
    await client.servers.list(PROJECT_ID);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe(`/api/servers?projectId=${PROJECT_ID}`);
  });

  it("get: il dettaglio per id, con lo snapshot dell'ultimo campione", async () => {
    const { client, fetchImpl } = clientReturning(DETAIL);
    const server = await client.servers.get(SERVER_ID);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe(`/api/servers/${SERVER_ID}`);
    expect(server.disks).toEqual([{ mount: "/", usedBytes: 40, totalBytes: 100 }]);
    expect(server.metricsAt).toBe("2026-09-23T10:00:00.000Z");
    expect(server.checksDown).toBe(1);
  });

  /**
   * ⚠️ La chiave dell'agente non fa parte della proiezione pubblica, e
   * `serverViewSchema` è un `z.object`, che STRIPPA i campi in più: anche se
   * un server la mandasse per errore (la variante con la chiave esiste, per
   * creazione e rigenerazione), non arriverebbe a nessuna UI dell'app.
   */
  it("la chiave dell'agente non arriva al client nemmeno se il server la mandasse", async () => {
    const { client } = clientReturning({ ...DETAIL, key: "sk_non-deve-passare", keyHash: "x" });
    const server = await client.servers.get(SERVER_ID);
    expect(server).not.toHaveProperty("key");
    expect(server).not.toHaveProperty("keyHash");
  });

  it("uno stato che questa build non conosce arriva come UNKNOWN, non fa fallire la lista", async () => {
    const { client } = clientReturning([{ ...VIEW, status: "maintenance" }]);
    const [server] = await client.servers.list();
    expect(isUnknown(server!.status)).toBe(true);
  });
});

// Area 8, F4a: le letture nuove (per codice, metriche, controlli) e le
// scritture per l'app desktop. La chiave passa SOLO da create e regenerateKey.
describe("endpoints servers (area 8, F4a)", () => {
  const call = (f: ReturnType<typeof clientReturning>["fetchImpl"], i = 0) => {
    const [url, init] = f.mock.calls[i]!;
    return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  it("byCode, metriche (con la finestra in query) e controlli", async () => {
    const { client, fetchImpl } = clientReturning(DETAIL);
    const d = await client.servers.byCode("SRV-3");
    expect(call(fetchImpl).url).toBe("/api/servers/by-code/SRV-3");
    expect(d).toMatchObject({ code: null, checks: [], episodes: [], canManage: false });
    const m = clientReturning({ resolution: "1h", truncated: false, points: [] });
    const out = await m.client.servers.metrics(SERVER_ID, { from: "2026-11-01T00:00:00.000Z", to: "2026-11-14T00:00:00.000Z" });
    expect(call(m.fetchImpl).url).toBe(`/api/servers/${SERVER_ID}/metrics?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-14T00%3A00%3A00.000Z`);
    expect(out.resolution).toBe("1h");
    const c = clientReturning([]);
    await c.client.servers.checks(SERVER_ID);
    expect(call(c.fetchImpl).url).toBe(`/api/servers/${SERVER_ID}/checks`);
  });

  it("create e regenerateKey portano la chiave e l'ingestUrl (null da un server più vecchio)", async () => {
    const { client, fetchImpl } = clientReturning({ ...VIEW, key: "sk_abc" });
    const created = await client.servers.create({ name: "web", environment: { environmentId: PROJECT_ID, repositoryIds: [SERVER_ID] } });
    expect(call(fetchImpl)).toMatchObject({ url: "/api/servers", method: "POST", body: { name: "web", environment: { environmentId: PROJECT_ID } } });
    expect(created).toMatchObject({ key: "sk_abc", ingestUrl: null });
    const r = clientReturning({ ...VIEW, key: "sk_new", ingestUrl: "https://s.example" });
    expect(await r.client.servers.regenerateKey(SERVER_ID)).toMatchObject({ key: "sk_new", ingestUrl: "https://s.example" });
    expect(call(r.fetchImpl)).toMatchObject({ url: `/api/servers/${SERVER_ID}/regenerate-key`, method: "POST" });
  });

  it("update, soglie (oggetto intero), controlli: percorsi e corpi", async () => {
    const { client, fetchImpl } = clientReturning(VIEW);
    await client.servers.update(SERVER_ID, { name: "nuovo" });
    await client.servers.setThresholds(SERVER_ID, { cpuPct: 80, memPct: 90, diskPct: null, sustainedMinutes: 5 });
    await client.servers.createCheck(SERVER_ID, { type: "http", name: "home", target: "https://x", intervalSeconds: 60, enabled: true }).catch(() => undefined);
    await client.servers.updateCheck(SERVER_ID, PROJECT_ID, { enabled: false }).catch(() => undefined);
    expect(call(fetchImpl, 0)).toMatchObject({ url: `/api/servers/${SERVER_ID}`, method: "PATCH", body: { name: "nuovo" } });
    expect(call(fetchImpl, 1)).toMatchObject({ method: "PATCH", body: { alertThresholds: { cpuPct: 80, diskPct: null } } });
    expect(call(fetchImpl, 2)).toMatchObject({ url: `/api/servers/${SERVER_ID}/checks`, method: "POST", body: { type: "http" } });
    expect(call(fetchImpl, 3)).toMatchObject({ url: `/api/servers/${SERVER_ID}/checks/${PROJECT_ID}`, method: "PUT", body: { enabled: false } });
  });
});

