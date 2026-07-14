import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCheckConfig, AgentConfig, CheckResult, MetricSample } from "@stubwise/shared";

import type { IngestTransport, SendResult } from "./ingest-client.js";
import { runAgentLoop, resolveHostname } from "./main.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("resolveHostname", () => {
  let hostRoot: string;

  beforeEach(async () => {
    hostRoot = await mkdtemp(join(tmpdir(), "agent-host-"));
  });
  afterEach(async () => {
    await rm(hostRoot, { recursive: true, force: true });
  });

  it("legge l'hostname reale dell'host da /root/etc/hostname (non namespaced)", async () => {
    await mkdir(join(hostRoot, "root", "etc"), { recursive: true });
    // /etc/hostname ha tipicamente un newline finale: va trimmato.
    await writeFile(join(hostRoot, "root", "etc", "hostname"), "wilco-dashboard\n");
    expect(await resolveHostname(hostRoot)).toBe("wilco-dashboard");
  });

  it("torna a os.hostname() se /root/etc/hostname è assente o vuoto", async () => {
    // File assente → fallback.
    expect(await resolveHostname(hostRoot)).toBe(osHostname());
    // File vuoto (solo whitespace) → fallback.
    await mkdir(join(hostRoot, "root", "etc"), { recursive: true });
    await writeFile(join(hostRoot, "root", "etc", "hostname"), "  \n");
    expect(await resolveHostname(hostRoot)).toBe(osHostname());
  });
});

function validSample(ts = "2026-07-13T10:00:00.000Z"): MetricSample {
  return {
    ts,
    cpuPct: 10,
    load1m: 0.5,
    memUsedBytes: 1_000,
    memTotalBytes: 8_000,
    swapUsedBytes: 0,
    diskUsedBytes: 500,
    diskTotalBytes: 2_000,
    disks: [],
    netRxBytes: 1,
    netTxBytes: 2,
    services: [],
  };
}

function invalidSample(): MetricSample {
  // memTotalBytes 0 violates the schema (min 1) → must be dropped.
  return { ...validSample(), memTotalBytes: 0 };
}

function checkResult(checkId: string): CheckResult {
  return {
    checkId,
    ts: "2026-07-13T10:00:00.000Z",
    status: "up",
    latencyMs: 1,
    error: null,
    metrics: null,
  };
}

const CHECK_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CHECK_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function check(id: string, intervalSeconds: number): AgentCheckConfig {
  return { id, type: "tcp", name: id, target: "127.0.0.1:80", intervalSeconds };
}

interface FakeClient extends IngestTransport {
  calls: { samples: MetricSample[]; checkResults: CheckResult[] }[];
  sendResult: SendResult;
  fetchConfigResult: AgentConfig | null;
  fetchConfigCalls: number;
}

function makeFakeClient(): FakeClient {
  return {
    calls: [],
    sendResult: { ok: true, discard: false },
    fetchConfigResult: null,
    fetchConfigCalls: 0,
    async sendBatch(samples, checkResults) {
      this.calls.push({ samples, checkResults });
      return this.sendResult;
    },
    async fetchConfig() {
      this.fetchConfigCalls += 1;
      return this.fetchConfigResult;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runAgentLoop", () => {
  it("samples, buffers and sends on each tick", async () => {
    const client = makeFakeClient();
    const collectSample = vi.fn(async () => validSample());
    const controller = runAgentLoop(
      { collectSample, runCheck: vi.fn(), client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] } },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(collectSample).toHaveBeenCalledTimes(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.samples).toHaveLength(1);

    await controller.stop();
  });

  it("grows the buffer while the server is down and sends everything on recovery", async () => {
    const client = makeFakeClient();
    client.sendResult = { ok: false, discard: false }; // server down
    const collectSample = vi.fn(async () => validSample());
    const controller = runAgentLoop(
      { collectSample, runCheck: vi.fn(), client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] } },
    );

    await vi.advanceTimersByTimeAsync(30_000); // tick 1: 1 buffered, send fails
    await vi.advanceTimersByTimeAsync(30_000); // tick 2: 2 buffered, send fails
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.samples).toHaveLength(2);

    client.sendResult = { ok: true, discard: false }; // recovery
    await vi.advanceTimersByTimeAsync(30_000); // tick 3: send all three
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]?.samples).toHaveLength(3);

    // Buffer drained: a further failing tick sends only the new sample.
    client.sendResult = { ok: false, discard: false };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.calls[3]?.samples).toHaveLength(1);

    await controller.stop();
  });

  it("drops a sample that fails the schema", async () => {
    const client = makeFakeClient();
    const collectSample = vi.fn(async () => invalidSample());
    const controller = runAgentLoop(
      { collectSample, runCheck: vi.fn(), client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] } },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    // Invalid sample dropped → nothing to send → no request.
    expect(client.calls).toHaveLength(0);

    await controller.stop();
  });

  it("runs each check on its own interval", async () => {
    const client = makeFakeClient();
    const runCheck = vi.fn(async (c: AgentCheckConfig) => checkResult(c.id));
    const controller = runAgentLoop(
      {
        collectSample: async () => null,
        runCheck,
        client,
        pruneCheckState: vi.fn(),
        log: silentLog,
      },
      {
        // Large sample interval so sampling doesn't interfere within the window.
        initialConfig: {
          sampleIntervalSeconds: 300,
          checks: [check(CHECK_A, 10), check(CHECK_B, 20)],
        },
      },
    );

    await vi.advanceTimersByTimeAsync(40_000);
    const idsRun = runCheck.mock.calls.map((call) => call[0].id);
    expect(idsRun.filter((id) => id === CHECK_A)).toHaveLength(4); // 10,20,30,40
    expect(idsRun.filter((id) => id === CHECK_B)).toHaveLength(2); // 20,40

    await controller.stop();
  });

  it("refreshes config every 10 ticks, applying the new interval and pruning state", async () => {
    const client = makeFakeClient();
    client.fetchConfigResult = { sampleIntervalSeconds: 60, checks: [] }; // A removed
    const runCheck = vi.fn(async (c: AgentCheckConfig) => checkResult(c.id));
    const pruneCheckState = vi.fn();
    const controller = runAgentLoop(
      { collectSample: async () => validSample(), runCheck, client, pruneCheckState, log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 10, checks: [check(CHECK_A, 10)] } },
    );

    await vi.advanceTimersByTimeAsync(100_000); // 10 sample ticks
    expect(client.fetchConfigCalls).toBe(1);
    expect(pruneCheckState).toHaveBeenCalledTimes(1);
    expect([...(pruneCheckState.mock.calls[0]?.[0] as Set<string>)]).toEqual([]);

    // Check A was removed by the refresh → it stops running.
    const runsBefore = runCheck.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(runCheck.mock.calls.length).toBe(runsBefore);

    await controller.stop();
  });

  it("flushes on shutdown and stops the timers", async () => {
    const client = makeFakeClient();
    client.sendResult = { ok: false, discard: false }; // accumulate
    const collectSample = vi.fn(async () => validSample());
    const controller = runAgentLoop(
      { collectSample, runCheck: vi.fn(), client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] } },
    );

    await vi.advanceTimersByTimeAsync(60_000); // 2 ticks buffered
    expect(client.calls).toHaveLength(2);

    await controller.stop(); // final flush
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]?.samples).toHaveLength(2);

    // Timers stopped: advancing does not collect again.
    const collectsAfterStop = collectSample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(collectSample.mock.calls.length).toBe(collectsAfterStop);
  });

  it("stops via an AbortSignal", async () => {
    const client = makeFakeClient();
    const collectSample = vi.fn(async () => validSample());
    const abort = new AbortController();
    runAgentLoop(
      { collectSample, runCheck: vi.fn(), client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] }, signal: abort.signal },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const collectsBefore = collectSample.mock.calls.length;
    abort.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(collectSample.mock.calls.length).toBe(collectsBefore);
  });

  it("does not duplicate a check's schedule when its interval changes mid-run", async () => {
    // Regression for the scheduler race: check A's interval changes (10s → 30s)
    // via a config refresh WHILE a run of A is still in flight. The old chain
    // must die on completion; with the bug, both chains kept firing forever.
    const client = makeFakeClient();
    // The refresh (anticipated to tick 1 by configPending) delivers interval 30.
    client.fetchConfigResult = { sampleIntervalSeconds: 12, checks: [check(CHECK_A, 30)] };
    const runCheck = vi.fn(async (c: AgentCheckConfig) => {
      // Each run takes 5s (faked timer), so the t=12s refresh lands inside the
      // t=10..15s run of the old 10s chain.
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      return checkResult(c.id);
    });
    const controller = runAgentLoop(
      {
        collectSample: async () => null,
        runCheck,
        client,
        pruneCheckState: vi.fn(),
        log: silentLog,
      },
      {
        initialConfig: { sampleIntervalSeconds: 12, checks: [check(CHECK_A, 10)] },
        configPending: true,
      },
    );

    // Timeline: run 1 at t=10 (old chain, completes 15, must NOT reschedule);
    // new 30s chain runs at t=42 (completes 47) and t=77 (completes 82).
    // With the duplication bug the dead chain would add runs at t=45, t=80, ...
    await vi.advanceTimersByTimeAsync(100_000);
    expect(runCheck).toHaveBeenCalledTimes(3);

    await controller.stop();
  });

  it("keeps the current config when fetchConfig returns null", async () => {
    const client = makeFakeClient();
    client.fetchConfigResult = null;
    const collectSample = vi.fn(async () => validSample());
    const runCheck = vi.fn(async (c: AgentCheckConfig) => checkResult(c.id));
    const controller = runAgentLoop(
      { collectSample, runCheck, client, pruneCheckState: vi.fn(), log: silentLog },
      { initialConfig: { sampleIntervalSeconds: 10, checks: [check(CHECK_A, 10)] } },
    );

    await vi.advanceTimersByTimeAsync(100_000); // 10 ticks → one (failed) refresh
    expect(client.fetchConfigCalls).toBe(1);
    // Cadence unchanged: sampling still every 10s, check A still scheduled.
    expect(collectSample).toHaveBeenCalledTimes(10);
    const checkRunsAt100 = runCheck.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collectSample).toHaveBeenCalledTimes(11);
    expect(runCheck.mock.calls.length).toBeGreaterThan(checkRunsAt100);

    await controller.stop();
  });

  it("restores the batch when sendBatch throws", async () => {
    let shouldThrow = true;
    const calls: { samples: MetricSample[] }[] = [];
    const client: IngestTransport = {
      async sendBatch(samples) {
        calls.push({ samples });
        if (shouldThrow) throw new Error("boom");
        return { ok: true, discard: false };
      },
      async fetchConfig() {
        return null;
      },
    };
    const controller = runAgentLoop(
      {
        collectSample: async () => validSample(),
        runCheck: vi.fn(),
        client,
        pruneCheckState: vi.fn(),
        log: silentLog,
      },
      { initialConfig: { sampleIntervalSeconds: 30, checks: [] } },
    );

    await vi.advanceTimersByTimeAsync(30_000); // tick 1: send throws → restored
    expect(calls).toHaveLength(1);
    shouldThrow = false;
    await vi.advanceTimersByTimeAsync(30_000); // tick 2: both samples sent
    expect(calls).toHaveLength(2);
    expect(calls[1]?.samples).toHaveLength(2);

    await controller.stop();
  });
});
