import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectPm2Services } from "./pm2.js";

/** Write one `/proc/<pid>/<file>` entry into the fake proc tree. */
async function writeProc(
  procRoot: string,
  pid: number,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(procRoot, String(pid));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

async function makeProcRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sw-pm2-"));
}

const NUL = "\0";

describe("collectPm2Services", () => {
  it("finds the daemon's children with names and RSS", async () => {
    const procRoot = await makeProcRoot();

    // PM2 God Daemon (pid 100), child of init.
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/home/deploy/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });

    // Child "api": name from environ, RSS from status VmRSS.
    await writeProc(procRoot, 200, {
      stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      environ: `PATH=/usr/bin${NUL}name=api${NUL}NODE_ENV=production${NUL}`,
      status: "Name:\tnode\nState:\tS (sleeping)\nVmRSS:\t  204800 kB\n",
      cmdline: `node${NUL}/app/server.js${NUL}`,
    });

    // Child "myworker": no environ (name from cmdline basename), RSS from statm.
    await writeProc(procRoot, 201, {
      stat: "201 (node) S 100 201 201 0 -1 4194304 0 0 0 0 0 0",
      cmdline: `/usr/local/bin/myworker${NUL}--flag${NUL}`,
      statm: "5120 512 128 1 0 300 0",
    });

    // Child with a corrupt stat (no ppid parseable) → skipped, no throw.
    await writeProc(procRoot, 202, {
      stat: "totally-garbage-no-parens",
      cmdline: `node${NUL}`,
    });

    // A non-child process (child of init) → excluded.
    await writeProc(procRoot, 300, {
      stat: "300 (bash) S 1 300 300 0 -1 4194304 0 0 0 0 0 0",
      cmdline: `bash${NUL}`,
    });

    const services = await collectPm2Services({ procRoot });

    expect(services).toHaveLength(2);

    const api = services.find((s) => s.name === "api");
    expect(api).toBeDefined();
    expect(api!.source).toBe("pm2");
    expect(api!.state).toBe("online");
    expect(api!.cpuPct).toBeNull();
    expect(api!.restarts).toBeNull();
    expect(api!.memBytes).toBe(204800 * 1024); // 209715200

    const worker = services.find((s) => s.name === "myworker");
    expect(worker).toBeDefined();
    expect(worker!.memBytes).toBe(512 * 4096); // 2097152 (statm resident pages)

    // The corrupt and non-child pids never surface.
    expect(services.map((s) => s.name)).not.toContain("bash");
    expect(services.map((s) => s.name)).not.toContain("node");
  });

  it("returns [] when there is no PM2 God Daemon", async () => {
    const procRoot = await makeProcRoot();
    await writeProc(procRoot, 200, {
      stat: "200 (node) S 1 200 200 0 -1 4194304 0 0 0 0 0 0",
      cmdline: `node${NUL}/app/server.js${NUL}`,
    });
    await writeProc(procRoot, 300, {
      stat: "300 (bash) S 1 300 300 0 -1 4194304 0 0 0 0 0 0",
      cmdline: `bash${NUL}`,
    });

    expect(await collectPm2Services({ procRoot })).toEqual([]);
  });

  it("returns [] when procRoot does not exist (no throw)", async () => {
    expect(
      await collectPm2Services({ procRoot: "/nonexistent/proc/root/xyz" }),
    ).toEqual([]);
  });
});
