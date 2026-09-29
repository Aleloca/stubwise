/**
 * PM2 service discovery by scanning the (host) `/proc` tree — no `pm2` library
 * and no PM2 socket. We locate every PM2 "God Daemon" process (there can be one
 * per user, e.g. root + deploy), then enumerate their child processes (the
 * managed apps) and read each child's name, RSS and CPU from `/proc`.
 *
 * RSS and CPU are summed over each app's whole process TREE, not just the
 * daemon's direct child: with `npm run start` that child is npm itself, idle
 * and small, and the app is its grandchild (npm → sh → node).
 *
 * The app NAME (the one given to `pm2 start --name`) comes, in order, from:
 *  1. the daemon's pid files, `<PM2_HOME>/pids/<name>-<pm_id>.pid` on the host
 *     root — the only source readable by the agent's unprivileged user;
 *  2. the `name` env var PM2 injects (`/proc/<pid>/environ`) — readable only
 *     by the same uid or with CAP_SYS_PTRACE, so in practice never, from the
 *     container as it is installed;
 *  3. the cmdline — which for `npm run start` is npm's own process title, the
 *     same for every app: the last resort, not a name.
 * PM2_HOME is unreadable when the home is closed to other users (`/root`, a
 * `750` home): there step 1 yields nothing and we fall through to 2 and 3.
 * When stale pid files name the same pid (PM2 left one behind and the kernel
 * reused the pid), the most recently written file wins.
 *
 * Fail-soft by design: no daemon → []; any per-pid read/parse error skips that
 * pid; the collector never throws.
 */

import { readFile, readdir, stat as statFile } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoveredService } from "@stubwise/shared";

export interface CollectPm2Options {
  /** Path to the (host) proc filesystem root (e.g. "/host/proc"). */
  procRoot: string;
  /**
   * Path to the (host) root filesystem (e.g. "/host/root"), where PM2_HOME's
   * pid files are read. Omitted → names come from environ/cmdline only.
   */
  rootPath?: string;
  /**
   * CPU state carried between calls (from `createPm2CpuState`): CPU% needs two
   * reads an interval apart, so the first call — and any app restarted in
   * between — reports `cpuPct: null`. Omitted → always null.
   */
  cpuState?: Pm2CpuState;
}

/** What the previous call saw: host jiffies total, and each app's tree ticks. */
export interface Pm2CpuState {
  totalJiffies: number | null;
  /** Keyed by the app's root pid: a restart (new pid) starts from scratch. */
  appTicks: Map<number, number>;
}

export function createPm2CpuState(): Pm2CpuState {
  return { totalJiffies: null, appTicks: new Map() };
}

/**
 * Linux reports RSS in `/proc/<pid>/statm` as a count of pages. We assume the
 * near-universal 4 KiB page size; the value is only ever an approximation shown
 * in a services table, so a wrong page size on exotic arches is harmless.
 */
const PAGE_SIZE_BYTES = 4096;

/** Max service name length accepted by the ingest contract (discoveredServiceSchema). */
const MAX_NAME_LENGTH = 200;

/**
 * Interpreter executables whose basename is useless as an app name: fall back
 * to the script argument instead ("node /app/server.js" → "server.js").
 */
const INTERPRETER_BASENAMES = new Set(["node", "bun", "deno"]);

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** List the numeric (pid) entries directly under `procRoot`, ascending. */
async function listPids(procRoot: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of entries) {
    if (/^\d+$/.test(name)) pids.push(Number(name));
  }
  return pids.sort((a, b) => a - b);
}

/** The `/proc/<pid>/cmdline` is NUL-separated; join the args with spaces. */
function cmdlineToString(raw: string): string {
  return raw.split("\0").filter((s) => s.length > 0).join(" ");
}

/**
 * Recognise a PM2 God Daemon by its process title, e.g.
 * "PM2 v5.3.0: God Daemon (/home/deploy/.pm2)".
 */
function isGodDaemon(cmdline: string): boolean {
  return cmdline.includes("PM2") && cmdline.includes("God Daemon");
}

/** PM2_HOME from the daemon title: "... God Daemon (/home/deploy/.pm2)". */
function pm2HomeOf(cmdline: string): string | null {
  const match = cmdline.match(/God Daemon \((\/[^)]*)\)\s*$/);
  const home = match?.[1];
  // The title is written by a process on the host: never let it climb out of
  // the host root mount.
  if (!home || home.split("/").includes("..")) return null;
  return home;
}

/**
 * pid → app name from `<rootPath><pm2Home>/pids/<name>-<pm_id>.pid`. PM2 writes
 * the file name with every char outside [a-zA-Z0-9.-] replaced by "-", so an
 * app called `audin_api` reads back as `audin-api`: close enough to tell apps
 * apart, which is what the cmdline can't do. Unreadable dir → empty map.
 */
async function readPidFileNames(
  rootPath: string,
  pm2Home: string,
  names: Map<number, { name: string; mtimeMs: number }>,
): Promise<void> {
  const dir = join(rootPath, pm2Home, "pids");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const match = file.match(/^(.+)-\d+\.pid$/);
    if (!match?.[1]) continue;
    const path = join(dir, file);
    const content = await readFileSafe(path);
    const pid = Number(content?.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await statFile(path)).mtimeMs;
    } catch {
      continue;
    }
    const seen = names.get(pid);
    if (!seen || mtimeMs > seen.mtimeMs) names.set(pid, { name: match[1], mtimeMs });
  }
}

/**
 * Parse the process state and parent pid from `/proc/<pid>/stat`. Format:
 *   pid (comm) state ppid ...
 * `comm` may contain spaces and parentheses, so we split after the LAST ")":
 * the remaining fields are `state ppid ...`, with utime stime cutime cstime at
 * offsets 11-14. `ticks` is their sum: cutime/cstime hold the time of children
 * already reaped, so a tree's total doesn't drop when one of them exits.
 * Missing time fields (a truncated line) count as 0.
 */
function parseStat(stat: string): { state: string; ppid: number; ticks: number } | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  if (!state || !Number.isFinite(ppid)) return null;
  let ticks = 0;
  for (const field of fields.slice(11, 15)) {
    const n = Number(field);
    if (Number.isFinite(n)) ticks += n;
  }
  return { state, ppid, ticks };
}

/**
 * From `/proc/stat`: jiffies elapsed on ALL cores (aggregate "cpu " line,
 * user..steal — guest time is already inside user) and the core count.
 */
function parseProcStat(raw: string): { totalJiffies: number; cpus: number } | null {
  let totalJiffies: number | null = null;
  let cpus = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("cpu ")) {
      const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
      if (fields.some((n) => !Number.isFinite(n))) return null;
      totalJiffies = fields.reduce((sum, n) => sum + n, 0);
    } else if (/^cpu\d+\s/.test(line)) {
      cpus++;
    }
  }
  return totalJiffies === null || cpus === 0 ? null : { totalJiffies, cpus };
}

/** `/proc/<pid>/environ` is NUL-separated KEY=VALUE; return the map. */
function parseEnviron(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split("\0")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

function basename(path: string): string | null {
  const base = path.split("/").pop();
  return base && base.length > 0 ? base : null;
}

/**
 * Name fallback from cmdline: basename of argv[0], but when argv[0] is a bare
 * JS runtime (node/bun/deno) that name is useless — use the basename of the
 * script argument (argv[1]) instead.
 */
function cmdlineName(raw: string): string | null {
  const argv = raw.split("\0").filter((s) => s.length > 0);
  const first = argv[0] ? basename(argv[0]) : null;
  if (first && INTERPRETER_BASENAMES.has(first) && argv[1]) {
    return basename(argv[1]) ?? first;
  }
  return first;
}

/** RSS in bytes from `/proc/<pid>/status` (VmRSS, kB → bytes). */
function parseVmRss(status: string): number | null {
  const match = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
  return match?.[1] ? Number(match[1]) * 1024 : null;
}

/** RSS in bytes from `/proc/<pid>/statm` (2nd field = resident pages). */
function parseStatmRss(statm: string): number | null {
  const resident = Number(statm.trim().split(/\s+/)[1]);
  return Number.isFinite(resident) ? resident * PAGE_SIZE_BYTES : null;
}

/**
 * Discover PM2-managed apps across ALL running God Daemons. Returns [] if no
 * PM2 God Daemon is running under `procRoot`.
 */
export async function collectPm2Services(
  options: CollectPm2Options,
): Promise<DiscoveredService[]> {
  const { procRoot, rootPath } = options;
  const pids = await listPids(procRoot);
  if (pids.length === 0) return [];

  // Locate every God Daemon (one per user is common: root + deploy user).
  const daemonPids = new Set<number>();
  const pm2Homes: string[] = [];
  for (const pid of pids) {
    const raw = await readFileSafe(join(procRoot, String(pid), "cmdline"));
    if (!raw) continue;
    const cmdline = cmdlineToString(raw);
    if (!isGodDaemon(cmdline)) continue;
    daemonPids.add(pid);
    const home = pm2HomeOf(cmdline);
    if (home) pm2Homes.push(home);
  }
  if (daemonPids.size === 0) return [];

  // Only the pids that turn out to be daemon children are looked up, so a
  // stale pid file (stopped app) never names anything.
  const pidFileNames = new Map<number, { name: string; mtimeMs: number }>();
  if (rootPath) {
    for (const home of pm2Homes) await readPidFileNames(rootPath, home, pidFileNames);
  }

  // One pass over every process: the tree below each app is built from ppids.
  const procs = new Map<number, { state: string; ppid: number; ticks: number }>();
  const children = new Map<number, number[]>();
  for (const pid of pids) {
    const statRaw = await readFileSafe(join(procRoot, String(pid), "stat"));
    const stat = statRaw ? parseStat(statRaw) : null;
    if (!stat) continue;
    procs.set(pid, stat);
    const siblings = children.get(stat.ppid);
    if (siblings) siblings.push(pid);
    else children.set(stat.ppid, [pid]);
  }

  const procStatRaw = options.cpuState ? await readFileSafe(join(procRoot, "stat")) : null;
  const host = procStatRaw ? parseProcStat(procStatRaw) : null;
  const cpuState = options.cpuState;
  const prevTotal = cpuState?.totalJiffies ?? null;
  const prevTicks = cpuState?.appTicks ?? new Map<number, number>();
  const nextTicks = new Map<number, number>();

  const services: DiscoveredService[] = [];
  for (const [pid, stat] of procs) {
    if (daemonPids.has(pid) || !daemonPids.has(stat.ppid)) continue; // not an app
    // A zombie is already dead — PM2 just hasn't reaped it yet. Reporting it as
    // "online" would be a lie and its /proc metrics are meaningless → skip it;
    // the restarted replacement (a live child) will be picked up instead.
    if (stat.state === "Z") continue;

    // Name: pid file, then PM2's `name` env var, then the cmdline (see top).
    let name: string | null = pidFileNames.get(pid)?.name ?? null;
    if (!name) {
      const environ = await readFileSafe(join(procRoot, String(pid), "environ"));
      if (environ) name = parseEnviron(environ).get("name") ?? null;
    }
    if (!name) {
      const cmdline = await readFileSafe(join(procRoot, String(pid), "cmdline"));
      if (cmdline) name = cmdlineName(cmdline);
    }
    if (!name) continue; // no usable name → skip
    // Cap at 200 chars: the ingest contract (discoveredServiceSchema) rejects
    // longer names and one oversized name would fail the whole payload.
    name = name.slice(0, MAX_NAME_LENGTH);

    // The app's tree: itself and every descendant.
    const tree: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      tree.push(current);
      queue.push(...(children.get(current) ?? []));
    }

    // Memory: sum over the live tree (zombies hold none); per process prefer
    // VmRSS from status, fall back to statm. Null only if nothing was readable.
    let memBytes: number | null = null;
    for (const member of tree) {
      if (procs.get(member)?.state === "Z") continue;
      let rss: number | null = null;
      const status = await readFileSafe(join(procRoot, String(member), "status"));
      if (status) rss = parseVmRss(status);
      if (rss === null) {
        const statm = await readFileSafe(join(procRoot, String(member), "statm"));
        if (statm) rss = parseStatmRss(statm);
      }
      if (rss !== null) memBytes = (memBytes ?? 0) + rss;
    }

    // CPU: % of ONE core over the interval, as the Docker collector reports it
    // (so 150 = one and a half cores busy).
    const ticks = tree.reduce((sum, member) => sum + (procs.get(member)?.ticks ?? 0), 0);
    nextTicks.set(pid, ticks);
    let cpuPct: number | null = null;
    const before = prevTicks.get(pid);
    if (host && prevTotal !== null && before !== undefined) {
      const totalDelta = host.totalJiffies - prevTotal;
      const appDelta = ticks - before;
      if (totalDelta > 0 && appDelta >= 0) cpuPct = (appDelta / totalDelta) * host.cpus * 100;
    }

    services.push({
      source: "pm2",
      name,
      state: "online", // alive (non-zombie) child of a running daemon
      cpuPct,
      memBytes,
      restarts: null, // a /proc scan cannot recover PM2's restart counter
    });
  }

  if (cpuState) {
    cpuState.totalJiffies = host?.totalJiffies ?? null;
    cpuState.appTicks = nextTicks;
  }
  return services;
}
