import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { collectPm2Services, createPm2CpuState } from "./pm2.js";

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

  describe("names from the PM2_HOME pid files (environ unreadable)", () => {
    /** Fake host root with `<pm2Home>/pids/<file>` entries. */
    async function makeHostRoot(pm2Home: string, pids: Record<string, string>): Promise<string> {
      const rootPath = await mkdtemp(join(tmpdir(), "sw-pm2-root-"));
      const dir = join(rootPath, pm2Home, "pids");
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(pids)) {
        await writeFile(join(dir, file), content);
      }
      return rootPath;
    }

    async function writeDaemon(procRoot: string, pid: number, pm2Home: string): Promise<void> {
      await writeProc(procRoot, pid, {
        cmdline: `PM2 v5.3.0: God Daemon (${pm2Home})${NUL}`,
        stat: `${pid} (PM2 v5.3.0: G) S 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0`,
      });
    }

    // The case seen in production: the agent runs as an unprivileged user, so
    // /proc/<pid>/environ is unreadable (no file here), and npm rewrites its own
    // process title — every app started with `npm run start` looked the same.
    it("uses the PM2 app name instead of the npm process title", async () => {
      const procRoot = await makeProcRoot();
      await writeDaemon(procRoot, 100, "/home/deploy/.pm2");
      await writeProc(procRoot, 200, {
        stat: "200 (npm run start) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      await writeProc(procRoot, 201, {
        stat: "201 (npm run start) S 100 201 201 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      const rootPath = await makeHostRoot("/home/deploy/.pm2", {
        "Audin-api-0.pid": "200",
        "Audin-web-1.pid": "201\n",
        "stale-app-2.pid": "999", // app stopped: its pid is not a daemon child
        "garbage.pid": "200", // not `<name>-<id>.pid` → ignored
      });

      const services = await collectPm2Services({ procRoot, rootPath });
      expect(services.map((s) => s.name)).toEqual(["Audin-api", "Audin-web"]);
    });

    it("keeps each daemon's pid files separate (root + deploy user)", async () => {
      const procRoot = await makeProcRoot();
      await writeDaemon(procRoot, 100, "/home/deploy/.pm2");
      await writeDaemon(procRoot, 110, "/home/other/.pm2");
      await writeProc(procRoot, 200, {
        stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      await writeProc(procRoot, 210, {
        stat: "210 (node) S 110 210 210 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      const rootPath = await makeHostRoot("/home/deploy/.pm2", { "deploy-app-0.pid": "200" });
      await mkdir(join(rootPath, "home/other/.pm2/pids"), { recursive: true });
      await writeFile(join(rootPath, "home/other/.pm2/pids/other-app-0.pid"), "210");

      const services = await collectPm2Services({ procRoot, rootPath });
      expect(services.map((s) => s.name)).toEqual(["deploy-app", "other-app"]);
    });

    it("falls back to environ, then cmdline, when PM2_HOME is unreadable", async () => {
      const procRoot = await makeProcRoot();
      // e.g. /root/.pm2 or a 750 home: the pids dir does not exist for us.
      await writeDaemon(procRoot, 100, "/root/.pm2");
      await writeProc(procRoot, 200, {
        stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
        environ: `name=from-environ${NUL}`,
        cmdline: "npm run start",
      });
      await writeProc(procRoot, 201, {
        stat: "201 (node) S 100 201 201 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      const rootPath = await mkdtemp(join(tmpdir(), "sw-pm2-root-"));

      const services = await collectPm2Services({ procRoot, rootPath });
      expect(services.map((s) => s.name)).toEqual(["from-environ", "npm run start"]);
    });

    it("never resolves a PM2_HOME that climbs out of the host root", async () => {
      const procRoot = await makeProcRoot();
      await writeDaemon(procRoot, 100, "/../../escape/.pm2");
      await writeProc(procRoot, 200, {
        stat: "200 (node) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
        cmdline: "npm run start",
      });
      // The pid file sits where `join(rootPath, "/../../escape/.pm2")` would land.
      const outer = await mkdtemp(join(tmpdir(), "sw-pm2-outer-"));
      const rootPath = join(outer, "a", "b");
      await mkdir(rootPath, { recursive: true });
      await mkdir(join(outer, "escape/.pm2/pids"), { recursive: true });
      await writeFile(join(outer, "escape/.pm2/pids/escaped-0.pid"), "200");

      const services = await collectPm2Services({ procRoot, rootPath });
      expect(services.map((s) => s.name)).toEqual(["npm run start"]);
    });
  });

  // On a host where the same pid shows up in two pid files (PM2 left the one of
  // a stopped instance behind and the kernel has since reused its pid), the
  // most recently written file is the one describing the live process.
  it("prefers the newest pid file when two name the same pid", async () => {
    const procRoot = await makeProcRoot();
    await writeProc(procRoot, 100, {
      cmdline: `PM2 v5.3.0: God Daemon (/root/.pm2)${NUL}`,
      stat: "100 (PM2 v5.3.0: G) S 1 100 100 0 -1 4194560 0 0 0 0 0 0",
    });
    await writeProc(procRoot, 200, {
      stat: "200 (npm run start) S 100 200 200 0 -1 4194304 0 0 0 0 0 0",
      cmdline: "npm run start",
    });
    const rootPath = await mkdtemp(join(tmpdir(), "sw-pm2-root-"));
    const dir = join(rootPath, "root/.pm2/pids");
    await mkdir(dir, { recursive: true });
    // Alphabetically old-app comes LAST: a "last one read wins" map would pick it.
    await writeFile(join(dir, "new-app-3.pid"), "200");
    await writeFile(join(dir, "old-app-1.pid"), "200");
    await utimes(join(dir, "old-app-1.pid"), new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(join(dir, "new-app-3.pid"), new Date("2026-09-01"), new Date("2026-09-01"));

    const services = await collectPm2Services({ procRoot, rootPath });
    expect(services.map((s) => s.name)).toEqual(["new-app"]);
  });

  describe("CPU and memory of the whole process tree", () => {
    /** `/proc/<pid>/stat` with utime/stime/cutime/cstime at fields 14-17. */
    function statLine(pid: number, ppid: number, utime: number, stime: number, state = "S", cutime = 0): string {
      return `${pid} (x) ${state} ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 ${utime} ${stime} ${cutime} 0 20 0 1 0 100`;
    }
    /** `/proc/stat` whose aggregate line totals `total` jiffies, on `cpus` cores. */
    function procStat(total: number, cpus: number): string {
      const perCore = Array.from({ length: cpus }, (_, i) => `cpu${i} 0 0 0 0 0 0 0 0 0 0`);
      return [`cpu  ${total} 0 0 0 0 0 0 0 0 0`, ...perCore, "intr 0"].join("\n") + "\n";
    }

    async function setup(procRoot: string): Promise<void> {
      await writeProc(procRoot, 100, {
        cmdline: `PM2 v5.3.0: God Daemon (/root/.pm2)${NUL}`,
        stat: statLine(100, 1, 0, 0),
      });
    }

    // `npm run start`: PM2's child is npm, the app is its grandchild node.
    // Measuring only npm (idle, small) is what the table showed before.
    it("sums RSS over npm → sh → node, and nothing outside the tree", async () => {
      const procRoot = await makeProcRoot();
      await setup(procRoot);
      await writeFile(join(procRoot, "stat"), procStat(1000, 2));
      await writeProc(procRoot, 200, {
        stat: statLine(200, 100, 0, 0),
        environ: `name=app${NUL}`,
        status: "VmRSS:\t 1000 kB\n",
      });
      await writeProc(procRoot, 201, { stat: statLine(201, 200, 0, 0), status: "VmRSS:\t 100 kB\n" });
      await writeProc(procRoot, 202, { stat: statLine(202, 201, 0, 0), status: "VmRSS:\t 50000 kB\n" });
      // Unrelated process: must not be summed in.
      await writeProc(procRoot, 300, { stat: statLine(300, 1, 0, 0), status: "VmRSS:\t 99999 kB\n" });

      const [app] = await collectPm2Services({ procRoot });
      expect(app!.memBytes).toBe((1000 + 100 + 50000) * 1024);
    });

    it("reports CPU as % of one core, from two reads a tick apart", async () => {
      const procRoot = await makeProcRoot();
      await setup(procRoot);
      await writeProc(procRoot, 200, { stat: statLine(200, 100, 10, 0), environ: `name=app${NUL}` });
      await writeProc(procRoot, 202, { stat: statLine(202, 200, 100, 50) });
      await writeFile(join(procRoot, "stat"), procStat(1000, 4));
      const cpuState = createPm2CpuState();

      // First read: baseline only, nothing to compare against yet.
      const first = await collectPm2Services({ procRoot, cpuState });
      expect(first[0]!.cpuPct).toBeNull();

      // 400 jiffies pass across 4 cores (= 100 per core); the tree burns 150
      // of them (node 120, npm 30) → 1.5 cores → 150%, same unit as Docker.
      await writeProc(procRoot, 200, { stat: statLine(200, 100, 40, 0) });
      await writeProc(procRoot, 202, { stat: statLine(202, 200, 200, 70) });
      await writeFile(join(procRoot, "stat"), procStat(1400, 4));
      const second = await collectPm2Services({ procRoot, cpuState });
      expect(second[0]!.cpuPct).toBeCloseTo(150);
    });

    // A child that exits and is reaped moves its time into the parent's
    // cutime: the tree total must not drop (a drop would read as negative CPU).
    it("keeps counting a reaped child's time through the parent's cutime", async () => {
      const procRoot = await makeProcRoot();
      await setup(procRoot);
      await writeProc(procRoot, 200, { stat: statLine(200, 100, 0, 0), environ: `name=app${NUL}` });
      await writeProc(procRoot, 202, { stat: statLine(202, 200, 100, 0) });
      await writeFile(join(procRoot, "stat"), procStat(1000, 1));
      const cpuState = createPm2CpuState();
      await collectPm2Services({ procRoot, cpuState });

      // 202 is gone; its 100 + 20 more ticks now sit in 200's cutime.
      await rm(join(procRoot, "202"), { recursive: true });
      await writeProc(procRoot, 200, { stat: statLine(200, 100, 0, 0, "S", 120) });
      await writeFile(join(procRoot, "stat"), procStat(1100, 1));
      const [app] = await collectPm2Services({ procRoot, cpuState });
      expect(app!.cpuPct).toBeCloseTo(20);
    });

    it("has no CPU for an app restarted between two reads (new pid)", async () => {
      const procRoot = await makeProcRoot();
      await setup(procRoot);
      // The new process has MORE ticks than the old one had: a state keyed by
      // name would compute a plausible-looking delta. Only the pid key says no.
      await writeProc(procRoot, 200, { stat: statLine(200, 100, 5, 0), environ: `name=app${NUL}` });
      await writeFile(join(procRoot, "stat"), procStat(1000, 1));
      const cpuState = createPm2CpuState();
      await collectPm2Services({ procRoot, cpuState });

      await rm(join(procRoot, "200"), { recursive: true });
      await writeProc(procRoot, 210, { stat: statLine(210, 100, 50, 0), environ: `name=app${NUL}` });
      await writeFile(join(procRoot, "stat"), procStat(1100, 1));
      const [app] = await collectPm2Services({ procRoot, cpuState });
      expect(app!.cpuPct).toBeNull();
    });
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
