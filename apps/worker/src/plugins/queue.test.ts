import { pluginJobs, plugins, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PluginInventory } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimNextPluginJob,
  completePluginJob,
  failPluginJob,
  MAX_PLUGIN_ATTEMPTS,
  PLUGIN_ERROR_MAX_CHARS,
  recoverStalePluginJobs,
  sanitizePluginError,
} from "./queue.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // plugin_jobs cascade dal plugin.
  await testDb.db.delete(plugins);
});

afterAll(async () => {
  await testDb.stop();
});

const INVENTORY: PluginInventory = {
  name: "demo",
  skills: [{ name: "alpha", bytes: 10 }],
  commands: [],
  agents: [],
  hooks: [],
  hasMcp: false,
};

let counter = 0;

async function insertPlugin(
  db: Db,
  overrides: Partial<typeof plugins.$inferInsert> = {},
): Promise<string> {
  counter++;
  const [row] = await db
    .insert(plugins)
    .values({
      slug: `p-${counter}`,
      name: `plugin ${counter}`,
      sourceUrl: "https://example.com/org/repo.git",
      ref: "main",
      ...overrides,
    })
    .returning({ id: plugins.id });
  return row!.id;
}

interface InsertJobOpts {
  pluginId: string;
  kind?: "materialize" | "smoke";
  status?: "queued" | "running" | "done" | "failed";
  attempts?: number;
  claimedAt?: Date | null;
  createdAt?: Date;
}

async function insertJob(db: Db, opts: InsertJobOpts): Promise<string> {
  const [job] = await db
    .insert(pluginJobs)
    .values({
      pluginId: opts.pluginId,
      kind: opts.kind ?? "materialize",
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.claimedAt !== undefined ? { claimedAt: opts.claimedAt } : {}),
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: pluginJobs.id });
  return job!.id;
}

async function readJob(db: Db, id: string) {
  const [row] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, id));
  return row!;
}

async function readPlugin(db: Db, id: string) {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row!;
}

describe("sanitizePluginError", () => {
  it("redige le credenziali in un URL e tronca al tetto", () => {
    expect(sanitizePluginError("clone https://tizio:segreto@example.com/x fallito")).toContain(
      "https://[REDACTED]@example.com/x",
    );
    const long = sanitizePluginError("x".repeat(PLUGIN_ERROR_MAX_CHARS + 500));
    expect(long.length).toBeLessThan(PLUGIN_ERROR_MAX_CHARS + 100);
    expect(long).toContain("[errore troncato]");
  });
});

describe("claimNextPluginJob", () => {
  it("reclama il job queued più vecchio e lo marca running", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db);
    const older = await insertJob(db, {
      pluginId,
      kind: "materialize",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertJob(db, { pluginId, kind: "smoke" });

    const claimed = await claimNextPluginJob(db);
    expect(claimed?.id).toBe(older);
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimedAt).not.toBeNull();

    const second = await claimNextPluginJob(db);
    expect(second?.kind).toBe("smoke");
    expect(await claimNextPluginJob(db)).toBeNull();
  });

  it("ignora i job non queued", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db);
    await insertJob(db, { pluginId, status: "running", claimedAt: new Date() });
    expect(await claimNextPluginJob(db)).toBeNull();
  });
});

describe("completePluginJob", () => {
  it("chiude il job running come done azzerando l'errore", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db);
    const jobId = await insertJob(db, { pluginId, status: "running", claimedAt: new Date() });

    await completePluginJob(db, jobId);

    const job = await readJob(db, jobId);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
  });

  it("non tocca un job che non è più running (status-guarded)", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db);
    const jobId = await insertJob(db, { pluginId, status: "queued" });

    await completePluginJob(db, jobId);

    expect((await readJob(db, jobId)).status).toBe("queued");
  });
});

describe("failPluginJob", () => {
  it("riflette il fallimento di una materialize su plugins.status preservando il last-known-good", async () => {
    const db = testDb.db;
    const materializedAt = new Date(Date.now() - 3_600_000);
    const pluginId = await insertPlugin(db, {
      status: "materializing",
      resolvedSha: "a".repeat(40),
      inventory: INVENTORY,
      materializedAt,
    });
    const jobId = await insertJob(db, { pluginId, status: "running", claimedAt: new Date() });

    await failPluginJob(db, jobId, "fetch https://tizio:segreto@example.com/x fallito");

    const job = await readJob(db, jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("[REDACTED]");

    const plugin = await readPlugin(db, pluginId);
    expect(plugin.status).toBe("failed");
    expect(plugin.error).toContain("[REDACTED]");
    expect(plugin.error).not.toContain("segreto");
    // Semantica last-known-good: l'ultima materializzazione riuscita resta.
    expect(plugin.resolvedSha).toBe("a".repeat(40));
    expect(plugin.inventory).toEqual(INVENTORY);
    expect(plugin.materializedAt?.getTime()).toBe(materializedAt.getTime());
  });

  it("riflette il fallimento di uno smoke su smokeStatus senza toccare lo stato del plugin", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db, {
      status: "ready",
      smokeStatus: "pending",
      resolvedSha: "b".repeat(40),
      inventory: INVENTORY,
    });
    const jobId = await insertJob(db, {
      pluginId,
      kind: "smoke",
      status: "running",
      claimedAt: new Date(),
    });

    await failPluginJob(db, jobId, "skill mancanti");

    const plugin = await readPlugin(db, pluginId);
    expect(plugin.status).toBe("ready");
    expect(plugin.error).toBeNull();
    expect(plugin.smokeStatus).toBe("failed");
    expect(plugin.smokeError).toContain("skill mancanti");
  });

  it("non scrive nulla se il job non è più running", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db, { status: "ready" });
    const jobId = await insertJob(db, { pluginId, status: "queued" });

    await failPluginJob(db, jobId, "boom");

    expect((await readJob(db, jobId)).status).toBe("queued");
    expect((await readPlugin(db, pluginId)).status).toBe("ready");
  });
});

describe("recoverStalePluginJobs", () => {
  it("riaccoda un running stantio con tentativi residui", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db, { status: "materializing" });
    const jobId = await insertJob(db, {
      pluginId,
      status: "running",
      attempts: 0,
      claimedAt: new Date(Date.now() - 60 * 60_000),
    });

    await recoverStalePluginJobs(db, 15, MAX_PLUGIN_ATTEMPTS);

    const job = await readJob(db, jobId);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.claimedAt).toBeNull();
    // Il plugin resta in materializzazione: il job riparte.
    expect((await readPlugin(db, pluginId)).status).toBe("materializing");
  });

  it("chiude definitivamente il running stantio senza tentativi residui e marca il plugin", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db, { status: "materializing" });
    const jobId = await insertJob(db, {
      pluginId,
      status: "running",
      attempts: MAX_PLUGIN_ATTEMPTS - 1,
      claimedAt: new Date(Date.now() - 60 * 60_000),
    });

    await recoverStalePluginJobs(db, 15, MAX_PLUGIN_ATTEMPTS);

    const job = await readJob(db, jobId);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(MAX_PLUGIN_ATTEMPTS);

    const plugin = await readPlugin(db, pluginId);
    expect(plugin.status).toBe("failed");
    expect(plugin.error).toContain("15");
  });

  it("marca lo smoke come failed quando esaurisce i tentativi", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db, { status: "ready", smokeStatus: "pending" });
    await insertJob(db, {
      pluginId,
      kind: "smoke",
      status: "running",
      attempts: MAX_PLUGIN_ATTEMPTS - 1,
      claimedAt: new Date(Date.now() - 60 * 60_000),
    });

    await recoverStalePluginJobs(db, 15, MAX_PLUGIN_ATTEMPTS);

    const plugin = await readPlugin(db, pluginId);
    expect(plugin.status).toBe("ready");
    expect(plugin.smokeStatus).toBe("failed");
    expect(plugin.smokeError).not.toBeNull();
  });

  it("non tocca i running recenti", async () => {
    const db = testDb.db;
    const pluginId = await insertPlugin(db);
    const jobId = await insertJob(db, {
      pluginId,
      status: "running",
      claimedAt: new Date(),
    });

    await recoverStalePluginJobs(db, 15, MAX_PLUGIN_ATTEMPTS);

    expect((await readJob(db, jobId)).status).toBe("running");
  });
});
