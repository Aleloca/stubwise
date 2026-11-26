import { randomBytes } from "node:crypto";
import { agentSessions, aiJobs, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { agentSessionListSchema, type AgentSessionSummary } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * I filtri dell'elenco delle sessioni (integrazione area 3, fetta 3a): per
 * kind, per stato e «aspetta me», e `waitsOnViewer` su ogni riga, calcolato dal
 * SERVER coi permessi di chi guarda (un piano in attesa aspetta chi ha
 * `plans.approve`; una domanda il richiedente o chi ha `plans.approve`). Le
 * regole di visibilità restano quelle di sempre.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
type U = { id: string; headers: { cookie: string } };
let lead: U;
let developer: U;
let planSession: string;
let questionSession: string;
let doneSession: string;
let n = 0;

async function sessionFor(status: (typeof aiJobs.$inferInsert)["status"], requestedByUserId?: string): Promise<string> {
  n += 1;
  const [t] = await testDb.db
    .insert(tickets)
    .values({ projectId, number: 2000 + n, title: `T${n}`, type: "bug", priority: "medium", source: "manual" })
    .returning({ id: tickets.id });
  const [job] = await testDb.db
    .insert(aiJobs)
    .values({ ticketId: t!.id, status, ...(requestedByUserId ? { requestedByUserId } : {}) })
    .returning({ id: aiJobs.id });
  const [s] = await testDb.db
    .insert(agentSessions)
    .values({ ownerKey: `ai_job:${job!.id}`, kind: "ai_job", title: `#${n}`, projectId, ticketId: t!.id, aiJobId: job!.id })
    .returning({ id: agentSessions.id });
  return s!.id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  lead = await createUserWithSession(app, "lead-s@example.com");
  developer = await createUserWithSession(app, "dev-s@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, developer.id, "developer");
  planSession = await sessionFor("awaiting_plan_approval", developer.id);
  questionSession = await sessionFor("awaiting_input", developer.id);
  doneSession = await sessionFor("pr_opened", developer.id);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function list(query: string, who: U | "admin" = "admin"): Promise<AgentSessionSummary[]> {
  const cookie = who === "admin" ? users.adminCookie : who.headers.cookie;
  const res = await app.inject({ method: "GET", url: `/api/agent-sessions${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  const body = agentSessionListSchema.parse(res.json());
  return [...body.live, ...body.recent];
}

const ids = (rows: AgentSessionSummary[]) => rows.map((r) => r.id).sort();

describe("GET /api/agent-sessions: filtri", () => {
  it("waitsOnViewer: il piano aspetta il lead, non il developer; la domanda aspetta il developer (richiedente) e il lead", async () => {
    const forLead = await list(`?projectId=${projectId}`, lead);
    const forDev = await list(`?projectId=${projectId}`, developer);
    const flag = (rows: AgentSessionSummary[], id: string) => rows.find((r) => r.id === id)?.waitsOnViewer;
    expect(flag(forLead, planSession)).toBe(true);
    expect(flag(forDev, planSession)).toBe(false);
    expect(flag(forDev, questionSession)).toBe(true);
    expect(flag(forLead, questionSession)).toBe(true);
    expect(flag(forLead, doneSession)).toBe(false);
    // Anche nel dettaglio.
    const detail = async (who: U) =>
      (await app.inject({ method: "GET", url: `/api/agent-sessions/${planSession}`, headers: { cookie: who.headers.cookie } })).json() as {
        waitsOnViewer: boolean;
      };
    expect((await detail(lead)).waitsOnViewer).toBe(true);
    expect((await detail(developer)).waitsOnViewer).toBe(false);
  });

  it("waitingOnMe=true: solo quelle che aspettano chi guarda", async () => {
    expect(ids(await list(`?projectId=${projectId}&waitingOnMe=true`, developer))).toEqual([questionSession].sort());
    expect(ids(await list(`?projectId=${projectId}&waitingOnMe=true`, lead))).toEqual([planSession, questionSession].sort());
  });

  it("per stato e per kind", async () => {
    expect(ids(await list(`?projectId=${projectId}&state=awaiting_approval`))).toEqual([planSession]);
    expect(ids(await list(`?projectId=${projectId}&state=ended`))).toEqual([doneSession]);
    expect(await list(`?projectId=${projectId}&kind=pr_review`)).toEqual([]);
    expect(ids(await list(`?projectId=${projectId}&kind=ai_job`))).toEqual([planSession, questionSession, doneSession].sort());
  });

  it("un filtro sconosciuto è un 400, non un elenco intero", async () => {
    const res = await app.inject({ method: "GET", url: `/api/agent-sessions?state=boh`, headers: { cookie: users.adminCookie } });
    expect(res.statusCode).toBe(400);
  });
});
