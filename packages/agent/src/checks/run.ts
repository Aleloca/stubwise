/**
 * Executors for the explicit checks configured from the UI: `http`, `tcp`,
 * `process`, `postgres`, `mysql`. Each executor turns one `AgentCheckConfig`
 * into a `CheckResult`.
 *
 * Hard invariant: `runCheck` NEVER throws. Any failure (network, DNS, auth,
 * timeout, a malformed target, an unknown type) becomes `status: "down"` with a
 * short `error` string. Latency is measured with `performance.now()` around the
 * actual I/O.
 *
 * The DB executors report a `tps`/`qps` value derived from the DELTA of a
 * monotonic counter between two consecutive runs of the same check. That per-
 * check state lives in a module-level Map (`deltaState`), keyed by checkId; it
 * is resettable via `resetCheckState()` for deterministic tests.
 */

import { readdir, readFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { AgentCheckConfig, CheckResult } from "@stubwise/shared";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROC_ROOT = "/host/proc";
/** `error` is capped at 500 chars by `checkResultSchema`. */
const MAX_ERROR_LENGTH = 500;

export interface CheckContext {
  /** I/O timeout for the check; default 10s. */
  timeoutMs?: number;
  /** Proc filesystem root for `process` checks; default `/host/proc`. */
  procRoot?: string;
  /** Injectable clock (tests); default `() => new Date()`. */
  now?: () => Date;
}

/** Previous counter reading for a DB check, used to compute the per-second rate. */
interface DeltaSample {
  counter: number;
  /** Epoch millis of the reading (from the injected clock). */
  tsMs: number;
}

/** checkId → last counter reading. Module-global so it survives across runs. */
const deltaState = new Map<string, DeltaSample>();

/** Clear the per-check delta state. Exposed for tests. */
export function resetCheckState(): void {
  deltaState.clear();
}

/**
 * Drop delta entries for checks no longer in the config, so state for deleted
 * checks doesn't accumulate forever. The main loop (D4) calls this with the
 * active check ids on every config refresh.
 */
export function pruneCheckState(activeIds: Set<string>): void {
  for (const id of deltaState.keys()) {
    if (!activeIds.has(id)) deltaState.delete(id);
  }
}

/**
 * Deadline for the DB executors: the whole connect+query block is raced against
 * this so `runCheck` always settles within ~timeoutMs even when the server
 * accepts the connection and then stalls (the driver-level connect timeouts get
 * headroom so THIS deadline is the authoritative one → deterministic "timeout").
 */
class DeadlineError extends Error {
  constructor() {
    super("timeout");
    this.name = "DeadlineError";
  }
}

function deadline(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Truncate to the schema's `error` cap and never return an empty string. */
function truncateError(message: string): string {
  const trimmed = message.length > 0 ? message : "unknown_error";
  return trimmed.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Redact the target (which for DB checks is a DSN carrying credentials) from an
 * error message before it leaves the agent. Driver errors sometimes echo the
 * connection string, so we blank any literal occurrence of it.
 */
function sanitizeError(message: string, target: string): string {
  const redacted =
    target.length > 0 ? message.split(target).join("[redacted]") : message;
  return truncateError(redacted);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function down(
  config: AgentCheckConfig,
  ts: string,
  latencyMs: number | null,
  error: string,
): CheckResult {
  return { checkId: config.id, ts, status: "down", latencyMs, error, metrics: null };
}

function up(
  config: AgentCheckConfig,
  ts: string,
  latencyMs: number,
  metrics: Record<string, number> | null,
): CheckResult {
  return {
    checkId: config.id,
    ts,
    status: "up",
    latencyMs: Math.max(0, Math.round(latencyMs)),
    error: null,
    metrics: metrics && Object.keys(metrics).length > 0 ? metrics : null,
  };
}

export async function runCheck(
  config: AgentCheckConfig,
  ctx: CheckContext,
): Promise<CheckResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = ctx.now ?? (() => new Date());
  const ts = now().toISOString();

  try {
    switch (config.type) {
      case "http":
        return await runHttp(config, ts, timeoutMs);
      case "tcp":
        return await runTcp(config, ts, timeoutMs);
      case "process":
        return await runProcess(config, ts, ctx.procRoot ?? DEFAULT_PROC_ROOT);
      case "postgres":
        return await runPostgres(config, ts, timeoutMs, now);
      case "mysql":
        return await runMysql(config, ts, timeoutMs, now);
      default:
        return down(config, ts, null, "unsupported_check_type");
    }
  } catch (err) {
    // Belt-and-suspenders: no executor should throw, but if one does we still
    // return a sanitized down result rather than propagating.
    return down(config, ts, null, sanitizeError(errorMessage(err), config.target));
  }
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

async function runHttp(
  config: AgentCheckConfig,
  ts: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    // Global (undici) fetch. `AbortSignal.timeout` aborts the whole request on
    // deadline. Redirects follow by default, which is what we want for a health
    // URL. We treat 2xx/3xx as up.
    const res = await fetch(config.target, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const latency = performance.now() - start;
    // Do NOT read the body — a health endpoint could return megabytes. Cancel
    // the stream so the socket can be released without buffering the payload.
    await res.body?.cancel().catch(() => {});

    if (res.status >= 200 && res.status < 400) return up(config, ts, latency, null);
    return down(config, ts, Math.round(latency), `http_${res.status}`);
  } catch (err) {
    // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError"
    // (undici) or "AbortError"; both mean we hit the deadline.
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return down(config, ts, null, "timeout");
    }
    // Network/DNS errors: fetch wraps the real cause (e.g. ECONNREFUSED) under
    // `.cause`, which carries the useful message. Sanitize against the target
    // too: an http URL can embed basic-auth credentials.
    const cause = (err as { cause?: unknown }).cause;
    const message = cause instanceof Error ? cause.message : errorMessage(err);
    return down(config, ts, null, sanitizeError(message, config.target));
  }
}

// ---------------------------------------------------------------------------
// tcp
// ---------------------------------------------------------------------------

/** Parse `host:port`, handling IPv6 bracket notation `[::1]:80`. */
function parseHostPort(target: string): { host: string; port: number } | null {
  let host: string;
  let portStr: string;
  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    if (end === -1) return null;
    host = target.slice(1, end);
    // Expect ":port" right after the closing bracket.
    if (target[end + 1] !== ":") return null;
    portStr = target.slice(end + 2);
  } else {
    // Split on the LAST colon so bare IPv6 without brackets still isn't split
    // mid-address (though bracket form is expected for IPv6).
    const idx = target.lastIndexOf(":");
    if (idx === -1) return null;
    host = target.slice(0, idx);
    portStr = target.slice(idx + 1);
  }
  // Digits only: rejects "", "80abc", "0x50", " 80" (Number() would coerce some).
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!host || port < 1 || port > 65_535) return null;
  return { host, port };
}

function runTcp(
  config: AgentCheckConfig,
  ts: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const parsed = parseHostPort(config.target);
  if (!parsed) return Promise.resolve(down(config, ts, null, "invalid_target"));

  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = netConnect({ host: parsed.host, port: parsed.port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(up(config, ts, performance.now() - start, null)));
    socket.once("timeout", () => finish(down(config, ts, null, "timeout")));
    socket.once("error", (err) => finish(down(config, ts, null, truncateError(err.message))));
  });
}

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `/proc/<pid>/cmdline` is NUL-separated argv; join with spaces. */
function cmdlineToString(raw: string): string {
  return raw.split("\0").filter((s) => s.length > 0).join(" ");
}

/** RSS in bytes from `/proc/<pid>/status` (VmRSS, kB → bytes). */
function parseVmRss(status: string): number | null {
  const match = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
  return match?.[1] ? Number(match[1]) * 1024 : null;
}

async function runProcess(
  config: AgentCheckConfig,
  ts: string,
  procRoot: string,
): Promise<CheckResult> {
  const start = performance.now();
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch (err) {
    return down(config, ts, null, truncateError(errorMessage(err)));
  }
  const pids = entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);

  // Best-effort self-exclusion: skip the agent's own pid so a `process` check
  // whose pattern happens to match the agent doesn't self-match. Note the agent
  // usually runs in its own PID namespace against the HOST proc, so `process.pid`
  // rarely collides — the guard is cheap insurance, not a guarantee.
  const selfPid = process.pid;

  for (const pid of pids) {
    if (pid === selfPid) continue;
    const cmdlineRaw = await readFileSafe(join(procRoot, String(pid), "cmdline"));
    if (!cmdlineRaw) continue;
    const cmdline = cmdlineToString(cmdlineRaw);
    if (!cmdline.includes(config.target)) continue;

    // First match wins. Report VmRSS as memBytes; cpuPct is intentionally
    // omitted (would need two /proc reads an interval apart — YAGNI, as in pm2).
    const status = await readFileSafe(join(procRoot, String(pid), "status"));
    const memBytes = status ? parseVmRss(status) : null;
    const metrics: Record<string, number> = {};
    if (memBytes !== null) metrics.memBytes = memBytes;
    return up(config, ts, performance.now() - start, metrics);
  }
  return down(config, ts, null, "no_process_match");
}

// ---------------------------------------------------------------------------
// Delta rate (tps / qps) shared by the DB executors
// ---------------------------------------------------------------------------

/**
 * Compute the per-second rate of a monotonic counter since this check's last
 * run and record the new reading. Returns `null` on the first run (nothing to
 * diff), on a counter reset (server restarted → negative delta), or on a non-
 * positive time delta. Exported (pure aside from the module Map) for tests.
 */
export function computeRate(checkId: string, counter: number, tsMs: number): number | null {
  const prev = deltaState.get(checkId);
  deltaState.set(checkId, { counter, tsMs });
  if (!prev) return null;
  const seconds = (tsMs - prev.tsMs) / 1000;
  const deltaCounter = counter - prev.counter;
  if (seconds <= 0 || deltaCounter < 0) return null;
  return Math.round((deltaCounter / seconds) * 100) / 100;
}

function toFiniteNumber(value: unknown): number | null {
  // Drivers return counters as strings or bigints; `Number` normalizes both.
  // Guard against `undefined`/non-numeric (→ NaN) which must be treated as absent.
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// postgres
// ---------------------------------------------------------------------------

async function runPostgres(
  config: AgentCheckConfig,
  ts: string,
  timeoutMs: number,
  now: () => Date,
): Promise<CheckResult> {
  // Dynamic import so the (heavy) driver is only loaded when a DB check runs.
  const { default: postgres } = await import("postgres");
  const start = performance.now();
  // connect_timeout gets +1s of headroom over our own deadline: the race below
  // is the single authoritative budget, so a stall (accepted connection that
  // never answers) yields a deterministic "timeout" instead of a driver message.
  const sql = postgres(config.target, {
    max: 1,
    connect_timeout: Math.ceil(timeoutMs / 1000) + 1,
    prepare: false,
    idle_timeout: 1,
    onnotice: () => {},
  });
  let timedOut = false;
  const dl = deadline(timeoutMs);
  try {
    // postgres-js connects lazily on the first query, so racing the query block
    // bounds connection AND queries: runCheck settles within ~timeoutMs even if
    // the server accepts the socket and then never replies. The losing branch's
    // eventual rejection is absorbed by Promise.race (a handler stays attached).
    const [statRows, sizeRows, maxRows] = await Promise.race([
      Promise.all([
        sql`select numbackends, xact_commit, blks_hit, blks_read from pg_stat_database where datname = current_database()`,
        sql`select pg_database_size(current_database()) as size`,
        sql`show max_connections`,
      ]),
      dl.promise,
    ]);
    const latency = performance.now() - start;

    const stat = statRows[0] ?? {};
    const metrics: Record<string, number> = {};

    const connections = toFiniteNumber(stat.numbackends);
    if (connections !== null) metrics.connections = connections;

    const maxConnections = toFiniteNumber(maxRows[0]?.max_connections);
    if (maxConnections !== null) metrics.maxConnections = maxConnections;

    const hit = toFiniteNumber(stat.blks_hit);
    const read = toFiniteNumber(stat.blks_read);
    if (hit !== null && read !== null && hit + read > 0) {
      // cacheHitRatio in [0,1], 2 decimals; omitted when there is no read/hit
      // activity yet (0/0 would be null-unsafe).
      metrics.cacheHitRatio = Math.round((hit / (hit + read)) * 100) / 100;
    }

    const dbSize = toFiniteNumber(sizeRows[0]?.size);
    if (dbSize !== null) metrics.dbSizeBytes = dbSize;

    const xact = toFiniteNumber(stat.xact_commit);
    if (xact !== null) {
      const tps = computeRate(config.id, xact, now().getTime());
      if (tps !== null) metrics.tps = tps;
    }

    return up(config, ts, latency, metrics);
  } catch (err) {
    if (err instanceof DeadlineError) {
      timedOut = true;
      return down(config, ts, null, "timeout");
    }
    return down(config, ts, null, sanitizeError(errorMessage(err), config.target));
  } finally {
    dl.cancel();
    // Always close the pool; never let a lingering connection leak. On timeout
    // force-destroy the sockets NOW (timeout: 0) — waiting for the stalled
    // query would blow the runCheck budget.
    try {
      await sql.end({ timeout: timedOut ? 0 : 5 });
    } catch {
      /* ignore close errors */
    }
  }
}

// ---------------------------------------------------------------------------
// mysql
// ---------------------------------------------------------------------------

async function runMysql(
  config: AgentCheckConfig,
  ts: string,
  timeoutMs: number,
  now: () => Date,
): Promise<CheckResult> {
  const mysql = await import("mysql2/promise");
  const start = performance.now();
  // Holder object (not a bare `let`): the connection is assigned inside the
  // raced closure, and TS's flow analysis would otherwise narrow a plain local
  // back to null in the finally below.
  const state: {
    conn: Awaited<ReturnType<typeof mysql.createConnection>> | null;
    timedOut: boolean;
  } = { conn: null, timedOut: false };
  const dl = deadline(timeoutMs);
  // Connect + queries as one block raced against the deadline, so runCheck
  // settles within ~timeoutMs even if the server accepts the socket and then
  // stalls mid-handshake or mid-query. connectTimeout gets +1s of headroom so
  // OUR deadline wins deterministically ("timeout", not "connect ETIMEDOUT").
  const queryBlock = async () => {
    const c = await mysql.createConnection({
      uri: config.target,
      connectTimeout: timeoutMs + 1000,
    });
    if (state.timedOut) {
      // The deadline fired while we were connecting: this late connection
      // would leak (the outer finally already ran) — kill it here.
      c.destroy();
      throw new DeadlineError();
    }
    state.conn = c;
    const [statusRows] = await c.query(
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Questions')",
    );
    const [sizeRows] = await c.query(
      "SELECT SUM(data_length + index_length) AS size FROM information_schema.tables",
    );
    const [maxRows] = await c.query("SHOW VARIABLES LIKE 'max_connections'");
    return { statusRows, sizeRows, maxRows };
  };
  try {
    // The losing branch's eventual rejection is absorbed by Promise.race.
    const { statusRows, sizeRows, maxRows } = await Promise.race([queryBlock(), dl.promise]);
    const latency = performance.now() - start;

    const status = rowsToMap(statusRows);
    const vars = rowsToMap(maxRows);
    const metrics: Record<string, number> = {};

    const connections = toFiniteNumber(status.get("Threads_connected"));
    if (connections !== null) metrics.connections = connections;

    const maxConnections = toFiniteNumber(vars.get("max_connections"));
    if (maxConnections !== null) metrics.maxConnections = maxConnections;

    const dbSize = toFiniteNumber(firstColumn(sizeRows, "size"));
    if (dbSize !== null) metrics.dbSizeBytes = dbSize;

    const questions = toFiniteNumber(status.get("Questions"));
    if (questions !== null) {
      const qps = computeRate(config.id, questions, now().getTime());
      if (qps !== null) metrics.qps = qps;
    }

    return up(config, ts, latency, metrics);
  } catch (err) {
    if (err instanceof DeadlineError) {
      state.timedOut = true;
      return down(config, ts, null, "timeout");
    }
    return down(config, ts, null, sanitizeError(errorMessage(err), config.target));
  } finally {
    dl.cancel();
    if (state.conn) {
      if (state.timedOut) {
        // conn.end() sends COM_QUIT and waits for the server — on a stalled
        // server it can hang too. On timeout, tear the socket down abruptly.
        state.conn.destroy();
      } else {
        try {
          await state.conn.end();
        } catch {
          try {
            state.conn.destroy();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}

/** Turn `[{Variable_name, Value}, ...]` rows into a name→value Map. */
function rowsToMap(rows: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      if (typeof r.Variable_name === "string") map.set(r.Variable_name, r.Value);
    }
  }
  return map;
}

/** Read a single aliased column from the first row of a result set. */
function firstColumn(rows: unknown, column: string): unknown {
  if (Array.isArray(rows) && rows[0] && typeof rows[0] === "object") {
    return (rows[0] as Record<string, unknown>)[column];
  }
  return undefined;
}
