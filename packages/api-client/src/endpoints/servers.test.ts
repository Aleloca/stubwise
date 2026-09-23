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
