import { describe, expect, it } from "vitest";
import {
  agentConfigSchema,
  alertThresholdsSchema,
  checkResultSchema,
  createCheckSchema,
  createServerSchema,
  discoveredServiceSchema,
  ingestBodySchema,
  metricSampleSchema,
  updateCheckSchema,
  updateServerSchema,
} from "./server.js";

const validSample = {
  ts: "2026-07-13T10:00:00Z",
  cpuPct: 42.5,
  load1m: 0.7,
  memUsedBytes: 4_000_000_000,
  memTotalBytes: 8_000_000_000,
  swapUsedBytes: 0,
  diskUsedBytes: 50_000_000_000,
  diskTotalBytes: 100_000_000_000,
  disks: [{ mount: "/", usedBytes: 50_000_000_000, totalBytes: 100_000_000_000 }],
  netRxBytes: 1024,
  netTxBytes: 2048,
  services: [
    {
      source: "docker" as const,
      name: "stubwise-server-1",
      state: "running",
      cpuPct: 3.2,
      memBytes: 120_000_000,
      restarts: null,
    },
  ],
};

const validCheckResult = {
  checkId: "11111111-1111-4111-8111-111111111111",
  ts: "2026-07-13T10:00:00Z",
  status: "up" as const,
  latencyMs: 12,
  error: null,
  metrics: { connections: 5, cacheHitRatio: 0.98 },
};

describe("ingestBodySchema", () => {
  it("accetta un payload di ingest completo", () => {
    const body = {
      hostname: "vps-01",
      agentVersion: "1.0.0",
      samples: [validSample],
      checkResults: [validCheckResult],
    };
    expect(ingestBodySchema.parse(body)).toMatchObject({ hostname: "vps-01" });
  });

  it("default checkResults a [] quando assente", () => {
    const parsed = ingestBodySchema.parse({
      hostname: "vps-01",
      agentVersion: "1.0.0",
      samples: [validSample],
    });
    expect(parsed.checkResults).toEqual([]);
  });

  it("rifiuta un batch vuoto di samples", () => {
    expect(() =>
      ingestBodySchema.parse({ hostname: "vps-01", agentVersion: "1.0.0", samples: [] }),
    ).toThrow();
  });

  it("rifiuta un agentVersion vuoto", () => {
    expect(() =>
      ingestBodySchema.parse({ hostname: "vps-01", agentVersion: "", samples: [validSample] }),
    ).toThrow();
  });

  it("accetta esattamente 300 samples", () => {
    const samples = Array.from({ length: 300 }, () => validSample);
    const parsed = ingestBodySchema.parse({
      hostname: "vps-01",
      agentVersion: "1.0.0",
      samples,
    });
    expect(parsed.samples).toHaveLength(300);
  });

  it("rifiuta un batch con più di 300 samples", () => {
    const samples = Array.from({ length: 301 }, () => validSample);
    expect(() =>
      ingestBodySchema.parse({ hostname: "vps-01", agentVersion: "1.0.0", samples }),
    ).toThrow();
  });
});

describe("metricSampleSchema", () => {
  it("default disks e services a [] quando assenti", () => {
    const parsed = metricSampleSchema.parse({
      ts: "2026-07-13T10:00:00Z",
      cpuPct: 10,
      load1m: 0.1,
      memUsedBytes: 1,
      memTotalBytes: 2,
      swapUsedBytes: 0,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      netRxBytes: 0,
      netTxBytes: 0,
    });
    expect(parsed.disks).toEqual([]);
    expect(parsed.services).toEqual([]);
  });

  it("rifiuta cpuPct sopra 100", () => {
    expect(() => metricSampleSchema.parse({ ...validSample, cpuPct: 101 })).toThrow();
  });

  it("rifiuta cpuPct sotto 0", () => {
    expect(() => metricSampleSchema.parse({ ...validSample, cpuPct: -1 })).toThrow();
  });

  it("rifiuta memTotalBytes = 0", () => {
    expect(() => metricSampleSchema.parse({ ...validSample, memTotalBytes: 0 })).toThrow();
  });

  it("rifiuta un ts non ISO", () => {
    expect(() => metricSampleSchema.parse({ ...validSample, ts: "not-a-date" })).toThrow();
  });

  it("rifiuta un ts con offset di fuso orario (contratto: solo UTC Z)", () => {
    expect(() =>
      metricSampleSchema.parse({ ...validSample, ts: "2026-07-13T12:00:00+02:00" }),
    ).toThrow();
  });

  it("rifiuta un mount vuoto nei disks", () => {
    expect(() =>
      metricSampleSchema.parse({
        ...validSample,
        disks: [{ mount: "", usedBytes: 1, totalBytes: 2 }],
      }),
    ).toThrow();
  });
});

describe("discoveredServiceSchema", () => {
  it("accetta un servizio con campi PM2 valorizzati", () => {
    const parsed = discoveredServiceSchema.parse({
      source: "pm2",
      name: "api",
      state: "online",
      cpuPct: 1.5,
      memBytes: 50_000_000,
      restarts: 3,
    });
    expect(parsed).toMatchObject({ source: "pm2", restarts: 3 });
  });

  it("rifiuta una source sconosciuta", () => {
    expect(() =>
      discoveredServiceSchema.parse({
        source: "systemd",
        name: "api",
        state: "running",
        cpuPct: null,
        memBytes: null,
        restarts: null,
      }),
    ).toThrow();
  });
});

describe("checkResultSchema", () => {
  it("accetta un risultato con metrics null", () => {
    const parsed = checkResultSchema.parse({ ...validCheckResult, metrics: null });
    expect(parsed.metrics).toBeNull();
  });

  it("rifiuta uno status sconosciuto", () => {
    expect(() => checkResultSchema.parse({ ...validCheckResult, status: "flapping" })).toThrow();
  });

  it("rifiuta un checkId non uuid", () => {
    expect(() => checkResultSchema.parse({ ...validCheckResult, checkId: "abc" })).toThrow();
  });

  it("rifiuta una chiave di metrics oltre 100 caratteri", () => {
    expect(() =>
      checkResultSchema.parse({ ...validCheckResult, metrics: { ["k".repeat(101)]: 1 } }),
    ).toThrow();
  });
});

describe("agentConfigSchema", () => {
  it("accetta una config completa", () => {
    const parsed = agentConfigSchema.parse({
      sampleIntervalSeconds: 30,
      checks: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "http",
          name: "homepage",
          target: "https://example.com",
          intervalSeconds: 60,
        },
      ],
    });
    expect(parsed.checks).toHaveLength(1);
  });

  it("rifiuta un tipo di check sconosciuto", () => {
    expect(() =>
      agentConfigSchema.parse({
        sampleIntervalSeconds: 30,
        checks: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            type: "grpc",
            name: "x",
            target: "y",
            intervalSeconds: 60,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("alertThresholdsSchema", () => {
  it("applica i default quando l'oggetto è vuoto", () => {
    const parsed = alertThresholdsSchema.parse({});
    expect(parsed).toEqual({
      cpuPct: 95,
      memPct: 90,
      diskPct: 90,
      sustainedMinutes: 5,
    });
  });

  it("accetta soglie null (disattivate)", () => {
    const parsed = alertThresholdsSchema.parse({ cpuPct: null });
    expect(parsed.cpuPct).toBeNull();
  });
});

describe("createServerSchema / updateServerSchema", () => {
  it("createServerSchema richiede solo il nome", () => {
    expect(createServerSchema.parse({ name: "vps-01" })).toEqual({ name: "vps-01" });
  });

  it("createServerSchema rifiuta un nome vuoto", () => {
    expect(() => createServerSchema.parse({ name: "" })).toThrow();
  });

  it("updateServerSchema è una patch parziale", () => {
    const parsed = updateServerSchema.parse({
      sampleIntervalSeconds: 60,
      projectIds: ["33333333-3333-4333-8333-333333333333"],
    });
    expect(parsed.sampleIntervalSeconds).toBe(60);
    expect(parsed.projectIds).toHaveLength(1);
  });

  it("updateServerSchema accetta un oggetto vuoto", () => {
    expect(updateServerSchema.parse({})).toEqual({});
  });

  it("alertThresholds è full-replacement: i campi omessi tornano ai default", () => {
    const parsed = updateServerSchema.parse({ alertThresholds: { cpuPct: 80 } });
    expect(parsed.alertThresholds).toEqual({
      cpuPct: 80,
      memPct: 90,
      diskPct: 90,
      sustainedMinutes: 5,
    });
  });
});

describe("createCheckSchema / updateCheckSchema", () => {
  it("createCheckSchema accetta un check completo", () => {
    const parsed = createCheckSchema.parse({
      type: "postgres",
      name: "db primaria",
      target: "postgres://user:pass@host:5432/db",
      intervalSeconds: 30,
      enabled: true,
    });
    expect(parsed).toMatchObject({ type: "postgres", enabled: true });
  });

  it("createCheckSchema rifiuta un intervallo troppo corto", () => {
    expect(() =>
      createCheckSchema.parse({
        type: "http",
        name: "x",
        target: "https://example.com",
        intervalSeconds: 5,
        enabled: true,
      }),
    ).toThrow();
  });

  it("updateCheckSchema è una patch parziale", () => {
    expect(updateCheckSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
