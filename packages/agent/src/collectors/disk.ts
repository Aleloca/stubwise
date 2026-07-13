/**
 * Disk usage collector. Reads the primary filesystem via `statfs` on the mounted
 * host root and enumerates extra data mounts from the host's `/proc/mounts`,
 * skipping pseudo-filesystems and Docker's internal mounts.
 *
 * All paths are provided by the caller so the agent can point them at the
 * bind-mounted host tree (`/host/root`, `/host/proc/mounts`) while tests point
 * them at temp directories / textual fixtures.
 */

import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DiskUsage {
  /** Mountpoint on the host (e.g. "/", "/data"). */
  mount: string;
  usedBytes: number;
  totalBytes: number;
}

export interface CollectDisksOptions {
  /** Host root filesystem mounted read-only (e.g. "/host/root"). */
  rootPath: string;
  /** Path to the host `/proc/mounts` (e.g. "/host/proc/mounts"). */
  procMountsPath: string;
}

/**
 * Filesystem types that are virtual/pseudo (RAM-backed, kernel interfaces,
 * per-container overlays) and carry no meaningful "disk usage" for a host: they
 * are excluded from the mount list. `cgroup`/`cgroup2` and `fuse.` variants are
 * matched by prefix.
 */
const PSEUDO_FS_TYPES = new Set([
  "proc",
  "sysfs",
  "tmpfs",
  "devtmpfs",
  "devpts",
  "overlay",
  "squashfs",
  "mqueue",
  "debugfs",
  "tracefs",
  "securityfs",
  "pstore",
  "bpf",
  "autofs",
  "hugetlbfs",
  "fusectl",
  "configfs",
  "ramfs",
  "nsfs",
  "binfmt_misc",
  "rpc_pipefs",
  "efivarfs",
  "selinuxfs",
]);

function isPseudoFs(fstype: string): boolean {
  return (
    PSEUDO_FS_TYPES.has(fstype) ||
    fstype.startsWith("cgroup") ||
    fstype.startsWith("fuse.")
  );
}

interface MountEntry {
  device: string;
  mountpoint: string;
  fstype: string;
}

/**
 * Decode the octal escapes the kernel uses in `/proc/mounts` for characters
 * that would otherwise break the whitespace-separated columns (space = \040,
 * tab = \011, newline = \012, backslash = \134).
 */
function unescapeMountField(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/** Parse `/proc/mounts` lines into {device, mountpoint, fstype} triples. */
function parseMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const [device, mountpoint, fstype] = parts;
    if (!device || !mountpoint || !fstype) continue;
    out.push({
      device: unescapeMountField(device),
      mountpoint: unescapeMountField(mountpoint),
      fstype,
    });
  }
  return out;
}

/**
 * used  = (blocks - bfree) * bsize  — this is the `df` convention: it counts
 *         blocks reserved for root as "used", matching what `df` reports.
 * total = blocks * bsize.
 *
 * NOTE bavail vs bfree: `bfree` is free blocks including the root-reserved
 * pool, `bavail` is free blocks available to unprivileged users. We report
 * used with `bfree` (df's "Used" column); the user-facing "Avail" would be
 * `bavail * bsize`, but the ingest schema only wants used/total so we keep it
 * consistent with df's usage math.
 */
function usageFromStatfs(stats: {
  blocks: number;
  bfree: number;
  bsize: number;
}): { usedBytes: number; totalBytes: number } {
  const totalBytes = Math.max(0, stats.blocks * stats.bsize);
  const usedBytes = Math.max(0, (stats.blocks - stats.bfree) * stats.bsize);
  return { usedBytes, totalBytes };
}

/**
 * Collect disk usage for the primary filesystem plus extra data mounts.
 * Never throws: a failing `statfs` for a single mount (or a missing mounts
 * file) simply drops that mount from the result.
 */
export async function collectDisks(
  options: CollectDisksOptions,
): Promise<DiskUsage[]> {
  const { rootPath, procMountsPath } = options;
  const result: DiskUsage[] = [];
  const seenDevices = new Set<string>();

  // Primary filesystem: always reported as mount "/" via statfs on the host root.
  try {
    const stats = await statfs(rootPath);
    result.push({ mount: "/", ...usageFromStatfs(stats) });
  } catch {
    // If even the root statfs fails there is nothing sensible to report.
  }

  let mountsText: string;
  try {
    mountsText = await readFile(procMountsPath, "utf8");
  } catch {
    // Mounts file missing/unreadable → report only the primary filesystem.
    return result;
  }

  const entries = parseMounts(mountsText);

  // Seed the dedup set with the root device so a bind mount of "/" elsewhere is
  // not counted twice.
  const rootEntry = entries.find((e) => e.mountpoint === "/");
  if (rootEntry) seenDevices.add(rootEntry.device);

  for (const entry of entries) {
    if (entry.mountpoint === "/") continue; // covered by the rootPath statfs
    if (isPseudoFs(entry.fstype)) continue;
    // Docker's internal storage (image layers, volumes) — not host disk to show.
    if (
      entry.mountpoint === "/var/lib/docker" ||
      entry.mountpoint.startsWith("/var/lib/docker/")
    ) {
      continue;
    }
    // Same device mounted at multiple points → a single entry.
    if (seenDevices.has(entry.device)) continue;
    seenDevices.add(entry.device);

    try {
      // The host mountpoint is an absolute host path; resolve it under the
      // bind-mounted host root to statfs it from inside the container.
      const stats = await statfs(join(rootPath, entry.mountpoint));
      result.push({ mount: entry.mountpoint, ...usageFromStatfs(stats) });
    } catch {
      // Per-mount statfs error → skip this mount, never throw.
    }
  }

  return result;
}
