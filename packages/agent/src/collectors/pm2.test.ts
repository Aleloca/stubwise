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

  it("collects children of MULTIPLE God Daemons (root + deploy user)", async () => {
    const procRoot = await makeProcRoot();

    // Root daemon (pid 100) and deploy-user daemon (pid 110).
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/root/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });
    await writeProc(procRoot, 110, {
      cmdline: `PM2 v5.3.0: God Daemon (/home/deploy/.pm2)${NUL}`,
      stat: "110 (PM2 v5.3.0: G) S 1 110 110 0 -1 4194560 0 0 0 0 0 0",
    });

    // One child each.
    await writeProc(procRoot, 200, {
      stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      environ: `name=root-app${NUL}`,
      status: "VmRSS:\t 1024 kB\n",
    });
    await writeProc(procRoot, 210, {
      stat: "210 (node) S 110 210 210 0 -1 4194304 0 0 0 0 0 0",
      environ: `name=deploy-app${NUL}`,
      status: "VmRSS:\t 2048 kB\n",
    });

    const services = await collectPm2Services({ procRoot });
    expect(services.map((s) => s.name).sort()).toEqual(["deploy-app", "root-app"]);
  });

  it("skips zombie children (state Z in stat)", async () => {
    const procRoot = await makeProcRoot();
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/home/deploy/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });
    // Zombie child: already dead, not yet reaped → must not be listed "online".
    await writeProc(procRoot, 200, {
      stat: "200 (node) Z 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      environ: `name=dead-app${NUL}`,
    });
    // Live sibling still shows up.
    await writeProc(procRoot, 201, {
      stat: "201 (node) S 100 201 201 0 -1 4194304 0 0 0 0 0 0",
      environ: `name=live-app${NUL}`,
    });

    const services = await collectPm2Services({ procRoot });
    expect(services.map((s) => s.name)).toEqual(["live-app"]);
  });

  it("falls back to the script basename when argv0 is a JS runtime", async () => {
    const procRoot = await makeProcRoot();
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/home/deploy/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });
    // No environ: name comes from cmdline. argv0 basename is "node" (useless)
    // → use the script argv[1] basename "server.js".
    await writeProc(procRoot, 200, {
      stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      cmdline: `/usr/bin/node${NUL}/app/dist/server.js${NUL}--port=3000${NUL}`,
    });

    const services = await collectPm2Services({ procRoot });
    expect(services.map((s) => s.name)).toEqual(["server.js"]);
  });

  it("truncates names longer than the 200-char ingest contract", async () => {
    const procRoot = await makeProcRoot();
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/home/deploy/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });
    const longName = "x".repeat(250);
    await writeProc(procRoot, 200, {
      stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      environ: `name=${longName}${NUL}`,
    });

    const services = await collectPm2Services({ procRoot });
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("x".repeat(200));
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
