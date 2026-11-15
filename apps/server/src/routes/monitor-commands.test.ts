import { createPublicKey, randomBytes, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { serverCommands, serverMetrics, serverOperationApprovals, servers, type Db } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { canonicalCommandPayload, type ServerCommandPayload } from "@stubwise/shared";
import { cancelServerCommands, issueServerCommand, ServerCommandError } from "../services/server-commands.js";
import { commandPublicKey } from "../services/server-signing.js";
import { generateServerKey, hashServerKey } from "./shared.js";

/**
 * Area 8, F4b, S3: il canale dei comandi verso l'agente. L'agente li tira
 * con la sua chiave `sk_…` (pull, nessuna porta sull'host); ogni comando è
 * firmato, consegnato UNA volta, scade; l'esito una volta. Le regole:
 * docs/invariants/server-operations.md.
 */

const ENCRYPTION_KEY = randomBytes(32);
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    monitorRateLimit: { max: 10_000, timeWindow: "1 minute" },
  });
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function seedServer(operations: boolean) {
  const key = generateServerKey();
  const [server] = await db
    .insert(servers)
    .values({ name: `srv-${randomBytes(3).toString("hex")}`, keyHash: hashServerKey(key), agentCapabilities: { operations } })
    .returning();
  // L'agente ha visto i container `web` e `db`.
  await db.insert(serverMetrics).values({
    serverId: server!.id,
    ts: new Date(),
    cpuPct: 1,
    load1m: 0,
    memUsedBytes: 1,
    memTotalBytes: 2,
    swapUsedBytes: 0,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    netRxBytes: 0,
    netTxBytes: 0,
    disks: [],
    services: [
      { source: "docker", name: "web", state: "running" },
      { source: "docker", name: "db", state: "running" },
    ] as never,
  });
  return { server: server!, key };
}

async function approval(serverId: string, steps: { action: string; params: Record<string, unknown>; why: string }[]) {
  const { projectId } = await seedRepository(db);
  const { ticketId } = await seedTicket(db, { projectId });
  const [a] = await db.insert(serverOperationApprovals).values({ serverId, taskId: ticketId, steps }).returning();
  return a!.id;
}

const pull = (key: string) => app.inject({ method: "GET", url: "/monitor/commands", headers: { "x-stubwise-server-key": key } });
const result = (key: string, id: string, body: object) =>
  app.inject({ method: "POST", url: `/monitor/commands/${id}/result`, headers: { "x-stubwise-server-key": key }, payload: body });

describe("issueServerCommand: si firma solo ciò che le regole permettono", () => {
  it("una lettura senza approvazione: firmata, verificabile con la pubblica d'istanza", async () => {
    const { server } = await seedServer(true);
    const cmd = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.logs", params: { container: "web", lines: 50, sinceMinutes: 30 } } });
    const [row] = await db.select().from(serverCommands).where(eq(serverCommands.id, cmd.id));
    expect(row).toMatchObject({ kind: "read", status: "pending", approvalId: null });
    const payload: ServerCommandPayload = {
      v: 1,
      serverId: server.id,
      commandId: row!.id,
      action: row!.action,
      params: row!.params,
      approvalId: null,
      issuedAt: row!.issuedAt.toISOString(),
      expiresAt: row!.expiresAt.toISOString(),
    };
    const pub = createPublicKey({ key: Buffer.from(await commandPublicKey(db, ENCRYPTION_KEY), "base64"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(canonicalCommandPayload(payload)), pub, Buffer.from(row!.signature!, "base64"))).toBe(true);
  });

  it("NEGATIVO: un change senza approvazione, con un'approvazione revocata o diversa dal passo, un container mai visto, un'azione fuori dall'insieme → niente firmato", async () => {
    const { server } = await seedServer(true);
    const restartWeb = { action: "container.restart" as const, params: { container: "web", timeoutSeconds: 10 } };
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: restartWeb })).rejects.toBeInstanceOf(ServerCommandError);
    const ok = await approval(server.id, [{ ...restartWeb, why: "riparte" }]);
    // Passo diverso dall'approvato (container o timeout).
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { ...restartWeb, params: { container: "db", timeoutSeconds: 10 } }, approval: { id: ok, stepIndex: 0 } })).rejects.toThrow(/approved/);
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: restartWeb, approval: { id: ok, stepIndex: 1 } })).rejects.toThrow(/approved/);
    // Un container che l'agente non ha visto.
    const ghost = await approval(server.id, [{ action: "container.start", params: { container: "ghost" }, why: "x" }]);
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.start", params: { container: "ghost" } }, approval: { id: ghost, stepIndex: 0 } })).rejects.toThrow(/container/);
    // Fuori dall'insieme (forzando il tipo).
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "image.pull", params: { image: "x" } } as never })).rejects.toBeInstanceOf(ServerCommandError);
    // Revocata.
    await db.update(serverOperationApprovals).set({ revokedAt: new Date() }).where(eq(serverOperationApprovals.id, ok));
    await expect(issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: restartWeb, approval: { id: ok, stepIndex: 0 } })).rejects.toThrow(/revoked/);
    expect(await db.select().from(serverCommands).where(eq(serverCommands.serverId, server.id))).toEqual([]);
  });

  it("un change con l'approvazione e il passo identico: firmato", async () => {
    const { server } = await seedServer(true);
    const step = { action: "container.restart" as const, params: { container: "web", timeoutSeconds: 10 } };
    const a = await approval(server.id, [{ ...step, why: "riparte" }]);
    const cmd = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: step, approval: { id: a, stepIndex: 0 } });
    expect(cmd).toMatchObject({ kind: "change" });
  });
});

describe("il canale: GET /monitor/commands e l'esito", () => {
  it("un agente SENZA operazioni non riceve niente, e il comando non risulta consegnato", async () => {
    const { server, key } = await seedServer(false);
    const cmd = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.state", params: { container: "web" } } });
    const res = await pull(key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ command: null });
    const [row] = await db.select().from(serverCommands).where(eq(serverCommands.id, cmd.id));
    expect(row!.status).toBe("pending");
  });

  it("consegnato UNA volta, anche con due richieste insieme; un altro server non lo vede; poi l'esito una volta", async () => {
    const { server, key } = await seedServer(true);
    const { key: otherKey } = await seedServer(true);
    const cmd = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.state", params: { container: "web" } } });
    expect((await pull(otherKey)).json()).toEqual({ command: null });
    const [a, b] = await Promise.all([pull(key), pull(key)]);
    const got = [a.json(), b.json()].filter((r: { command: unknown }) => r.command !== null) as { command: { payload: ServerCommandPayload; signature: string } }[];
    expect(got).toHaveLength(1);
    expect(got[0]!.command.payload).toMatchObject({ commandId: cmd.id, serverId: server.id, action: "container.state" });
    expect((await pull(key)).json()).toEqual({ command: null });

    expect((await result(otherKey, cmd.id, { exitCode: 0, output: "x" })).statusCode).toBe(404);
    const done = await result(key, cmd.id, { exitCode: 0, output: "running".repeat(5000) });
    expect(done.statusCode).toBe(200);
    const [row] = await db.select().from(serverCommands).where(eq(serverCommands.id, cmd.id));
    expect(row).toMatchObject({ status: "done", exitCode: 0 });
    expect(row!.output!.length).toBeLessThanOrEqual(16 * 1024);
    expect((await result(key, cmd.id, { exitCode: 0, output: "di nuovo" })).statusCode).toBe(409);
  });

  it("un comando scaduto non si consegna mai (diventa `expired`); uno cancellato nemmeno", async () => {
    const { server, key } = await seedServer(true);
    const old = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.state", params: { container: "web" } } });
    await db.update(serverCommands).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(serverCommands.id, old.id));
    const stopped = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: { action: "container.state", params: { container: "db" } } });
    expect(await cancelServerCommands(db, { serverId: server.id })).toBe(1);
    expect((await pull(key)).json()).toEqual({ command: null });
    const rows = await db.select().from(serverCommands).where(eq(serverCommands.serverId, server.id));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [old.id]: "expired", [stopped.id]: "cancelled" });
  });

  it("review F4b, I1: un `change` già firmato la cui approvazione viene revocata dopo (Stop fra ricontrollo e firma) non si consegna MAI: diventa cancelled", async () => {
    const { server, key } = await seedServer(true);
    const step = { action: "container.restart" as const, params: { container: "web", timeoutSeconds: 10 } };
    const a = await approval(server.id, [{ ...step, why: "riparte" }]);
    const cmd = await issueServerCommand(db, ENCRYPTION_KEY, { serverId: server.id, action: step, approval: { id: a, stepIndex: 0 } });
    await db.update(serverOperationApprovals).set({ revokedAt: new Date() }).where(eq(serverOperationApprovals.id, a));
    expect((await pull(key)).json()).toEqual({ command: null });
    expect((await db.select().from(serverCommands).where(eq(serverCommands.id, cmd.id)))[0]!.status).toBe("cancelled");
  });

  it("l'ingest dichiara le operazioni (e senza il campo, spente)", async () => {
    const { server, key } = await seedServer(false);
    const sample = { ts: new Date().toISOString(), cpuPct: 1, load1m: 0, memUsedBytes: 1, memTotalBytes: 2, swapUsedBytes: 0, diskUsedBytes: 1, diskTotalBytes: 2, netRxBytes: 0, netTxBytes: 0, disks: [], services: [] };
    const ingest = (body: object) => app.inject({ method: "POST", url: "/monitor/ingest", headers: { "x-stubwise-server-key": key }, payload: { hostname: "h", agentVersion: "2.0.0", samples: [sample], ...body } });
    expect((await ingest({ capabilities: { operations: true } })).statusCode).toBe(200);
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0]!.agentCapabilities).toMatchObject({ operations: true, version: "2.0.0" });
    expect((await ingest({})).statusCode).toBe(200);
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0]!.agentCapabilities).toMatchObject({ operations: false });
  });
});
