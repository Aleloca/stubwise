import { backlogJobs, projects, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../agent/runner.js";
import { runChatTurn } from "./chat-turn.js";
import { pollChatTurnsOnce, recoverStaleChatTurnJobs, type ChatTurnPollerDeps } from "./chat-turn-poller.js";
import { createCodeSessionRegistry } from "./code-session.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

const explodingRunner: AgentRunner = {
  run: () => {
    throw new Error("il runner non deve essere invocato: runChatTurnFn è iniettato");
  },
};

async function createProject(db: Db): Promise<string> {
  const [p] = await db
    .insert(projects)
    .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  return p!.id;
}

function chatPayload(itemId = randomUUID()) {
  return { itemId, userMessageId: randomUUID(), sessionId: randomUUID() };
}

async function insertChatJob(
  db: Db,
  projectId: string,
  opts: {
    payload?: { itemId: string; userMessageId: string; sessionId: string };
    status?: "queued" | "running";
    startedAt?: Date;
    kind?: "chat_turn" | "intake";
  } = {},
): Promise<string> {
  const [job] = await db
    .insert(backlogJobs)
    .values({
      projectId,
      kind: opts.kind ?? "chat_turn",
      payload: opts.payload ?? chatPayload(),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    })
    .returning({ id: backlogJobs.id });
  return job!.id;
}

async function getJob(db: Db, id: string) {
  const [row] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, id));
  return row!;
}

function makeDeps(db: Db, overrides: Partial<ChatTurnPollerDeps> = {}): ChatTurnPollerDeps {
  return {
    db,
    runner: explodingRunner,
    mirrors: { openWorktree: () => Promise.reject(new Error("mai")) } as ChatTurnPollerDeps["mirrors"],
    serializer: { run: (_p, task) => task() },
    registry: createCodeSessionRegistry(),
    logger: silentLogger,
    encryptionKey: Buffer.alloc(32),
    maxTurns: 15,
    timeoutMs: 1000,
    ...overrides,
  };
}

describe("pollChatTurnsOnce", () => {
  it("esegue un chat_turn e lo chiude done", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload = chatPayload();
    const id = await insertChatJob(db, projectId, { payload });

    const runChatTurnFn = vi.fn<typeof runChatTurn>(async () => {});
    const done = await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));

    expect(done).toBe(1);
    expect(runChatTurnFn).toHaveBeenCalledOnce();
    expect(runChatTurnFn.mock.calls[0]![2]).toEqual(payload);
    expect((await getJob(db, id)).status).toBe("done");
  });

  it("un turno che lancia → failed SENZA retry (resta failed, attempts=1)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const id = await insertChatJob(db, projectId);

    const runChatTurnFn = vi.fn(async () => {
      throw new Error("boom del turno");
    });
    const done = await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));

    expect(done).toBe(0);
    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1); // reclamato una volta, mai riaccodato
    expect(job.error).toContain("boom del turno");
  });

  it("payload malformato → failed subito, niente retry", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    // Payload della forma deep_dive: non combacia con lo schema chat_turn.
    const id = await insertChatJob(db, projectId, {
      payload: { itemId: randomUUID(), repositoryId: randomUUID() } as never,
    });

    const runChatTurnFn = vi.fn(async () => {});
    await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));

    expect(runChatTurnFn).not.toHaveBeenCalled();
    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("payload chat_turn non valido");
  });

  it("NON reclama i job di altri kind (intake resta queued)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const intakeId = await insertChatJob(db, projectId, { kind: "intake", payload: { ticketId: randomUUID() } as never });

    const runChatTurnFn = vi.fn(async () => {});
    const done = await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));

    expect(done).toBe(0);
    expect((await getJob(db, intakeId)).status).toBe("queued");
  });

  it("serializza i turni della STESSA voce (nessuna sovrapposizione)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const itemId = randomUUID();
    await insertChatJob(db, projectId, { payload: chatPayload(itemId) });
    await insertChatJob(db, projectId, { payload: chatPayload(itemId) });

    let active = 0;
    let maxConcurrent = 0;
    const runChatTurnFn = vi.fn(async () => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
    });

    const done = await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));
    expect(done).toBe(2);
    // Mai due turni della stessa voce in parallelo.
    expect(maxConcurrent).toBe(1);
  });

  it("turni di VOCI DIVERSE procedono in parallelo", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await insertChatJob(db, projectId, { payload: chatPayload(randomUUID()) });
    await insertChatJob(db, projectId, { payload: chatPayload(randomUUID()) });

    // Barrier deterministica (niente timing): un turno NON può finire finché
    // l'altro non è entrato. Se i due NON girassero in parallelo il primo
    // resterebbe bloccato per sempre (nessuno rilascerebbe il gate) → timeout.
    let entered = 0;
    let releaseAll = (): void => {};
    const gate = new Promise<void>((r) => (releaseAll = r));
    let maxConcurrent = 0;
    const runChatTurnFn = vi.fn(async () => {
      entered++;
      maxConcurrent = Math.max(maxConcurrent, entered);
      if (entered === 2) releaseAll();
      await gate;
      entered--;
    });

    await pollChatTurnsOnce(makeDeps(db, { runChatTurnFn }));
    // Voci diverse: entrambi entrati prima che uno finisse ⇒ sovrapposizione.
    expect(maxConcurrent).toBe(2);
  });
});

describe("recoverStaleChatTurnJobs", () => {
  it("fallisce (senza retry) i chat_turn running orfani oltre la soglia", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const stale = new Date(Date.now() - 60 * 60_000);
    const id = await insertChatJob(db, projectId, { status: "running", startedAt: stale });

    await recoverStaleChatTurnJobs(db, 15);

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("worker crash");
  });

  it("non tocca i running recenti né gli altri kind", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const recent = await insertChatJob(db, projectId, { status: "running", startedAt: new Date() });
    const intakeStale = await insertChatJob(db, projectId, {
      kind: "intake",
      payload: { ticketId: randomUUID() } as never,
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    await recoverStaleChatTurnJobs(db, 15);

    expect((await getJob(db, recent)).status).toBe("running");
    expect((await getJob(db, intakeStale)).status).toBe("running"); // altro kind: non toccato
  });
});
