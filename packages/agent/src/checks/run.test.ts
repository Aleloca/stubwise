import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentCheckConfig } from "@stubwise/shared";

import { resetCheckState, runCheck } from "./run.js";

const NUL = "\0";
const UUID = "11111111-1111-1111-1111-111111111111";

function makeConfig(partial: Partial<AgentCheckConfig>): AgentCheckConfig {
  return {
    id: UUID,
    type: "http",
    name: "test",
    target: "http://127.0.0.1:1/",
    intervalSeconds: 60,
    ...partial,
  };
}

/** Listen on an ephemeral port and resolve with it. */
function listen(server: HttpServer | NetServer, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
}

function close(server: HttpServer | NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Reserve then release an ephemeral port so it is (almost surely) closed. */
async function closedPort(): Promise<number> {
  const s = createNetServer();
  const port = await listen(s);
  await close(s);
  return port;
}

describe("runCheck http", () => {
  const servers: HttpServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections?.();
      await close(s);
    }
    resetCheckState();
  });

  it("returns up with latency for a 200 response", async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);
    const port = await listen(server, "127.0.0.1");

    const res = await runCheck(makeConfig({ target: `http://127.0.0.1:${port}/` }), {});
    expect(res.status).toBe("up");
    expect(res.error).toBeNull();
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns down http_500 for a 500 response", async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(server);
    const port = await listen(server, "127.0.0.1");

    const res = await runCheck(makeConfig({ target: `http://127.0.0.1:${port}/` }), {});
    expect(res.status).toBe("down");
    expect(res.error).toBe("http_500");
  });

  it("returns down timeout when the server never responds", async () => {
    const server = createHttpServer(() => {
      /* hang: never respond */
    });
    servers.push(server);
    const port = await listen(server, "127.0.0.1");

    const res = await runCheck(makeConfig({ target: `http://127.0.0.1:${port}/` }), {
      timeoutMs: 200,
    });
    expect(res.status).toBe("down");
    expect(res.error).toBe("timeout");
  });

  it("returns down for a closed port", async () => {
    const port = await closedPort();
    const res = await runCheck(makeConfig({ target: `http://127.0.0.1:${port}/` }), {
      timeoutMs: 500,
    });
    expect(res.status).toBe("down");
    expect(res.error).not.toBeNull();
  });
});

describe("runCheck tcp", () => {
  const servers: NetServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await close(s);
    resetCheckState();
  });

  it("returns up when the port is open", async () => {
    const server = createNetServer();
    servers.push(server);
    const port = await listen(server, "127.0.0.1");

    const res = await runCheck(
      makeConfig({ type: "tcp", target: `127.0.0.1:${port}` }),
      {},
    );
    expect(res.status).toBe("up");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns down when the port is closed", async () => {
    const port = await closedPort();
    const res = await runCheck(
      makeConfig({ type: "tcp", target: `127.0.0.1:${port}` }),
      { timeoutMs: 500 },
    );
    expect(res.status).toBe("down");
    expect(res.error).not.toBeNull();
  });

  it("handles IPv6 bracket notation", async () => {
    const server = createNetServer();
    servers.push(server);
    const port = await listen(server, "::1");

    const res = await runCheck(
      makeConfig({ type: "tcp", target: `[::1]:${port}` }),
      {},
    );
    expect(res.status).toBe("up");
  });
});

describe("runCheck process", () => {
  afterEach(() => resetCheckState());

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

  it("matches a process by cmdline substring and reports memBytes", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "sw-proc-"));
    await writeProc(procRoot, 42, {
      cmdline: `node${NUL}/srv/myapp-server.js${NUL}--port${NUL}3000${NUL}`,
      status: "Name:\tnode\nVmRSS:\t  102400 kB\n",
    });

    const res = await runCheck(
      makeConfig({ type: "process", target: "myapp-server" }),
      { procRoot },
    );
    expect(res.status).toBe("up");
    expect(res.metrics?.memBytes).toBe(102400 * 1024);
  });

  it("returns down no_process_match when nothing matches", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "sw-proc-"));
    await writeProc(procRoot, 42, {
      cmdline: `node${NUL}/srv/other.js${NUL}`,
      status: "VmRSS:\t  1024 kB\n",
    });

    const res = await runCheck(
      makeConfig({ type: "process", target: "does-not-exist" }),
      { procRoot },
    );
    expect(res.status).toBe("down");
    expect(res.error).toBe("no_process_match");
  });
});

describe("runCheck db error branch", () => {
  afterEach(() => resetCheckState());

  it("postgres: unreachable DSN → down without throwing, no DSN in error", async () => {
    const port = await closedPort();
    const dsn = `postgres://user:supersecret@127.0.0.1:${port}/mydb`;
    const res = await runCheck(
      makeConfig({ type: "postgres", target: dsn }),
      { timeoutMs: 500 },
    );
    expect(res.status).toBe("down");
    expect(res.error).not.toBeNull();
    expect(res.error).not.toContain("supersecret");
    expect(res.error).not.toContain(dsn);
  });

  it("mysql: unreachable DSN → down without throwing, no DSN in error", async () => {
    const port = await closedPort();
    const dsn = `mysql://user:supersecret@127.0.0.1:${port}/mydb`;
    const res = await runCheck(
      makeConfig({ type: "mysql", target: dsn }),
      { timeoutMs: 500 },
    );
    expect(res.status).toBe("down");
    expect(res.error).not.toBeNull();
    expect(res.error).not.toContain("supersecret");
    expect(res.error).not.toContain(dsn);
  });
});

describe("runCheck misc", () => {
  afterEach(() => resetCheckState());

  it("unknown check type → down unsupported_check_type", async () => {
    const res = await runCheck(
      makeConfig({ type: "smtp" as AgentCheckConfig["type"] }),
      {},
    );
    expect(res.status).toBe("down");
    expect(res.error).toBe("unsupported_check_type");
  });

  it("uses the injected clock for ts", async () => {
    const port = await closedPort();
    const fixed = new Date("2026-07-13T10:00:00.000Z");
    const res = await runCheck(
      makeConfig({ type: "tcp", target: `127.0.0.1:${port}` }),
      { timeoutMs: 300, now: () => fixed },
    );
    expect(res.ts).toBe(fixed.toISOString());
  });
});
