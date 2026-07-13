/**
 * HTTP client for the two public agent endpoints:
 *   GET  {baseUrl}/monitor/config  → the agent's config (sample interval + checks)
 *   POST {baseUrl}/monitor/ingest  → a batch of samples + check results
 * Both authenticate with the `x-stubwise-server-key` header.
 *
 * The client is deliberately tolerant: `fetchConfig` swallows every error and
 * returns null (the caller keeps the previous config); `sendBatch` reports its
 * outcome as `{ ok, discard }` so the main loop knows whether to retry (restore
 * the batch to the buffer) or drop it (a permanent 422 must never re-accumulate).
 */
import type { AgentConfig, CheckResult, MetricSample } from "@stubwise/shared";
import { agentConfigSchema } from "@stubwise/shared";

/** Ingest contract caps: at most 300 samples and 2000 check results per request. */
const MAX_SAMPLES_PER_REQUEST = 300;
const MAX_CHECK_RESULTS_PER_REQUEST = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Default logger: a thin wrapper over console with a `[agent]` prefix. */
export const consoleLogger: Logger = {
  info: (m, meta) => console.info(`[agent] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[agent] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[agent] ${m}`, meta ?? ""),
};

/**
 * Outcome of a `sendBatch` call.
 * - `ok`: every request in the (possibly split) batch returned 2xx.
 * - `discard`: the payload was permanently rejected (a 422 anywhere) — the caller
 *   must DROP it, not restore it, otherwise a structurally-invalid batch would be
 *   re-sent forever. When `ok` is false and `discard` is false the failure is
 *   transient (network / 5xx / 401) and the caller should restore & retry.
 */
export interface SendResult {
  ok: boolean;
  discard: boolean;
}

/** The surface the main loop depends on; `IngestClient` is the real impl. */
export interface IngestTransport {
  fetchConfig(): Promise<AgentConfig | null>;
  sendBatch(samples: MetricSample[], checkResults: CheckResult[]): Promise<SendResult>;
}

export interface IngestClientOptions {
  baseUrl: string;
  serverKey: string;
  hostname: string;
  agentVersion: string;
  /** Override for tests; defaults to the global (undici) fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  log?: Logger;
}

/** Per-request classification, aggregated into a `SendResult` for the batch. */
type RequestOutcome = "ok" | "retry" | "discard";

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class IngestClient implements IngestTransport {
  private readonly baseUrl: string;
  private readonly serverKey: string;
  private readonly hostname: string;
  private readonly agentVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(options: IngestClientOptions) {
    this.baseUrl = options.baseUrl;
    this.serverKey = options.serverKey;
    this.hostname = options.hostname;
    this.agentVersion = options.agentVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? consoleLogger;
  }

  async fetchConfig(): Promise<AgentConfig | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/monitor/config`, {
        method: "GET",
        headers: { "x-stubwise-server-key": this.serverKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status < 200 || res.status >= 300) {
        this.log.warn("config fetch returned non-2xx", { status: res.status });
        return null;
      }
      const json: unknown = await res.json();
      const parsed = agentConfigSchema.safeParse(json);
      if (!parsed.success) {
        this.log.warn("config fetch returned an invalid payload", {
          issues: parsed.error.issues.length,
        });
        return null;
      }
      return parsed.data;
    } catch (err) {
      // Network / DNS / timeout / bad JSON: keep the previous config.
      this.log.warn("config fetch failed", { error: errorMessage(err) });
      return null;
    }
  }

  async sendBatch(
    samples: MetricSample[],
    checkResults: CheckResult[],
  ): Promise<SendResult> {
    if (samples.length === 0) {
      // The ingest contract requires at least one sample per request. With no
      // samples there is nothing we can post: if we also have no check results
      // there is genuinely nothing to do (ok, nothing to restore); if we have
      // check results we report a (harmless) transient failure so the caller
      // keeps them buffered for a tick that produces a sample.
      if (checkResults.length === 0) return { ok: true, discard: false };
      return { ok: false, discard: false };
    }

    const sampleChunks = chunk(samples, MAX_SAMPLES_PER_REQUEST);
    const checkChunks = chunk(checkResults, MAX_CHECK_RESULTS_PER_REQUEST);

    // Pair chunks index-wise. Given the buffer caps (samples ≤ ~720, checks ≤
    // 2000) `sampleChunks` is always ≥ 1 and `checkChunks` ≤ 1, so every request
    // carries at least one sample. The extra loop folds any surplus check chunks
    // (only reachable if the caps ever change) onto the last request so nothing
    // is silently dropped.
    const requests: { samples: MetricSample[]; checkResults: CheckResult[] }[] = [];
    for (let i = 0; i < sampleChunks.length; i++) {
      requests.push({ samples: sampleChunks[i] ?? [], checkResults: checkChunks[i] ?? [] });
    }
    const last = requests[requests.length - 1];
    for (let i = sampleChunks.length; i < checkChunks.length; i++) {
      last?.checkResults.push(...(checkChunks[i] ?? []));
    }

    let anyDiscard = false;
    let allOk = true;
    for (const req of requests) {
      const outcome = await this.postOne(req.samples, req.checkResults);
      if (outcome !== "ok") allOk = false;
      if (outcome === "discard") anyDiscard = true;
    }

    // A 422 anywhere → discard the whole batch (drop, don't retry). Otherwise a
    // transient failure → retry. All ok → success.
    if (allOk) return { ok: true, discard: false };
    if (anyDiscard) return { ok: false, discard: true };
    return { ok: false, discard: false };
  }

  private async postOne(
    samples: MetricSample[],
    checkResults: CheckResult[],
  ): Promise<RequestOutcome> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/monitor/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stubwise-server-key": this.serverKey,
        },
        body: JSON.stringify({
          hostname: this.hostname,
          agentVersion: this.agentVersion,
          samples,
          checkResults,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.status >= 200 && res.status < 300) return "ok";

      if (res.status === 422) {
        // Payload structurally rejected: drop it — retrying can only loop forever.
        this.log.error("ingest rejected (422) — dropping batch", {
          samples: samples.length,
          checkResults: checkResults.length,
        });
        return "discard";
      }
      if (res.status === 401) {
        // Wrong/rotated server key: restoring the batch is useless (it will keep
        // failing) but not harmful — we keep it and log distinctly so operators
        // see the auth problem rather than silently losing data.
        this.log.error("ingest unauthorized (401) — check STUBWISE_SERVER_KEY");
        return "retry";
      }
      // 5xx or other 4xx: treat as transient and retry.
      this.log.warn("ingest failed", { status: res.status });
      return "retry";
    } catch (err) {
      // Network / DNS / timeout: transient, retry.
      this.log.warn("ingest request errored", { error: errorMessage(err) });
      return "retry";
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
