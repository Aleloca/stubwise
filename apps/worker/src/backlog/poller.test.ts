import { backlogJobs, projects, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { BacklogJobPayload } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../agent/runner.js";
import { createProjectSerializer } from "../handler.js";
import {
  claimNextBacklogJob,
  claimNextChatTurnJob,
  MAX_BACKLOG_ATTEMPTS,
  pollBacklogJobsOnce,
  recoverStaleBacklogJobs,
  type BacklogLogger,
  type BacklogPollerDeps,
  type RunDeepDiveFn,
  type RunEstimateFn,
  type RunIntakeFn,
} from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // backlog_jobs cascano dal progetto.
});

afterAll(async () => {
  await testDb.stop();
});

/** Logger che inghiotte tutto (i test non asseriscono sui log). */
const silentLogger: BacklogLogger = { warn: () => {}, error: () => {} };

/** Runner che esplode se chiamato: i test di coda non arrivano mai all'agente. */
const explodingRunner: AgentRunner = {
  run: () => {
    throw new Error("il runner non deve essere invocato nei test della coda");
  },
};

async function createProject(db: Db): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ name: "Backlog", slug: `bl-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  return project!.id;
}

interface InsertJobOpts {
  projectId: string;
  kind?: "intake" | "deep_dive" | "chat_turn" | "estimate";
  payload?: BacklogJobPayload;
  status?: "queued" | "running" | "done" | "failed";
  attempts?: number;
  startedAt?: Date | null;
}

async function insertJob(db: Db, opts: InsertJobOpts): Promise<string> {
  const [job] = await db
    .insert(backlogJobs)
    .values({
      projectId: opts.projectId,
      kind: opts.kind ?? "intake",
      payload: opts.payload ?? { ticketId: randomUUID() },
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    })
    .returning({ id: backlogJobs.id });
  return job!.id;
}

async function getJob(db: Db, id: string): Promise<typeof backlogJobs.$inferSelect> {
  const [row] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, id));
  return row!;
}

/** Mirror stub: i test della coda non arrivano mai al mirror (deep dive iniettato). */
const explodingMirrors: BacklogPollerDeps["mirrors"] = {
  resolveDefaultBranchHead: () => {
    throw new Error("il mirror non deve essere usato nei test della coda");
  },
  withWorktreeAtSha: () => {
    throw new Error("il mirror non deve essere usato nei test della coda");
  },
};

/** Deps del poller con default innocui; ogni test sovrascrive ciò che serve. */
function makeDeps(db: Db, overrides: Partial<BacklogPollerDeps> = {}): BacklogPollerDeps {
  return {
    db,
    embeddingClient: { embed: async () => [] },
    runner: explodingRunner,
    mirrors: explodingMirrors,
    serializer: createProjectSerializer(),
    logger: silentLogger,
    encryptionKey: Buffer.alloc(32),
    mergeThreshold: 0.9,
    similarThreshold: 0.78,
    agentTimeoutMs: 1000,
    deepDiveMaxTurns: 30,
    workDir: "/tmp",
    // Il deep dive reale è coperto da deep-dive.test.ts: nella coda lo iniettiamo
    // così i test non montano worktree né chiamano l'agente.
    runDeepDiveFn: () => {
      throw new Error("il deep dive reale non deve girare nei test della coda");
    },
    // Idem per l'estimate reale (coperto da estimate.test.ts).
    runEstimateFn: () => {
      throw new Error("l'estimate reale non deve girare nei test della coda");
    },
    ...overrides,
  };
}

describe("claimNextBacklogJob", () => {
  it("marca running, incrementa attempts e valorizza startedAt", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const id = await insertJob(db, { projectId });

    const claimed = await claimNextBacklogJob(db);
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.startedAt).not.toBeNull();
  });

  it("è FIFO su created_at e restituisce null a coda vuota", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const first = await insertJob(db, { projectId });
    // Il secondo job ha created_at più recente (default now()): il claim prende prima il primo.
    await new Promise((r) => setTimeout(r, 5));
    await insertJob(db, { projectId });

    const a = await claimNextBacklogJob(db);
    expect(a?.id).toBe(first);
    const b = await claimNextBacklogJob(db);
    expect(b?.id).not.toBe(first);
    const c = await claimNextBacklogJob(db);
    expect(c).toBeNull();
  });

  it("due claim concorrenti su due job prendono righe diverse (SKIP LOCKED)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await insertJob(db, { projectId });
    await insertJob(db, { projectId });

    const [a, b] = await Promise.all([claimNextBacklogJob(db), claimNextBacklogJob(db)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("due claim concorrenti su un solo job: uno lo prende, l'altro null", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await insertJob(db, { projectId });

    const results = await Promise.all([claimNextBacklogJob(db), claimNextBacklogJob(db)]);
    const nonNull = results.filter((r) => r !== null);
    const nulls = results.filter((r) => r === null);
    expect(nonNull).toHaveLength(1);
    expect(nulls).toHaveLength(1);
  });
});

describe("claim per kind (poller lento ↔ poller veloce)", () => {
  const chatPayload = () => ({
    itemId: randomUUID(),
    userMessageId: randomUUID(),
    sessionId: randomUUID(),
  });

  it("claimNextBacklogJob NON reclama i chat_turn (solo intake/deep_dive)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const chatId = await insertJob(db, { projectId, kind: "chat_turn", payload: chatPayload() });

    // Solo un chat_turn in coda: il claim lento non deve prenderlo.
    expect(await claimNextBacklogJob(db)).toBeNull();
    // Ma il claim veloce sì.
    const chat = await claimNextChatTurnJob(db);
    expect(chat?.id).toBe(chatId);
  });

  it("claimNextBacklogJob reclama anche gli estimate (poller lento)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const estimateId = await insertJob(db, {
      projectId,
      kind: "estimate",
      payload: { itemId: randomUUID() },
    });

    const claimed = await claimNextBacklogJob(db);
    expect(claimed?.id).toBe(estimateId);
    // Il claim veloce NON deve prenderlo.
    expect(await claimNextChatTurnJob(db)).toBeNull();
  });

  it("claimNextChatTurnJob NON reclama intake/deep_dive (solo chat_turn)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const intakeId = await insertJob(db, { projectId, kind: "intake" });

    // Solo un intake in coda: il claim veloce non deve prenderlo.
    expect(await claimNextChatTurnJob(db)).toBeNull();
    // Ma il claim lento sì.
    const intake = await claimNextBacklogJob(db);
    expect(intake?.id).toBe(intakeId);
  });

  it("con code kind mescolati ognuno prende solo il proprio", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const intakeId = await insertJob(db, { projectId, kind: "intake" });
    const chatId = await insertJob(db, { projectId, kind: "chat_turn", payload: chatPayload() });

    const chat = await claimNextChatTurnJob(db);
    const slow = await claimNextBacklogJob(db);
    expect(chat?.id).toBe(chatId);
    expect(slow?.id).toBe(intakeId);
    // Entrambe le code ora vuote (per il rispettivo kind).
    expect(await claimNextChatTurnJob(db)).toBeNull();
    expect(await claimNextBacklogJob(db)).toBeNull();
  });

  it("claimNextChatTurnJob è FIFO su created_at (con tiebreaker), marca running e incrementa attempts", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const first = await insertJob(db, { projectId, kind: "chat_turn", payload: chatPayload() });
    await new Promise((r) => setTimeout(r, 5));
    await insertJob(db, { projectId, kind: "chat_turn", payload: chatPayload() });

    const a = await claimNextChatTurnJob(db);
    expect(a?.id).toBe(first);
    expect(a?.status).toBe("running");
    expect(a?.attempts).toBe(1);
    const b = await claimNextChatTurnJob(db);
    expect(b?.id).not.toBe(first);
    expect(await claimNextChatTurnJob(db)).toBeNull();
  });
});

describe("recoverStaleBacklogJobs", () => {
  it("riaccoda gli orfani con tentativi residui e azzera startedAt", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const stale = new Date(Date.now() - 60 * 60 * 1000); // 1h fa
    const id = await insertJob(db, {
      projectId,
      status: "running",
      attempts: 1,
      startedAt: stale,
    });

    await recoverStaleBacklogJobs(db, 15, MAX_BACKLOG_ATTEMPTS);

    const job = await getJob(db, id);
    expect(job.status).toBe("queued");
    expect(job.startedAt).toBeNull();
  });

  it("fallisce gli orfani coi tentativi esauriti", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const id = await insertJob(db, {
      projectId,
      status: "running",
      attempts: MAX_BACKLOG_ATTEMPTS,
      startedAt: stale,
    });

    await recoverStaleBacklogJobs(db, 15, MAX_BACKLOG_ATTEMPTS);

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("max attempts");
  });

  it("non tocca i running recenti (entro la soglia)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const id = await insertJob(db, {
      projectId,
      status: "running",
      attempts: 1,
      startedAt: new Date(),
    });

    await recoverStaleBacklogJobs(db, 15, MAX_BACKLOG_ATTEMPTS);

    const job = await getJob(db, id);
    expect(job.status).toBe("running");
  });

  it("NON tocca gli orfani chat_turn (ciclo di vita del solo fast poller)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    // chat_turn orfano con tentativi residui: il poller lento NON deve
    // riaccodarlo (violerebbe "un turno non si retry-a").
    const requeuable = await insertJob(db, {
      projectId,
      kind: "chat_turn",
      payload: { itemId: randomUUID(), userMessageId: randomUUID(), sessionId: randomUUID() },
      status: "running",
      attempts: 1,
      startedAt: stale,
    });
    // chat_turn orfano coi tentativi esauriti: nemmeno failed dal poller lento.
    const exhausted = await insertJob(db, {
      projectId,
      kind: "chat_turn",
      payload: { itemId: randomUUID(), userMessageId: randomUUID(), sessionId: randomUUID() },
      status: "running",
      attempts: MAX_BACKLOG_ATTEMPTS,
      startedAt: stale,
    });
    // Controllo: un intake orfano nello stesso tick DEVE essere recuperato.
    const intake = await insertJob(db, {
      projectId,
      kind: "intake",
      status: "running",
      attempts: 1,
      startedAt: stale,
    });

    await recoverStaleBacklogJobs(db, 15, MAX_BACKLOG_ATTEMPTS);

    // I chat_turn restano intatti (running): li gestisce recoverStaleChatTurnJobs.
    expect((await getJob(db, requeuable)).status).toBe("running");
    expect((await getJob(db, exhausted)).status).toBe("running");
    // L'intake orfano è invece recuperato come prima.
    expect((await getJob(db, intake)).status).toBe("queued");
  });
});

describe("pollBacklogJobsOnce", () => {
  it("smista un job intake a runIntakeFn e lo chiude done", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const ticketId = randomUUID();
    const id = await insertJob(db, { projectId, kind: "intake", payload: { ticketId } });

    const runIntakeFn = vi.fn<RunIntakeFn>(async () => {});
    const done = await pollBacklogJobsOnce(makeDeps(db, { runIntakeFn }));

    expect(done).toBe(1);
    expect(runIntakeFn).toHaveBeenCalledOnce();
    // Il payload passato all'intake è quello parsato (forma da ticket).
    expect(runIntakeFn.mock.calls[0]![2]).toEqual({ ticketId });
    const job = await getJob(db, id);
    expect(job.status).toBe("done");
    expect(job.finishedAt).not.toBeNull();
  });

  it("smista intake manuale (title/body) senza toccare un ticket", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const id = await insertJob(db, {
      projectId,
      kind: "intake",
      payload: { title: "Idea", body: "Corpo" },
    });

    const runIntakeFn = vi.fn<RunIntakeFn>(async () => {});
    await pollBacklogJobsOnce(makeDeps(db, { runIntakeFn }));

    expect(runIntakeFn.mock.calls[0]![2]).toEqual({ title: "Idea", body: "Corpo" });
    expect((await getJob(db, id)).status).toBe("done");
  });

  it("smista un job deep_dive a runDeepDiveFn e lo chiude done", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const payload = { itemId: randomUUID(), repositoryId: randomUUID() };
    const id = await insertJob(db, { projectId, kind: "deep_dive", payload });

    const runDeepDiveFn = vi.fn<RunDeepDiveFn>(async () => {});
    await pollBacklogJobsOnce(makeDeps(db, { runDeepDiveFn }));

    expect(runDeepDiveFn.mock.calls[0]![2]).toEqual(payload);
    expect((await getJob(db, id)).status).toBe("done");
  });

  it("smista un job estimate a runEstimateFn e lo chiude done", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const itemId = randomUUID();
    const id = await insertJob(db, { projectId, kind: "estimate", payload: { itemId } });

    const runEstimateFn = vi.fn<RunEstimateFn>(async () => {});
    const done = await pollBacklogJobsOnce(makeDeps(db, { runEstimateFn }));

    expect(done).toBe(1);
    expect(runEstimateFn).toHaveBeenCalledOnce();
    expect(runEstimateFn.mock.calls[0]![2]).toEqual({ itemId });
    expect((await getJob(db, id)).status).toBe("done");
  });

  it("estimate con payload malformato → failed subito, niente retry", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    // kind estimate ma payload vuoto: non combacia con backlogEstimatePayloadSchema.
    const id = await insertJob(db, {
      projectId,
      kind: "estimate",
      payload: {} as unknown as BacklogJobPayload,
    });

    await pollBacklogJobsOnce(makeDeps(db));

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1); // un solo tentativo, nessun riaccodamento
    expect(job.error).toContain("payload estimate non valido");
  });

  it("deep_dive che lancia → riaccodato (tentativi residui)", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    const id = await insertJob(db, {
      projectId,
      kind: "deep_dive",
      payload: { itemId: randomUUID(), repositoryId: randomUUID() },
    });

    const runDeepDiveFn = vi.fn<RunDeepDiveFn>(async () => {
      throw new Error("boom del deep dive");
    });
    const done = await pollBacklogJobsOnce(makeDeps(db, { runDeepDiveFn }));

    expect(done).toBe(0);
    const job = await getJob(db, id);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.error).toContain("boom del deep dive");
  });

  it("payload malformato → failed subito, niente retry", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    // kind intake ma payload della forma deep_dive: non combacia con la union intake.
    const id = await insertJob(db, {
      projectId,
      kind: "intake",
      payload: { itemId: randomUUID(), repositoryId: randomUUID() } as unknown as BacklogJobPayload,
    });

    await pollBacklogJobsOnce(makeDeps(db));

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1); // un solo tentativo, nessun riaccodamento
    expect(job.error).toContain("payload intake non valido");
  });

  it("un intake che lancia all'ultimo tentativo → failed", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    // attempts già a MAX-1: il claim lo porta a MAX, un throw lo fa fallire.
    const id = await insertJob(db, {
      projectId,
      kind: "intake",
      payload: { ticketId: randomUUID() },
      attempts: MAX_BACKLOG_ATTEMPTS - 1,
    });

    const runIntakeFn = vi.fn<RunIntakeFn>(async () => {
      throw new Error("boom");
    });
    await pollBacklogJobsOnce(makeDeps(db, { runIntakeFn }));

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("max attempts");
    expect(job.error).toContain("boom");
  });

  it("drena più job queued in un solo tick", async () => {
    const db = testDb.db;
    const projectId = await createProject(db);
    await insertJob(db, { projectId, payload: { ticketId: randomUUID() } });
    await insertJob(db, { projectId, payload: { ticketId: randomUUID() } });
    await insertJob(db, { projectId, payload: { ticketId: randomUUID() } });

    const runIntakeFn = vi.fn<RunIntakeFn>(async () => {});
    const done = await pollBacklogJobsOnce(makeDeps(db, { runIntakeFn }));

    expect(done).toBe(3);
    expect(runIntakeFn).toHaveBeenCalledTimes(3);
  });
});
