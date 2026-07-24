import { backlogItems, projects, type Db, type EmbeddingProvider } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { BacklogItemStatus } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import { runEstimate } from "./estimate.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // tutto casca dal progetto.
});

afterAll(async () => {
  await testDb.stop();
});

const DIM = 1024;

/** Vettore 1024-dim con valori assegnati a indici scelti (resto 0). */
function vec(entries: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  return v;
}

const vecA = vec({ 0: 1 });

/** Embedding client controllato: mappa testo → vettore (default: vecA). */
function embeddingClient(map: Record<string, number[]>): EmbeddingProvider {
  return { embed: async (inputs) => inputs.map((t) => map[t] ?? vecA) };
}

/** Runner che restituisce un output fisso (default exit 0). */
function fakeRunner(output: string, exitCode = 0): AgentRunner {
  const result: AgentRunResult = { output, exitCode };
  return { run: vi.fn(async () => result) };
}

const silentLogger = { warn: () => {}, error: () => {} };

/** Mirror stub: l'estimate non usa il mirror (solo il deep dive). */
const stubMirrors: BacklogDeps["mirrors"] = {
  resolveDefaultBranchHead: async () => {
    throw new Error("l'estimate non deve usare il mirror");
  },
  withWorktreeAtSha: async () => {
    throw new Error("l'estimate non deve usare il mirror");
  },
};

function makeDeps(db: Db, overrides: Partial<BacklogDeps>): BacklogDeps {
  return {
    db,
    embeddingClient: embeddingClient({}),
    runner: fakeRunner("{}"),
    mirrors: stubMirrors,
    serializer: { run: (_p, task) => task() },
    logger: silentLogger,
    encryptionKey: Buffer.alloc(32),
    mergeThreshold: 0.9,
    similarThreshold: 0.78,
    agentTimeoutMs: 1000,
    deepDiveMaxTurns: 30,
    workDir: "/tmp",
    ...overrides,
  };
}

async function createProject(db: Db): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ name: "Backlog", slug: `bl-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  return project!.id;
}

/** Voce "from-design": documento verbatim, stime ed embedding NULL. */
async function createItem(
  db: Db,
  projectId: string,
  opts: { document: string; status?: BacklogItemStatus },
): Promise<string> {
  const [item] = await db
    .insert(backlogItems)
    .values({
      projectId,
      title: "Voce da design",
      document: opts.document,
      source: "manual",
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning({ id: backlogItems.id });
  return item!.id;
}

/** Job fittizio estimate (il poller ha già reclamato: qui conta projectId/kind/payload). */
function fakeJob(projectId: string, itemId: string): BacklogJob {
  return {
    id: randomUUID(),
    projectId,
    kind: "estimate",
    status: "running",
    payload: { itemId },
    attempts: 1,
    error: null,
    resultItemId: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

const ESTIMATE_JSON = JSON.stringify({
  effort: 4,
  risk: "high",
  riskNote: "tocca la pipeline di pagamento",
  urgency: "urgent",
});

describe("runEstimate", () => {
  it("scrive i metadati diretti + embedding SENZA toccare il documento", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const document = "## Contesto\nun design pronto\n## Cosa fare\nx";
    const itemId = await createItem(db, projectId, { document });

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [document]: vecA }),
      runner: fakeRunner(ESTIMATE_JSON),
    });
    await runEstimate(deps, fakeJob(projectId, itemId), { itemId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.effort).toBe(4);
    expect(item!.risk).toBe("high");
    expect(item!.riskNote).toBe("tocca la pipeline di pagamento");
    expect(item!.urgency).toBe("urgent");
    expect(item!.embedding).toEqual(vecA);
    // Il documento e il titolo NON sono stati toccati.
    expect(item!.document).toBe(document);
    expect(item!.title).toBe("Voce da design");
    // Metadati DIRETTI, non in suggested.
    expect(item!.suggested).toBeNull();
  });

  it("riskNote assente nell'output → salvato null", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const document = "## Contesto\nbasso rischio";
    const itemId = await createItem(db, projectId, { document });

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [document]: vecA }),
      runner: fakeRunner(JSON.stringify({ effort: 1, risk: "low", urgency: "low" })),
    });
    await runEstimate(deps, fakeJob(projectId, itemId), { itemId });

    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.effort).toBe(1);
    expect(item!.risk).toBe("low");
    expect(item!.riskNote).toBeNull();
    expect(item!.urgency).toBe("low");
  });

  it("output agente non-JSON → lancia, la voce resta senza stime", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const document = "## Contesto\nx";
    const itemId = await createItem(db, projectId, { document });

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [document]: vecA }),
      runner: fakeRunner("non è affatto JSON"),
    });

    await expect(runEstimate(deps, fakeJob(projectId, itemId), { itemId })).rejects.toThrow(
      /non parsabile/,
    );
    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.effort).toBeNull();
    expect(item!.risk).toBeNull();
    expect(item!.embedding).toBeNull();
  });

  it("agente exit ≠ 0 → lancia", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const document = "## Contesto\nx";
    const itemId = await createItem(db, projectId, { document });

    const deps = makeDeps(db, {
      embeddingClient: embeddingClient({ [document]: vecA }),
      runner: fakeRunner(ESTIMATE_JSON, 1),
    });

    await expect(runEstimate(deps, fakeJob(projectId, itemId), { itemId })).rejects.toThrow(
      /exit 1/,
    );
  });

  it("voce inesistente → no-op, agente mai invocato", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const runner = fakeRunner(ESTIMATE_JSON);
    const deps = makeDeps(db, { runner });

    await runEstimate(deps, fakeJob(projectId, randomUUID()), { itemId: randomUUID() });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("voce già chiusa (converted) → no-op, agente mai invocato, stime intatte", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const document = "## Contesto\nx";
    const itemId = await createItem(db, projectId, { document, status: "converted" });

    const runner = fakeRunner(ESTIMATE_JSON);
    const deps = makeDeps(db, { runner });
    await runEstimate(deps, fakeJob(projectId, itemId), { itemId });

    expect(runner.run).not.toHaveBeenCalled();
    const [item] = await db.select().from(backlogItems).where(eq(backlogItems.id, itemId));
    expect(item!.effort).toBeNull();
    expect(item!.embedding).toBeNull();
  });
});
