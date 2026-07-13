/**
 * PM2 service discovery by scanning the (host) `/proc` tree — no `pm2` library
 * and no PM2 socket. We locate every PM2 "God Daemon" process (there can be one
 * per user, e.g. root + deploy), then enumerate their child processes (the
 * managed apps) and read each child's name and RSS from `/proc`.
 *
 * Fail-soft by design: no daemon → []; any per-pid read/parse error skips that
 * pid; the collector never throws.
 */

import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoveredService } from "@stubwise/shared";

export interface CollectPm2Options {
  /** Path to the (host) proc filesystem root (e.g. "/host/proc"). */
  procRoot: string;
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

/**
 * Parse the process state and parent pid from `/proc/<pid>/stat`. Format:
 *   pid (comm) state ppid ...
 * `comm` may contain spaces and parentheses, so we split after the LAST ")":
 * the remaining fields are `state ppid ...`.
 */
function parseStat(stat: string): { state: string; ppid: number } | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  if (!state || !Number.isFinite(ppid)) return null;
  return { state, ppid };
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
  const { procRoot } = options;
  const pids = await listPids(procRoot);
  if (pids.length === 0) return [];

  // Locate every God Daemon (one per user is common: root + deploy user).
  const daemonPids = new Set<number>();
  for (const pid of pids) {
    const cmdline = await readFileSafe(join(procRoot, String(pid), "cmdline"));
    if (cmdline && isGodDaemon(cmdlineToString(cmdline))) daemonPids.add(pid);
  }
  if (daemonPids.size === 0) return [];

  const services: DiscoveredService[] = [];
  for (const pid of pids) {
    if (daemonPids.has(pid)) continue;

    const statRaw = await readFileSafe(join(procRoot, String(pid), "stat"));
    if (!statRaw) continue;
    const stat = parseStat(statRaw);
    if (!stat || !daemonPids.has(stat.ppid)) continue; // not a child of a daemon
    // A zombie is already dead — PM2 just hasn't reaped it yet. Reporting it as
    // "online" would be a lie and its /proc metrics are meaningless → skip it;
    // the restarted replacement (a live child) will be picked up instead.
    if (stat.state === "Z") continue;

    // Name: PM2 injects a `name` env var; fall back to the cmdline-derived name.
    let name: string | null = null;
    const environ = await readFileSafe(join(procRoot, String(pid), "environ"));
    if (environ) name = parseEnviron(environ).get("name") ?? null;
    if (!name) {
      const cmdline = await readFileSafe(join(procRoot, String(pid), "cmdline"));
      if (cmdline) name = cmdlineName(cmdline);
    }
    if (!name) continue; // no usable name → skip
    // Cap at 200 chars: the ingest contract (discoveredServiceSchema) rejects
    // longer names and one oversized name would fail the whole payload.
    name = name.slice(0, MAX_NAME_LENGTH);

    // Memory: prefer VmRSS from status, fall back to statm.
    let memBytes: number | null = null;
    const status = await readFileSafe(join(procRoot, String(pid), "status"));
    if (status) memBytes = parseVmRss(status);
    if (memBytes === null) {
      const statm = await readFileSafe(join(procRoot, String(pid), "statm"));
      if (statm) memBytes = parseStatmRss(statm);
    }

    services.push({
      source: "pm2",
      name,
      state: "online", // alive (non-zombie) child of a running daemon
      // CPU% would need two /proc reads an interval apart; not worth it here (YAGNI).
      cpuPct: null,
      memBytes,
      restarts: null, // a /proc scan cannot recover PM2's restart counter
    });
  }
  return services;
}
