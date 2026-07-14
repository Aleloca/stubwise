/**
 * The agent's main loop: sample host metrics on a timer, run each configured
 * check on its own interval, buffer everything, and push batches to the server.
 * All I/O is injected (collector, check runner, ingest client, timers) so the
 * loop is deterministic under vitest fake timers.
 */
import { readFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";

import type { AgentCheckConfig, AgentConfig, CheckResult, MetricSample } from "@stubwise/shared";
import { metricSampleSchema } from "@stubwise/shared";

import { RingBuffer } from "./buffer.js";
import { collectDisks } from "./collectors/disk.js";
import { collectDockerServices } from "./collectors/docker.js";
import { collectPm2Services } from "./collectors/pm2.js";
import { parseCpu, parseLoadavg, parseMeminfo, parseNetDev } from "./collectors/proc.js";
import { consoleLogger, type IngestTransport, type Logger } from "./ingest-client.js";

/** Metric buffer holds 2h of samples at the current rate. */
const BUFFER_WINDOW_SECONDS = 7200;
/** Check-result buffer cap (matches the ingest contract's per-request max). */
const CHECK_BUFFER_MAX = 2000;
/** Re-fetch the config every N sampling ticks. */
const CONFIG_REFRESH_EVERY_TICKS = 10;
/** Fallback sampling interval before the first config is known. */
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 30;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface LoopTimers {
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

// Resolve the global timers at CALL time (not capture time) so vitest's fake
// timers, installed after this module loads, take effect.
const defaultTimers: LoopTimers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

export interface AgentLoopDeps {
  /** Produce one host sample; returns null when no sample is available yet. */
  collectSample: () => Promise<MetricSample | null>;
  /** Run a single check and return its result. */
  runCheck: (config: AgentCheckConfig) => Promise<CheckResult>;
  /** Push samples + check results to the server. */
  client: IngestTransport;
  /** Prune per-check delta state for checks no longer active. */
  pruneCheckState: (activeIds: Set<string>) => void;
  log?: Logger;
}

export interface AgentLoopOptions {
  /** Config to start from (usually the first `fetchConfig`, or a default). */
  initialConfig: AgentConfig;
  /** Aborting stops the loop and runs a final best-effort flush. */
  signal?: AbortSignal;
  /**
   * Set when `initialConfig` is a fallback (the startup `fetchConfig` failed):
   * the loop then retries the config fetch on EVERY tick until one succeeds,
   * instead of waiting for the 10-tick refresh cadence.
   */
  configPending?: boolean;
  /** Injectable timers (tests). */
  timers?: LoopTimers;
}

export interface AgentLoopController {
  /** Stop all timers and run one final best-effort flush. Idempotent. */
  stop(): Promise<void>;
}

interface ScheduledCheck {
  config: AgentCheckConfig;
  /** Pending timer; undefined only in the instant between run start and reschedule. */
  handle: TimerHandle | undefined;
}

export function runAgentLoop(
  deps: AgentLoopDeps,
  opts: AgentLoopOptions,
): AgentLoopController {
  const log = deps.log ?? consoleLogger;
  const timers = opts.timers ?? defaultTimers;

  let running = true;
  let sampleIntervalSeconds = opts.initialConfig.sampleIntervalSeconds;
  let tickCount = 0;
  let configPending = opts.configPending ?? false;
  /** The currently-running sample tick, awaited by `stop()` before the final flush. */
  let inFlightTick: Promise<void> | null = null;

  const sampleBuffer = new RingBuffer<MetricSample>(
    Math.ceil(BUFFER_WINDOW_SECONDS / sampleIntervalSeconds),
  );
  const checkBuffer = new RingBuffer<CheckResult>(CHECK_BUFFER_MAX);

  let sampleTimer: TimerHandle | undefined;
  const scheduledChecks = new Map<string, ScheduledCheck>();

  // ---- sending -----------------------------------------------------------

  async function flush(): Promise<void> {
    const samples = sampleBuffer.takeAll();
    const checkResults = checkBuffer.takeAll();
    if (samples.length === 0 && checkResults.length === 0) return;
    try {
      const result = await deps.client.sendBatch(samples, checkResults);
      if (!result.ok && !result.discard) {
        // Transient failure: put the batch back for the next tick.
        sampleBuffer.restore(samples);
        checkBuffer.restore(checkResults);
      }
      // result.ok → accepted; result.discard → permanently rejected, drop it.
    } catch (err) {
      // sendBatch should never throw, but if it does, treat as transient.
      sampleBuffer.restore(samples);
      checkBuffer.restore(checkResults);
      log.warn("flush errored", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- config refresh ----------------------------------------------------

  async function refreshConfig(): Promise<void> {
    const config = await deps.client.fetchConfig();
    if (!config) return; // keep the previous config
    configPending = false; // a real config arrived; back to the 10-tick cadence

    if (config.sampleIntervalSeconds !== sampleIntervalSeconds) {
      sampleIntervalSeconds = config.sampleIntervalSeconds;
      sampleBuffer.setMaxItems(Math.ceil(BUFFER_WINDOW_SECONDS / sampleIntervalSeconds));
    }
    applyChecks(config.checks);
    // Prune delta state (tps/qps) for checks that were removed.
    deps.pruneCheckState(new Set(config.checks.map((c) => c.id)));
  }

  // ---- check scheduler ---------------------------------------------------

  function scheduleCheck(config: AgentCheckConfig): void {
    // The scheduling chain is bound to THIS entry object. A config refresh that
    // changes the interval replaces the map entry with a new one (with its own
    // timer chain); if that happens while a run of the OLD chain is in flight,
    // the old chain must die instead of rescheduling — otherwise both chains
    // would keep firing forever. The identity checks below enforce that.
    const entry: ScheduledCheck = { config, handle: undefined };
    const runAndReschedule = () => {
      void (async () => {
        if (!running || scheduledChecks.get(config.id) !== entry) return;
        entry.handle = undefined; // the timer that got us here has fired
        try {
          const result = await deps.runCheck(entry.config);
          checkBuffer.push(result);
        } catch (err) {
          // runCheck is contracted never to throw; guard anyway.
          log.warn("check runner errored", {
            checkId: config.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Re-verify identity AFTER the await: the entry may have been replaced
        // (interval change) or removed while the check was running.
        if (!running || scheduledChecks.get(config.id) !== entry) return;
        // Reschedule from completion so runs never overlap.
        entry.handle = timers.setTimeout(
          runAndReschedule,
          entry.config.intervalSeconds * 1000,
        );
      })();
    };
    entry.handle = timers.setTimeout(runAndReschedule, config.intervalSeconds * 1000);
    scheduledChecks.set(config.id, entry);
  }

  function applyChecks(checks: AgentCheckConfig[]): void {
    const next = new Map(checks.map((c) => [c.id, c]));
    // Remove checks no longer present.
    for (const [id, entry] of [...scheduledChecks]) {
      if (!next.has(id)) {
        if (entry.handle !== undefined) timers.clearTimeout(entry.handle);
        scheduledChecks.delete(id);
      }
    }
    // Add new checks; update or reschedule existing ones.
    for (const config of checks) {
      const existing = scheduledChecks.get(config.id);
      if (!existing) {
        scheduleCheck(config);
      } else if (existing.config.intervalSeconds !== config.intervalSeconds) {
        // Interval changed → reschedule with the new cadence. If a run of the
        // old chain is in flight, its identity check kills it on completion.
        if (existing.handle !== undefined) timers.clearTimeout(existing.handle);
        scheduledChecks.delete(config.id);
        scheduleCheck(config);
      } else {
        // Same cadence → update target/name in place; the runner reads it next run.
        existing.config = config;
      }
    }
  }

  // ---- sampling loop -----------------------------------------------------

  function scheduleSample(delayMs: number): void {
    sampleTimer = timers.setTimeout(() => {
      void (async () => {
        if (!running) return;
        const startedAt = Date.now();
        inFlightTick = sampleTick();
        try {
          await inFlightTick;
        } finally {
          inFlightTick = null;
        }
        if (!running) return;
        // Drift compensation: subtract the tick's own duration from the next
        // delay so the sampling CADENCE stays at one sample per interval even
        // when a tick is slow (e.g. ingest timing out during a server outage).
        // Without this, a 10s-slow tick on a 30s interval would thin the sample
        // density by a third. Ticks still never overlap (schedule-after-await).
        const elapsedMs = Date.now() - startedAt;
        scheduleSample(Math.max(0, sampleIntervalSeconds * 1000 - elapsedMs));
      })();
    }, delayMs);
  }

  async function sampleTick(): Promise<void> {
    const sample = await deps.collectSample();
    if (sample) {
      const parsed = metricSampleSchema.safeParse(sample);
      if (parsed.success) {
        sampleBuffer.push(parsed.data);
      } else {
        // A sample that fails the contract (e.g. memTotalBytes 0 from an
        // unreadable meminfo) is dropped, never sent.
        log.warn("dropping invalid sample", {
          firstIssue: parsed.error.issues[0]?.path.join("."),
          issues: parsed.error.issues.length,
        });
      }
    }

    await flush();

    tickCount += 1;
    // `configPending` (initial fetch failed at startup) anticipates the refresh
    // to every tick until a config is obtained, instead of waiting 10 ticks.
    if (configPending || tickCount % CONFIG_REFRESH_EVERY_TICKS === 0) {
      await refreshConfig();
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    if (sampleTimer !== undefined) timers.clearTimeout(sampleTimer);
    for (const entry of scheduledChecks.values()) {
      if (entry.handle !== undefined) timers.clearTimeout(entry.handle);
    }
    scheduledChecks.clear();
    // Wait for a tick that is mid-flight so its sample/flush lands in the
    // buffers first — otherwise the "final" flush below could miss it.
    if (inFlightTick) await inFlightTick.catch(() => {});
    // Final best-effort flush of whatever is still buffered.
    try {
      await flush();
    } catch {
      /* ignore shutdown flush errors */
    }
  }

  // Kick everything off.
  applyChecks(opts.initialConfig.checks);
  scheduleSample(sampleIntervalSeconds * 1000);

  if (opts.signal) {
    if (opts.signal.aborted) void stop();
    else opts.signal.addEventListener("abort", () => void stop(), { once: true });
  }

  return { stop };
}

// ---------------------------------------------------------------------------
// Real `collectSample` composed from the parsers + collectors.
// ---------------------------------------------------------------------------

export interface CollectSampleOptions {
  /** Host root mount (e.g. "/host"): `${hostRoot}/proc`, `${hostRoot}/root`. */
  hostRoot: string;
  /** Docker Engine Unix socket path. */
  dockerSocket: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  log?: Logger;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the real `collectSample`. It holds the previous `/proc/stat` and
 * `/proc/net/dev` readings between calls: CPU% and network deltas need two
 * readings an interval apart, so the FIRST call only records a baseline and
 * returns null (no sample). From the second call on it emits a full sample.
 */
export function makeCollectSample(
  opts: CollectSampleOptions,
): () => Promise<MetricSample | null> {
  const procRoot = `${opts.hostRoot}/proc`;
  const rootPath = `${opts.hostRoot}/root`;
  const procMountsPath = `${procRoot}/mounts`;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? consoleLogger;

  let prev: { stat: string; netdev: string } | null = null;

  return async () => {
    const statNow = await readText(`${procRoot}/stat`);
    const netNow = await readText(`${procRoot}/net/dev`);

    if (!prev) {
      // First tick: baseline only. Need a second reading to derive deltas.
      if (statNow !== null && netNow !== null) prev = { stat: statNow, netdev: netNow };
      return null;
    }

    const cpuPct = statNow !== null ? parseCpu(prev.stat, statNow) : 0;
    const net = netNow !== null ? parseNetDev(prev.netdev, netNow) : { rxBytes: 0, txBytes: 0 };
    if (statNow !== null) prev.stat = statNow;
    if (netNow !== null) prev.netdev = netNow;

    const memText = await readText(`${procRoot}/meminfo`);
    const mem = memText !== null
      ? parseMeminfo(memText)
      : { memUsedBytes: 0, memTotalBytes: 0, swapUsedBytes: 0 };
    const loadText = await readText(`${procRoot}/loadavg`);
    const load1m = loadText !== null ? parseLoadavg(loadText) : 0;

    const disks = await collectDisks({ rootPath, procMountsPath });
    const [docker, pm2] = await Promise.all([
      collectDockerServices({ socketPath: opts.dockerSocket }).catch((err) => {
        log.warn("docker collection failed", { error: err instanceof Error ? err.message : String(err) });
        return [];
      }),
      collectPm2Services({ procRoot }).catch((err) => {
        log.warn("pm2 collection failed", { error: err instanceof Error ? err.message : String(err) });
        return [];
      }),
    ]);

    // Primary filesystem: the "/" mount reported by collectDisks (statfs on root).
    const primary = disks.find((d) => d.mount === "/") ?? disks[0];

    return {
      ts: now().toISOString(),
      cpuPct,
      load1m,
      memUsedBytes: mem.memUsedBytes,
      memTotalBytes: mem.memTotalBytes,
      swapUsedBytes: mem.swapUsedBytes,
      diskUsedBytes: primary?.usedBytes ?? 0,
      diskTotalBytes: primary?.totalBytes ?? 1,
      disks: disks.slice(0, 20).map((d) => ({
        mount: d.mount,
        usedBytes: d.usedBytes,
        totalBytes: d.totalBytes,
      })),
      netRxBytes: net.rxBytes,
      netTxBytes: net.txBytes,
      services: [...docker, ...pm2].slice(0, 200),
    };
  };
}

/**
 * The host's hostname. NB: `/proc/sys/kernel/hostname` is UTS-namespaced — the
 * kernel resolves it against the READER's UTS namespace, so from inside a
 * container it returns the container id even when the host `/proc` is mounted.
 * We instead read the host's real `/etc/hostname` (a plain file on the mounted
 * root `/`, NOT namespaced), falling back to `os.hostname()` if absent/empty.
 */
export async function resolveHostname(hostRoot: string): Promise<string> {
  const fromHost = await readText(`${hostRoot}/root/etc/hostname`);
  const trimmed = fromHost?.trim();
  if (trimmed) return trimmed.slice(0, 255);
  return osHostname().slice(0, 255) || "unknown-host";
}

export { DEFAULT_SAMPLE_INTERVAL_SECONDS };
