import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { agentRuns, aiJobs, aiProviders } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let ticketId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);

  const { projectId, repositoryId } = await seedRepository(testDb.db);

  const ticketRes = await app.inject({
    method: "POST",
    url: "/api/tickets",
    headers: { cookie: users.memberCookie },
    payload: { projectId, repositoryId, title: "Crash al checkout", type: "bug" },
  });
  expect(ticketRes.statusCode).toBe(201);
  ticketId = (ticketRes.json() as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function listJobs(id: string, cookie?: string) {
  return app.inject({
    method: "GET",
    url: `/api/tickets/${id}/jobs`,
    headers: cookie ? { cookie } : {},
  });
}

describe("GET /api/tickets/:ticketId/jobs", () => {
  it("senza sessione risponde 401", async () => {
    const res = await listJobs(ticketId);
    expect(res.statusCode).toBe(401);
  });

  it("ticket inesistente: 404", async () => {
    const res = await listJobs(randomUUID(), users.memberCookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "ticket_not_found", message: "Ticket not found" });
  });

  it("ticket senza job: lista vuota", async () => {
    const res = await listJobs(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("restituisce i job del ticket dal più recente, con date ISO e null espliciti", async () => {
    // Inseriti direttamente: i job li crea la pipeline (Task 19+), qui non
    // esiste ancora una API di scrittura.
    const [queued] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, createdAt: new Date("2026-06-01T10:00:00Z") })
      .returning();
    const [opened] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "pr_opened",
        log: "triage ok\nfix applicato",
        prUrl: "https://github.com/acme/progetto-jobs/pull/7",
        createdAt: new Date("2026-06-02T10:00:00Z"),
        startedAt: new Date("2026-06-02T10:00:05Z"),
        finishedAt: new Date("2026-06-02T10:03:00Z"),
      })
      .returning();
    const [failed] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "failed",
        log: "clone fallito",
        error: "git clone: timeout",
        createdAt: new Date("2026-06-03T10:00:00Z"),
        startedAt: new Date("2026-06-03T10:00:02Z"),
        finishedAt: new Date("2026-06-03T10:00:40Z"),
      })
      .returning();
    expect(queued && opened && failed).toBeTruthy();

    const res = await listJobs(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body.map((job) => job["id"])).toEqual([failed!.id, opened!.id, queued!.id]);
    expect(body[0]).toEqual({
      id: failed!.id,
      ticketId,
      status: "failed",
      log: "clone fallito",
      prUrl: null,
      error: "git clone: timeout",
      createdAt: "2026-06-03T10:00:00.000Z",
      startedAt: "2026-06-03T10:00:02.000Z",
      finishedAt: "2026-06-03T10:00:40.000Z",
      providerLabel: null,
      providerKind: null,
    });
    expect(body[1]).toEqual({
      id: opened!.id,
      ticketId,
      status: "pr_opened",
      log: "triage ok\nfix applicato",
      prUrl: "https://github.com/acme/progetto-jobs/pull/7",
      error: null,
      createdAt: "2026-06-02T10:00:00.000Z",
      startedAt: "2026-06-02T10:00:05.000Z",
      finishedAt: "2026-06-02T10:03:00.000Z",
      providerLabel: null,
      providerKind: null,
    });
    expect(body[2]).toMatchObject({
      id: queued!.id,
      status: "queued",
      log: "",
      prUrl: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      providerLabel: null,
      providerKind: null,
    });
  });

  it("job con provider collegato: espone providerLabel e providerKind", async () => {
    const otherTicketRes = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: users.memberCookie },
    });
    expect(otherTicketRes.statusCode).toBe(200);

    const [provider] = await testDb.db
      .insert(aiProviders)
      .values({
        kind: "account",
        label: "Anthropic Account",
        secretEncrypted: "cifrato",
        position: 0,
      })
      .returning();
    expect(provider).toBeTruthy();

    const [jobWithProvider] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "pr_opened",
        providerId: provider!.id,
        createdAt: new Date("2026-07-01T10:00:00Z"),
      })
      .returning();
    expect(jobWithProvider).toBeTruthy();

    const res = await listJobs(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    const entry = body.find((job) => job["id"] === jobWithProvider!.id);
    expect(entry).toMatchObject({
      providerLabel: "Anthropic Account",
      providerKind: "account",
    });

    // Job senza provider: entrambi i campi restano null.
    const noProvider = body.find((job) => job["providerLabel"] === null);
    expect(noProvider).toBeDefined();
    expect(noProvider).toMatchObject({ providerLabel: null, providerKind: null });
  });
});

function getUsage(id: string, cookie?: string) {
  return app.inject({
    method: "GET",
    url: `/api/tickets/${id}/usage`,
    headers: cookie ? { cookie } : {},
  });
}

describe("GET /api/tickets/:ticketId/usage", () => {
  it("senza sessione risponde 401", async () => {
    const res = await getUsage(ticketId);
    expect(res.statusCode).toBe(401);
  });

  it("ticket inesistente: 404", async () => {
    const res = await getUsage(randomUUID(), users.memberCookie);
    expect(res.statusCode).toBe(404);
  });

  it("ticket senza consumi: totali a zero, costo null, byModel vuoto", async () => {
    const res = await getUsage(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalTokens: 0, totalCostUsd: null, byModel: [] });
  });

  it("aggrega gli agent_runs di tutti i job del ticket, raggruppati per modello", async () => {
    // Due job (triage+fix) con run su due modelli; il modello opus compare in
    // entrambi i job e va sommato. Inserimenti diretti: i run li scrive il
    // worker, qui non c'è API di scrittura.
    const [triageJob] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "fixing" })
      .returning();
    const [fixJob] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "pr_opened" })
      .returning();
    expect(triageJob && fixJob).toBeTruthy();

    await testDb.db.insert(agentRuns).values([
      {
        jobId: triageJob!.id,
        phase: "triage",
        model: "claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        costUsd: "0.001000",
      },
      {
        jobId: fixJob!.id,
        phase: "fix",
        model: "claude-opus-4-8",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        costUsd: "0.050000",
      },
      {
        jobId: fixJob!.id,
        phase: "fix",
        model: "claude-haiku-4-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        costUsd: "0.000500",
      },
    ]);

    const res = await getUsage(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalTokens: number;
      totalCostUsd: number | null;
      byModel: Array<{
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        costUsd: number | null;
      }>;
    };

    // Totale token = somma input+output su tutti i run (100+50+1000+500+10+5).
    expect(body.totalTokens).toBe(1665);
    // Costo totale = 0.001 + 0.05 + 0.0005.
    expect(body.totalCostUsd).toBeCloseTo(0.0515, 6);
    // Ordinato per modello: haiku (sommato sui due job), poi opus.
    expect(body.byModel).toEqual([
      {
        model: "claude-haiku-4-5",
        inputTokens: 110,
        outputTokens: 55,
        cacheReadTokens: 22,
        costUsd: 0.0015,
      },
      {
        model: "claude-opus-4-8",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        costUsd: 0.05,
      },
    ]);
  });

  it("modello con tutti i costi null: costUsd resta null nell'aggregazione", async () => {
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "failed" })
      .returning();
    await testDb.db.insert(agentRuns).values({
      jobId: job!.id,
      phase: "triage",
      model: "modello-senza-costo",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 1,
      costUsd: null,
    });

    const res = await getUsage(ticketId, users.memberCookie);
    const body = res.json() as { byModel: Array<{ model: string; costUsd: number | null }> };
    const entry = body.byModel.find((m) => m.model === "modello-senza-costo");
    expect(entry?.costUsd).toBeNull();
  });
});

describe("GET /api/users", () => {
  it("senza sessione risponde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });

  it("un member vede tutti gli utenti, senza campi sensibili e ordinati per registrazione", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    // Ordine per createdAt asc: l'admin (creato nel setup) precede il member.
    expect(body).toEqual([
      {
        id: users.adminId,
        email: "admin@example.com",
        role: "admin",
        createdAt: expect.any(String),
        avatarUrl: null,
        slackUserId: null,
        bitbucketUsername: null,
        gitIdentities: [],
      },
      {
        id: users.memberId,
        email: "member@example.com",
        role: "member",
        createdAt: expect.any(String),
        avatarUrl: null,
        slackUserId: null,
        bitbucketUsername: null,
        gitIdentities: [],
      },
    ]);
    // Nessun campo sensibile trapela.
    for (const u of body) expect(u).not.toHaveProperty("passwordHash");
  });
});
