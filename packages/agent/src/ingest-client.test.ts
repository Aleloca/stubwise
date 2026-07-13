import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { CheckResult, MetricSample } from "@stubwise/shared";

import { IngestClient, type Logger } from "./ingest-client.js";

// A logger that swallows everything so the test output stays clean.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeSample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    ts: "2026-07-13T10:00:00.000Z",
    cpuPct: 12.5,
    load1m: 0.4,
    memUsedBytes: 1_000_000,
    memTotalBytes: 8_000_000,
    swapUsedBytes: 0,
    diskUsedBytes: 5_000_000,
    diskTotalBytes: 20_000_000,
    disks: [],
    netRxBytes: 100,
    netTxBytes: 200,
    services: [],
    ...overrides,
  };
}

const UUID = "11111111-1111-4111-8111-111111111111";

function makeCheckResult(): CheckResult {
  return {
    checkId: UUID,
    ts: "2026-07-13T10:00:00.000Z",
    status: "up",
    latencyMs: 5,
    error: null,
    metrics: null,
  };
}

interface CapturedRequest {
  method: string;
  url: string;
  key: string | undefined;
  body: unknown;
}

interface TestServer {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Set the status code the next (and subsequent) ingest POSTs respond with. */
  ingestStatus: number;
  /** Body returned by GET /monitor/config. */
  configBody: unknown;
  configStatus: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function startTestServer(): Promise<TestServer> {
  const state = {
    ingestStatus: 200,
    configStatus: 200,
    configBody: { sampleIntervalSeconds: 30, checks: [] } as unknown,
  };
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const key = req.headers["x-stubwise-server-key"];
      const body = await readBody(req);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        key: Array.isArray(key) ? key[0] : key,
        body,
      });
      if (req.url === "/monitor/config") {
        res.writeHead(state.configStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(state.configBody));
        return;
      }
      if (req.url === "/monitor/ingest") {
        res.writeHead(state.ingestStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: 0, checkResultsAccepted: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    get ingestStatus() {
      return state.ingestStatus;
    },
    set ingestStatus(v: number) {
      state.ingestStatus = v;
    },
    get configStatus() {
      return state.configStatus;
    },
    set configStatus(v: number) {
      state.configStatus = v;
    },
    get configBody() {
      return state.configBody;
    },
    set configBody(v: unknown) {
      state.configBody = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let server: TestServer;
afterEach(async () => {
  await server.close();
});

function makeClient(overrides: Partial<ConstructorParameters<typeof IngestClient>[0]> = {}) {
  return new IngestClient({
    baseUrl: server.baseUrl,
    serverKey: "test-key",
    hostname: "host-1",
    agentVersion: "test",
    log: silentLogger,
    ...overrides,
  });
}

describe("IngestClient.sendBatch", () => {
  it("posts a batch with the auth header and returns ok", async () => {
    server = await startTestServer();
    const client = makeClient();
    const result = await client.sendBatch([makeSample()], [makeCheckResult()]);
    expect(result).toEqual({ ok: true, discard: false });

    const ingest = server.requests.filter((r) => r.url === "/monitor/ingest");
    expect(ingest).toHaveLength(1);
    expect(ingest[0]?.method).toBe("POST");
    expect(ingest[0]?.key).toBe("test-key");
    const body = ingest[0]?.body as { hostname: string; samples: unknown[] };
    expect(body.hostname).toBe("host-1");
    expect(body.samples).toHaveLength(1);
  });

  it("returns a transient failure on 500 (retry, no discard)", async () => {
    server = await startTestServer();
    server.ingestStatus = 500;
    const client = makeClient();
    const result = await client.sendBatch([makeSample()], []);
    expect(result).toEqual({ ok: false, discard: false });
  });

  it("returns discard on 422", async () => {
    server = await startTestServer();
    server.ingestStatus = 422;
    const client = makeClient();
    const result = await client.sendBatch([makeSample()], []);
    expect(result).toEqual({ ok: false, discard: true });
  });

  it("returns a transient failure on 401 (retry, no discard)", async () => {
    server = await startTestServer();
    server.ingestStatus = 401;
    const client = makeClient();
    const result = await client.sendBatch([makeSample()], []);
    expect(result).toEqual({ ok: false, discard: false });
  });

  it("splits more than 300 samples into multiple requests", async () => {
    server = await startTestServer();
    const client = makeClient();
    const samples = Array.from({ length: 301 }, () => makeSample());
    const result = await client.sendBatch(samples, []);
    expect(result).toEqual({ ok: true, discard: false });

    const ingest = server.requests.filter((r) => r.url === "/monitor/ingest");
    expect(ingest).toHaveLength(2);
    const counts = ingest.map((r) => (r.body as { samples: unknown[] }).samples.length);
    expect(counts).toEqual([300, 1]);
  });

  it("is a no-op with no samples and no check results", async () => {
    server = await startTestServer();
    const client = makeClient();
    const result = await client.sendBatch([], []);
    expect(result).toEqual({ ok: true, discard: false });
    expect(server.requests).toHaveLength(0);
  });

  it("keeps check results buffered when there is no sample to attach", async () => {
    server = await startTestServer();
    const client = makeClient();
    const result = await client.sendBatch([], [makeCheckResult()]);
    expect(result).toEqual({ ok: false, discard: false });
    expect(server.requests).toHaveLength(0);
  });
});

describe("IngestClient.fetchConfig", () => {
  it("parses a valid config", async () => {
    server = await startTestServer();
    server.configBody = {
      sampleIntervalSeconds: 45,
      checks: [
        { id: UUID, type: "http", name: "web", target: "https://x", intervalSeconds: 60 },
      ],
    };
    const client = makeClient();
    const config = await client.fetchConfig();
    expect(config?.sampleIntervalSeconds).toBe(45);
    expect(config?.checks).toHaveLength(1);
    const configReq = server.requests.find((r) => r.url === "/monitor/config");
    expect(configReq?.key).toBe("test-key");
  });

  it("returns null on an invalid payload", async () => {
    server = await startTestServer();
    server.configBody = { sampleIntervalSeconds: 5, checks: "nope" };
    const client = makeClient();
    expect(await client.fetchConfig()).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    server = await startTestServer();
    server.configStatus = 500;
    const client = makeClient();
    expect(await client.fetchConfig()).toBeNull();
  });
});
