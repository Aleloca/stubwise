/**
 * Pure parsers for the Linux `/proc` pseudo-filesystem. Each takes the raw file
 * text (as read from the mounted host `/proc`) and returns plain numbers/objects,
 * so they are trivially unit-testable against textual fixtures.
 */

/** Numeric fields of the aggregate `cpu ` line, split into busy/idle. */
interface CpuTimes {
  total: number;
  /** idle + iowait — time the CPU was NOT doing work. */
  idle: number;
}

/** Parse the aggregate `cpu ` line (not the per-core `cpuN` lines). */
function parseCpuLine(stat: string): CpuTimes | null {
  for (const line of stat.split("\n")) {
    // The aggregate line starts with "cpu " (a space), per-core lines are "cpu0".
    if (!line.startsWith("cpu ")) continue;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.some((n) => !Number.isFinite(n))) return null;
    // Layout: user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const total = fields.reduce((sum, n) => sum + n, 0);
    return { total, idle };
  }
  return null;
}

/**
 * CPU utilization percentage over the interval between two `/proc/stat` reads.
 * busy = total - idle - iowait; pct = busyDelta / totalDelta * 100 (clamped 0-100).
 * Two identical reads (or a non-positive total delta) yield 0.
 */
export function parseCpu(stat1: string, stat2: string): number {
  const a = parseCpuLine(stat1);
  const b = parseCpuLine(stat2);
  if (!a || !b) return 0;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  const idleDelta = b.idle - a.idle;
  const busyDelta = totalDelta - idleDelta;
  const pct = (busyDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Read a `Key:   <n> kB` line from /proc/meminfo, returning bytes (kB → byte). */
function meminfoBytes(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
  if (!match?.[1]) return null;
  return Number(match[1]) * 1024;
}

/**
 * Memory usage from /proc/meminfo, all values in bytes.
 * used = MemTotal - MemAvailable (falls back to MemFree on ancient kernels that
 * predate MemAvailable, ~pre-3.14); swap used = SwapTotal - SwapFree.
 */
export function parseMeminfo(text: string): {
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
} {
  const memTotal = meminfoBytes(text, "MemTotal") ?? 0;
  // MemAvailable is the kernel's estimate of allocatable memory; prefer it.
  // Fallback: MemFree (coarser — ignores reclaimable cache — but the best an old
  // kernel offers).
  const memAvailable =
    meminfoBytes(text, "MemAvailable") ?? meminfoBytes(text, "MemFree") ?? 0;
  const swapTotal = meminfoBytes(text, "SwapTotal") ?? 0;
  const swapFree = meminfoBytes(text, "SwapFree") ?? 0;
  return {
    memUsedBytes: Math.max(0, memTotal - memAvailable),
    memTotalBytes: memTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** The 1-minute load average (first field of /proc/loadavg). */
export function parseLoadavg(text: string): number {
  const first = text.trim().split(/\s+/)[0];
  const value = Number(first);
  return Number.isFinite(value) ? value : 0;
}

/** Parse the rx-bytes (col 0) and tx-bytes (col 8) counters of a /proc/net/dev line. */
function parseNetCounters(text: string): Map<string, { rx: number; tx: number }> {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue; // header lines have no interface colon
    const name = line.slice(0, colon).trim();
    if (!name) continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    // Receive block is 8 columns; transmit bytes is the first transmit column (index 8).
    const rx = cols[0];
    const tx = cols[8];
    if (rx === undefined || tx === undefined) continue;
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    out.set(name, { rx, tx });
  }
  return out;
}

/**
 * Sum of rx/tx byte deltas across all NON-loopback interfaces between two
 * /proc/net/dev reads. A counter that decreased (interface reset / reboot) yields
 * a 0 delta for that interface — never negative.
 */
export function parseNetDev(
  prev: string,
  curr: string,
): { rxBytes: number; txBytes: number } {
  const before = parseNetCounters(prev);
  const after = parseNetCounters(curr);
  let rxBytes = 0;
  let txBytes = 0;
  for (const [name, now] of after) {
    if (name === "lo") continue;
    const then = before.get(name);
    if (!then) continue; // interface appeared this interval — no baseline delta
    rxBytes += Math.max(0, now.rx - then.rx);
    txBytes += Math.max(0, now.tx - then.tx);
  }
  return { rxBytes, txBytes };
}
