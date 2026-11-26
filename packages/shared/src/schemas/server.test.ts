import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import {
  createServerSchema,
  serverDetailSchema,
  serverEpisodeSchema,
  serverMetricsResponseSchema,
  serverViewSchema,
  serverWithKeySchema,
} from "./server.js";

/**
 * Le proiezioni di lettura dei server, come le legge un CLIENT che parsa
 * (l'app mobile, via `readerSchema`).
 */
const VIEW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "prod-web-1",
  hostname: "web1.acme.test",
  status: "online",
  sampleIntervalSeconds: 30,
  agentVersion: "1.4.0",
  alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
  lastSeenAt: "2026-09-23T10:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
  projects: [],
  checksUp: 0,
  checksDown: 0,
  recentCpu: [],
};

describe("serverDetailSchema: la memoria è un campo AGGIUNTO (23 set 2026)", () => {
  /**
   * ⚠️ Il caso del server PIÙ VECCHIO dell'app: un rollback, o un'istanza
   * self-hosted non aggiornata, risponde senza i due campi. La fixture è
   * senza apposta — è la prova che il `.default(null)` c'è, non una svista
   * da completare.
   */
  it("un dettaglio SENZA la memoria si legge lo stesso, con null e non 0", () => {
    const detail = readerSchema(serverDetailSchema).parse({
      ...VIEW,
      services: [],
      disks: [],
      metricsAt: "2026-09-23T10:00:00.000Z",
    });
    expect(detail.memUsedBytes).toBeNull();
    expect(detail.memTotalBytes).toBeNull();
  });

  it("con la memoria, i due numeri arrivano così come sono", () => {
    const detail = serverDetailSchema.parse({
      ...VIEW,
      services: [],
      disks: [],
      metricsAt: "2026-09-23T10:00:00.000Z",
      memUsedBytes: 3_000,
      memTotalBytes: 8_000,
    });
    expect(detail.memUsedBytes).toBe(3_000);
    expect(detail.memTotalBytes).toBe(8_000);
  });

  it("la lista non porta la memoria: è solo del dettaglio", () => {
    const view = serverViewSchema.parse({ ...VIEW, memUsedBytes: 1 });
    expect(view).not.toHaveProperty("memUsedBytes");
  });
});

// Area 8, F4a: i campi nuovi della vista e del dettaglio sono additivi; un
// server più vecchio (senza) si legge coi default che non concedono niente.
describe("area 8, F4a: le forme dei server sono additive", () => {
  const view = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web-1",
    hostname: null,
    status: "never_connected",
    sampleIntervalSeconds: 30,
    agentVersion: null,
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    projects: [],
    checksUp: 0,
    checksDown: 0,
    recentCpu: [],
  };

  it("una vista senza i campi nuovi", () => {
    expect(serverViewSchema.parse(view)).toMatchObject({ code: null, health: null, environments: [], work: "none", orphan: false, inArchivedOnly: false });
  });

  it("un dettaglio senza i campi nuovi", () => {
    const d = serverDetailSchema.parse({ ...view, services: [], disks: [], metricsAt: null });
    expect(d).toMatchObject({ checks: [], episodes: [], productionProjects: [], canManage: false });
  });

  it("la risposta con la chiave: `ingestUrl` assente → null", () => {
    expect(serverWithKeySchema.parse({ ...view, key: "sk_x" }).ingestUrl).toBeNull();
  });

  it("un motivo d'episodio di un tipo nuovo non rompe il parse", () => {
    const e = serverEpisodeSchema.parse({ id: view.id, severity: "trouble", reasons: [{ kind: "gpu", valuePct: 99 }], startedAt: view.createdAt, recoveredAt: null });
    expect(e.reasons[0]!.kind).toBe("gpu");
  });

  it("le risoluzioni nuove delle metriche; la creazione con un ambiente facoltativo", () => {
    expect(serverMetricsResponseSchema.parse({ resolution: "4h", truncated: false, points: [] }).resolution).toBe("4h");
    expect(createServerSchema.parse({ name: "x" }).environment).toBeUndefined();
    expect(createServerSchema.safeParse({ name: "x", environment: { environmentId: view.id, repositoryIds: [] } }).success).toBe(false);
    expect(createServerSchema.parse({ name: "x", environment: { environmentId: view.id } }).environment?.repositoryIds).toBeUndefined();
  });
});
