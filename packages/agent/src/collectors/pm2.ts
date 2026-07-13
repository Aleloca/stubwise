/**
 * PM2 service discovery by scanning the (host) `/proc` tree — no `pm2` library
 * and no PM2 socket. We locate the PM2 "God Daemon" process, then enumerate its
 * child processes (the managed apps) and read their name and RSS from `/proc`.
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

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** List the numeric (pid) entries directly under `procRoot`. */
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
  return pids;
}

/** The `/proc/<pid>/cmdline` is NUL-separated; join the args with spaces. */
function cmdlineToString(raw: string): string {
  return raw.split("\0").filter((s) => s.length > 0).join(" ");
}

/**
 * Recognise the PM2 God Daemon by its process title, e.g.
 * "PM2 v5.3.0: God Daemon (/home/deploy/.pm2)".
 */
function isGodDaemon(cmdline: string): boolean {
  return cmdline.includes("PM2") && cmdline.includes("God Daemon");
}

/**
 * Parse the parent pid from `/proc/<pid>/stat`. Format:
 *   pid (comm) state ppid ...
 * `comm` may contain spaces and parentheses, so we split after the LAST ")":
 * the remaining fields are `state ppid ...`.
 */
function parsePpid(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // fields[0] = state, fields[1] = ppid
  const ppid = Number(fields[1]);
  return Number.isFinite(ppid) ? ppid : null;
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

/** basename of the first cmdline argument, used as a name fallback. */
function cmdlineBasename(raw: string): string | null {
  const argv0 = raw.split("\0").find((s) => s.length > 0);
  if (!argv0) return null;
  const base = argv0.split("/").pop();
  return base && base.length > 0 ? base : null;
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
 * Discover PM2-managed apps. Returns [] if no PM2 God Daemon is running under
 * `procRoot`.
 */
export async function collectPm2Services(
  options: CollectPm2Options,
): Promise<DiscoveredService[]> {
  const { procRoot } = options;
  const pids = await listPids(procRoot);
  if (pids.length === 0) return [];

  // Locate the God Daemon.
  let daemonPid: number | null = null;
  for (const pid of pids.sort((a, b) => a - b)) {
    const cmdline = await readFileSafe(join(procRoot, String(pid), "cmdline"));
    if (cmdline && isGodDaemon(cmdlineToString(cmdline))) {
      daemonPid = pid;
      break;
    }
  }
  if (daemonPid === null) return [];

  const services: DiscoveredService[] = [];
  for (const pid of pids.sort((a, b) => a - b)) {
    if (pid === daemonPid) continue;

    const stat = await readFileSafe(join(procRoot, String(pid), "stat"));
    if (!stat) continue;
    const ppid = parsePpid(stat);
    if (ppid !== daemonPid) continue; // not a child of the daemon

    // Name: PM2 injects a `name` env var; fall back to the executable basename.
    let name: string | null = null;
    const environ = await readFileSafe(join(procRoot, String(pid), "environ"));
    if (environ) name = parseEnviron(environ).get("name") ?? null;
    if (!name) {
      const cmdline = await readFileSafe(join(procRoot, String(pid), "cmdline"));
      if (cmdline) name = cmdlineBasename(cmdline);
    }
    if (!name) continue; // no usable name → skip

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
      state: "online", // the process exists under the daemon
      // CPU% would need two /proc reads an interval apart; not worth it here (YAGNI).
      cpuPct: null,
      memBytes,
      restarts: null, // a /proc scan cannot recover PM2's restart counter
    });
  }
  return services;
}
