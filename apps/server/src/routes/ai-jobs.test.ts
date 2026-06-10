import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiJobs } from "../db/schema.js";
import type { TestDb } from "../test/db.js";
import { startTestDb } from "../test/db.js";
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

  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { cookie: users.adminCookie },
    payload: {
      name: "Progetto Jobs",
      provider: "github",
      repoUrl: "https://github.com/acme/progetto-jobs",
      credentials: { token: "token-di-test" },
    },
  });
  expect(projectRes.statusCode).toBe(201);
  const projectId = (projectRes.json() as { id: string }).id;

  const ticketRes = await app.inject({
    method: "POST",
    url: "/api/tickets",
    headers: { cookie: users.memberCookie },
    payload: { projectId, title: "Crash al checkout", type: "bug" },
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
    expect(res.json()).toEqual({ message: "Ticket non trovato" });
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
    });
    expect(body[2]).toMatchObject({
      id: queued!.id,
      status: "queued",
      log: "",
      prUrl: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  });
});

describe("GET /api/users", () => {
  it("senza sessione risponde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });

  it("un member vede tutti gli utenti, senza campi sensibili e ordinati per email", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];
    expect(body).toEqual([
      { id: users.adminId, email: "admin@example.com", role: "admin" },
      { id: users.memberId, email: "member@example.com", role: "member" },
    ]);
  });
});
