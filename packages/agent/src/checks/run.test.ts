import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentCheckConfig } from "@stubwise/shared";

import { computeRate, pruneCheckState, resetCheckState, runCheck } from "./run.js";

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

/**
 * TCP server that ACCEPTS connections but never sends a byte: simulates a DB
 * server that stalls after the TCP handshake (the worst case for the check
 * budget — the connect succeeds so connect-timeouts never fire).
 */
async function withStallServer(fn: (port: number) => Promise<void>): Promise<void> {
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    // Swallow errors from abrupt client destroys (ECONNRESET) — irrelevant here.
    socket.on("error", () => {});
  });
  const port = await listen(server, "127.0.0.1");
  try {
    await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
  }
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

  it("returns down invalid_target for a malformed target", async () => {
    for (const target of ["no-port-here", "host:", "host:80abc", "[::1", "[::1]80"]) {
      const res = await runCheck(makeConfig({ type: "tcp", target }), {});
      expect(res.status).toBe("down");
      expect(res.error).toBe("invalid_target");
    }
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

  it("postgres: server accepts then stalls → down timeout within the budget", async () => {
    await withStallServer(async (port) => {
      const start = Date.now();
      const res = await runCheck(
        makeConfig({ type: "postgres", target: `postgres://u:p@127.0.0.1:${port}/db` }),
        { timeoutMs: 300 },
      );
      expect(res.status).toBe("down");
      expect(res.error).toBe("timeout");
      // Must settle around timeoutMs, NOT hang on the stalled query/connection.
      expect(Date.now() - start).toBeLessThan(2_000);
    });
  });

  it("mysql: server accepts then stalls → down timeout within the budget", async () => {
    await withStallServer(async (port) => {
      const start = Date.now();
      const res = await runCheck(
        makeConfig({ type: "mysql", target: `mysql://u:p@127.0.0.1:${port}/db` }),
        { timeoutMs: 300 },
      );
      expect(res.status).toBe("down");
      expect(res.error).toBe("timeout");
      expect(Date.now() - start).toBeLessThan(2_000);
    });
  });
});

describe("computeRate", () => {
  afterEach(() => resetCheckState());

  it("returns null on the first run, the per-second rate after", () => {
    expect(computeRate("id-1", 100, 1_000)).toBeNull();
    expect(computeRate("id-1", 110, 4_000)).toBe(3.33); // 10 / 3s, 2 decimals
  });

  it("returns null on a counter reset (server restart) then resumes", () => {
    expect(computeRate("id-2", 100, 1_000)).toBeNull();
    expect(computeRate("id-2", 50, 2_000)).toBeNull(); // negative delta
    expect(computeRate("id-2", 53, 3_000)).toBe(3);
  });

  it("returns null on a non-positive time delta", () => {
    expect(computeRate("id-3", 100, 1_000)).toBeNull();
    expect(computeRate("id-3", 200, 1_000)).toBeNull();
  });
});

describe("pruneCheckState", () => {
  afterEach(() => resetCheckState());

  it("drops state for checks not in the active set", () => {
    computeRate("keep", 10, 1_000);
    computeRate("drop", 10, 1_000);
    pruneCheckState(new Set(["keep"]));
    expect(computeRate("keep", 20, 2_000)).toBe(10); // state survived
    expect(computeRate("drop", 20, 2_000)).toBeNull(); // state pruned → first run
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

  it("truncates the error message to 500 chars", async () => {
    // A nonexistent procRoot with a very long path: the ENOENT message echoes
    // the full path, producing an error well over the 500-char schema cap.
    const procRoot = join(tmpdir(), "sw-missing", "x".repeat(600));
    const res = await runCheck(
      makeConfig({ type: "process", target: "anything" }),
      { procRoot },
    );
    expect(res.status).toBe("down");
    expect(res.error).not.toBeNull();
    expect(res.error!.length).toBeLessThanOrEqual(500);
    expect(res.error).toContain("ENOENT");
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
