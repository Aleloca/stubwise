/**
 * Docker service discovery via the Docker Engine API over the Unix socket
 * (`/var/run/docker.sock`). Lists running containers and pulls a one-shot CPU/RAM
 * stats sample for each. No Docker CLI, no external deps beyond undici.
 *
 * Fail-soft by design: an absent socket, a non-200 response, or malformed JSON
 * never throws — the whole collector returns `[]`, and a container whose stats
 * fail stays in the list with null cpu/mem.
 */

import { Pool } from "undici";

import type { DiscoveredService } from "@stubwise/shared";

export interface CollectDockerOptions {
  /** Path to the Docker Engine Unix socket (e.g. "/var/run/docker.sock"). */
  socketPath: string;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
}

/**
 * How many stats requests run in parallel. Each `stream=false` stats call costs
 * ~1-1.5s (the daemon takes two internal reads one interval apart), so serial
 * collection on a 30-container host would take 30-45s and overrun the sampling
 * interval. The daemon comfortably handles 8-16 concurrent stats reads.
 */
const STATS_CONCURRENCY = 8;

/** Max service name length accepted by the ingest contract (discoveredServiceSchema). */
const MAX_NAME_LENGTH = 200;

interface ContainerSummary {
  Id?: string;
  Names?: string[];
  State?: string;
}

interface DockerStats {
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: {
    usage?: number;
    stats?: { inactive_file?: number };
  };
}

interface CpuStats {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  system_cpu_usage?: number;
  online_cpus?: number;
}

/** Perform a GET against the Docker Engine API and parse the JSON body. */
async function dockerGetJson(
  pool: Pool,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  const { statusCode, body } = await pool.request({
    method: "GET",
    path,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (statusCode !== 200) {
    await body.dump(); // drain the body to free the connection
    throw new Error(`docker GET ${path} -> HTTP ${statusCode}`);
  }
  return body.json();
}

/**
 * CPU percentage using the same formula `docker stats` uses:
 *
 *   cpuDelta    = cpu_stats.total_usage    - precpu_stats.total_usage
 *   systemDelta = cpu_stats.system_usage   - precpu_stats.system_usage
 *   pct         = cpuDelta / systemDelta * online_cpus * 100
 *
 * We fetch stats with `stream=false` (NOT `one-shot=true`): Docker then takes
 * two internal reads one interval apart and populates `precpu_stats`, so a
 * single response already carries a usable delta. With `one-shot=true` precpu
 * would be zero and the percentage would be meaningless.
 *
 * Any missing field, a non-positive system delta, or no online CPUs → null.
 */
function computeCpuPct(stats: DockerStats): number | null {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const cpuTotal = cpu?.cpu_usage?.total_usage;
  const preTotal = pre?.cpu_usage?.total_usage;
  const cpuSystem = cpu?.system_cpu_usage;
  const preSystem = pre?.system_cpu_usage;
  // online_cpus may be absent on older engines → fall back to the length of the
  // per-CPU usage array.
  const onlineCpus = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length;

  if (
    !isFiniteNumber(cpuTotal) ||
    !isFiniteNumber(preTotal) ||
    !isFiniteNumber(cpuSystem) ||
    !isFiniteNumber(preSystem) ||
    !isFiniteNumber(onlineCpus)
  ) {
    return null;
  }

  const cpuDelta = cpuTotal - preTotal;
  const systemDelta = cpuSystem - preSystem;
  if (systemDelta <= 0 || cpuDelta < 0 || onlineCpus <= 0) return null;

  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

/**
 * Memory usage following the `docker stats` convention: total usage minus the
 * reclaimable page cache (`inactive_file`), which the kernel counts against the
 * cgroup but is not "real" application memory. Missing fields → null.
 */
function computeMemBytes(stats: DockerStats): number | null {
  const usage = stats.memory_stats?.usage;
  if (!isFiniteNumber(usage)) return null;
  const inactiveFile = stats.memory_stats?.stats?.inactive_file;
  const cache = isFiniteNumber(inactiveFile) ? inactiveFile : 0;
  const value = usage - cache;
  return value >= 0 ? Math.round(value) : null;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Strip Docker's leading slash from a container name ("/api" → "api") and cap
 * it at 200 chars: the ingest contract (`discoveredServiceSchema`) rejects
 * longer names, and one oversized name would fail the whole payload.
 */
function normalizeName(names: string[] | undefined): string | null {
  const raw = names?.[0];
  if (!raw) return null;
  const trimmed = raw.replace(/^\//, "").slice(0, MAX_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Discover running Docker containers with a CPU/RAM sample each. Returns [] on
 * any top-level failure (socket missing, list request failed, malformed list).
 * Stats are fetched STATS_CONCURRENCY at a time (see the constant's doc).
 */
export async function collectDockerServices(
  options: CollectDockerOptions,
): Promise<DiscoveredService[]> {
  const { socketPath, timeoutMs = 5000 } = options;
  const pool = new Pool("http://localhost", {
    socketPath,
    connections: STATS_CONCURRENCY,
  });

  try {
    const list = await dockerGetJson(pool, "/containers/json", timeoutMs);
    if (!Array.isArray(list)) return [];

    const containers = (list as ContainerSummary[]).flatMap((raw) => {
      const name = normalizeName(raw.Names);
      const id = raw.Id;
      if (!name || !id) return []; // unusable entry
      return [
        { id, name, state: typeof raw.State === "string" ? raw.State : "running" },
      ];
    });

    // Fetch stats in batches of STATS_CONCURRENCY: the Pool caps the sockets,
    // the batching caps the in-flight promises. A failed stats request keeps
    // the container in the list with null metrics.
    const services: DiscoveredService[] = [];
    for (let i = 0; i < containers.length; i += STATS_CONCURRENCY) {
      const batch = containers.slice(i, i + STATS_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((c) =>
          dockerGetJson(pool, `/containers/${c.id}/stats?stream=false`, timeoutMs),
        ),
      );
      batch.forEach((container, j) => {
        const outcome = settled[j];
        const stats =
          outcome?.status === "fulfilled" ? (outcome.value as DockerStats) : null;
        services.push({
          source: "docker",
          name: container.name,
          state: container.state,
          cpuPct: stats ? computeCpuPct(stats) : null,
          memBytes: stats ? computeMemBytes(stats) : null,
          restarts: null, // Docker does not expose a restart count here
        });
      });
    }
    return services;
  } catch {
    // Socket absent / list request failed / malformed JSON → nothing to report.
    return [];
  } finally {
    // Awaited so the sockets are really released before the collector resolves;
    // a close error must never mask the result.
    await pool.close().catch(() => {});
  }
}
