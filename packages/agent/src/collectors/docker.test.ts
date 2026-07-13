import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectDockerServices } from "./docker.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../test/fixtures/docker/${name}`, import.meta.url)),
    "utf8",
  );

const containersJson = fixture("containers.json");
const statsServerJson = fixture("stats-server.json");

/**
 * Fake Docker Engine on a temporary Unix socket. `/containers/json` returns the
 * fixture body (overridable to exercise the malformed-list path); the first
 * container's stats resolve to the fixture, the second's return HTTP 500 to
 * exercise the null-metrics path, anything else 404s.
 */
function startFakeDocker(listBody: string = containersJson): {
  socketPath: string;
  ready: Promise<void>;
  close: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "sw-dk-"));
  const socketPath = join(dir, "d.sock");
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/containers/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(listBody);
    } else if (url.startsWith("/containers/aaaa1111/stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(statsServerJson);
    } else if (url.startsWith("/containers/bbbb2222/stats")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"message":"boom"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const ready = new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        rmSync(dir, { recursive: true, force: true });
        resolve();
      }),
    );
  return { socketPath, ready, close };
}

describe("collectDockerServices", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("lists containers with docker-formula cpu/mem computed", async () => {
    const fake = startFakeDocker();
    cleanup = fake.close;
    await fake.ready;

    const services = await collectDockerServices({ socketPath: fake.socketPath });

    expect(services).toHaveLength(3);

    const srv = services.find((s) => s.name === "stubwise-server");
    expect(srv).toBeDefined();
    expect(srv!.source).toBe("docker");
    expect(srv!.state).toBe("running");
    expect(srv!.restarts).toBeNull();
    // cpuDelta = 200000000 - 100000000 = 100000000
    // systemDelta = 2000000000 - 1000000000 = 1000000000
    // pct = 100000000 / 1000000000 * 4 * 100 = 0.1 * 4 * 100 = 40
    expect(srv!.cpuPct).toBeCloseTo(40, 6);
    // mem = usage 1073741824 - inactive_file 73741824 = 1000000000
    expect(srv!.memBytes).toBe(1000000000);

    // Second container: stats endpoint 500 → present but null metrics.
    const worker = services.find((s) => s.name === "stubwise-worker");
    expect(worker).toBeDefined();
    expect(worker!.cpuPct).toBeNull();
    expect(worker!.memBytes).toBeNull();
    expect(worker!.state).toBe("running");
  });

  it("truncates names longer than the 200-char ingest contract", async () => {
    const fake = startFakeDocker();
    cleanup = fake.close;
    await fake.ready;

    const services = await collectDockerServices({ socketPath: fake.socketPath });

    // Fixture container cccc3333 has a 250-char name (25× "0123456789"):
    // it must survive truncated to the first 200 chars.
    const long = services.find((s) => s.name.startsWith("0123456789"));
    expect(long).toBeDefined();
    expect(long!.name).toHaveLength(200);
    expect(long!.name).toBe("0123456789".repeat(20));
  });

  it("returns [] when the socket does not exist (no throw)", async () => {
    const socketPath = join(tmpdir(), "sw-dk-nonexistent.sock");
    const services = await collectDockerServices({ socketPath, timeoutMs: 1000 });
    expect(services).toEqual([]);
  });

  it("returns [] when the container list is 200 but not an array", async () => {
    const fake = startFakeDocker('{"message":"not a list"}');
    cleanup = fake.close;
    await fake.ready;

    const services = await collectDockerServices({ socketPath: fake.socketPath });
    expect(services).toEqual([]);
  });
});
