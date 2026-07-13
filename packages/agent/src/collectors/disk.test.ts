import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

import { collectDisks } from "./disk.js";

const mountsFixture = fileURLToPath(
  new URL("../../test/fixtures/mounts/mounts.txt", import.meta.url),
);

describe("collectDisks", () => {
  let rootPath: string;

  beforeAll(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "sw-disk-"));
    // The fixture declares a real extra mount at host path "/data": create the
    // corresponding directory under the fake root so its statfs succeeds.
    await mkdir(join(rootPath, "data"));
  });

  it('reports the primary filesystem as "/" with a real, sane usage', async () => {
    const disks = await collectDisks({ rootPath, procMountsPath: mountsFixture });
    const root = disks.find((d) => d.mount === "/");
    expect(root).toBeDefined();
    expect(root!.totalBytes).toBeGreaterThan(0);
    expect(root!.usedBytes).toBeLessThanOrEqual(root!.totalBytes);
    expect(root!.usedBytes).toBeGreaterThanOrEqual(0);
  });

  it("includes real data mounts and excludes pseudo-fs and /var/lib/docker", async () => {
    const disks = await collectDisks({ rootPath, procMountsPath: mountsFixture });
    const mounts = disks.map((d) => d.mount);
    // Only the primary fs and the real /data mount survive.
    expect(mounts).toContain("/");
    expect(mounts).toContain("/data");
    // Pseudo filesystems excluded.
    expect(mounts).not.toContain("/proc");
    expect(mounts).not.toContain("/sys");
    expect(mounts).not.toContain("/run");
    expect(mounts).not.toContain("/dev");
    expect(mounts).not.toContain("/dev/shm");
    expect(mounts).not.toContain("/sys/fs/cgroup");
    // Docker internal storage excluded even though it is a real ext4/overlay.
    expect(mounts).not.toContain("/var/lib/docker/volumes");
    expect(mounts).not.toContain("/var/lib/docker/overlay2/abc123/merged");
  });

  it("deduplicates the same device mounted at multiple points", async () => {
    const disks = await collectDisks({ rootPath, procMountsPath: mountsFixture });
    // /dev/sda1 is mounted at both "/" and "/mnt/root-bind"; only "/" is kept.
    expect(disks.map((d) => d.mount)).not.toContain("/mnt/root-bind");
    expect(disks).toHaveLength(2); // "/" and "/data"
  });

  it('returns only "/" when the mounts file is missing (no throw)', async () => {
    const disks = await collectDisks({
      rootPath,
      procMountsPath: join(rootPath, "does-not-exist-mounts"),
    });
    expect(disks.map((d) => d.mount)).toEqual(["/"]);
  });

  it("never throws when the root path itself is invalid", async () => {
    const disks = await collectDisks({
      rootPath: join(rootPath, "nope"),
      procMountsPath: join(rootPath, "also-nope"),
    });
    expect(disks).toEqual([]);
  });
});
