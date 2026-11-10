import { randomBytes } from "node:crypto";
import { agentQuestions, aiJobs, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { claudeDecisionViewSchema, type ClaudeDecisionView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * «Da decidere» di Claude (integrazione area 3, fetta 3b): i piani che
 * aspettano chi guarda (solo con `plans.approve` nel progetto) e le domande
 * aperte a cui può rispondere (il richiedente del job o `plans.approve`,
 * `actorAllows`), sempre su task che vede. Test a più utenti sugli stessi dati.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let hiddenProjectId: string;
let code: string;
type U = { id: string; headers: { cookie: string } };
let lead: U;
let developer: U;
let viewer: U;
let n = 0;
let planJob: string;
let planTask: { id: string; number: number };
let questionId: string;
let questionJob: string;

async function task(pid: string, requestedByUserId?: string) {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId: pid, number: 3000 + n, title: `Task ${n}`, type: "bug", priority: "medium", source: "manual", ...(requestedByUserId ? { requestedByUserId } : {}) })
    .returning({ id: tickets.id, number: tickets.number });
  return row!;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: hiddenProjectId } = await seedRepository(testDb.db));
  [{ code }] = (await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId))) as [{ code: string }];
  lead = await createUserWithSession(app, "lead-d@example.com");
  developer = await createUserWithSession(app, "dev-d@example.com");
  viewer = await createUserWithSession(app, "viewer-d@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, developer.id, "developer");
  await addMember(app, projectId, viewer.id, "viewer");

  planTask = await task(projectId, developer.id);
  [{ id: planJob }] = (await testDb.db
    .insert(aiJobs)
    .values({ ticketId: planTask.id, status: "awaiting_plan_approval", planText: "## Piano", planSummary: "Tre passi", requestedByUserId: developer.id })
    .returning({ id: aiJobs.id })) as [{ id: string }];

  const qTask = await task(projectId, developer.id);
  [{ id: questionJob }] = (await testDb.db
    .insert(aiJobs)
    .values({ ticketId: qTask.id, status: "awaiting_input", requestedByUserId: developer.id })
    .returning({ id: aiJobs.id })) as [{ id: string }];
  [{ id: questionId }] = (await testDb.db
    .insert(agentQuestions)
    .values({
      jobId: questionJob,
      ticketId: qTask.id,
      round: 1,
      question: "Quale database?",
      options: [{ label: "Postgres", consequence: "come oggi" }, { label: "SQLite" }],
      recommendedIndex: 0,
      allowFreeText: false,
    })
    .returning({ id: agentQuestions.id })) as [{ id: string }];
  // Una già risposta e un job non più fermo: fuori.
  await testDb.db.insert(agentQuestions).values({
    jobId: questionJob,
    ticketId: qTask.id,
    round: 0,
    question: "Vecchia",
    options: [{ label: "A" }],
    answeredAt: new Date(),
    answer: { optionIndex: 0 },
  });
  const moving = await task(projectId, developer.id);
  const [running] = await testDb.db.insert(aiJobs).values({ ticketId: moving.id, status: "fixing", requestedByUserId: developer.id }).returning({ id: aiJobs.id });
  await testDb.db.insert(agentQuestions).values({ jobId: running!.id, ticketId: moving.id, round: 1, question: "Non più ferma", options: [{ label: "A" }] });
  // Un progetto che il developer non vede.
  const hidden = await task(hiddenProjectId);
  await testDb.db.insert(aiJobs).values({ ticketId: hidden.id, status: "awaiting_plan_approval", planText: "## Nascosto" });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function decisions(who: U | "admin"): Promise<ClaudeDecisionView[]> {
  const cookie = who === "admin" ? users.adminCookie : who.headers.cookie;
  const res = await app.inject({ method: "GET", url: "/api/me/claude-decisions", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return z.array(claudeDecisionViewSchema).parse(res.json());
}

describe("GET /api/me/claude-decisions", () => {
  it("il piano aspetta chi ha plans.approve: nella forma del prototipo, col codice e il link", async () => {
    const forLead = await decisions(lead);
    expect(forLead.find((d) => d.kind === "plan")).toMatchObject({
      id: `${planJob}:plan`,
      kind: "plan",
      planId: planJob,
      summary: "Tre passi",
      taskId: planTask.id,
      projectId,
      objectCode: `${code}-${planTask.number}`,
      title: expect.stringMatching(/^Task /),
      ownerId: developer.id,
      conversationKind: "task_run",
      blockedReason: null,
      serverCode: null,
      webHref: `/tickets/${planTask.id}`,
    });
  });

  it("chi non ha plans.approve non riceve il piano, nemmeno se l'ha avviato lui", async () => {
    expect((await decisions(developer)).some((d) => d.kind === "plan")).toBe(false);
    expect((await decisions(viewer)).some((d) => d.kind === "plan")).toBe(false);
  });

  it("la domanda aperta aspetta il richiedente e chi ha plans.approve; non chi guarda e basta", async () => {
    const forDev = await decisions(developer);
    expect(forDev.filter((d) => d.kind === "question")).toEqual([
      expect.objectContaining({
        id: `${questionJob}:${questionId}`,
        questionId,
        text: "Quale database?",
        options: [
          { label: "Postgres", consequence: "come oggi", recommended: true },
          { label: "SQLite", recommended: false },
        ],
      }),
    ]);
    expect((await decisions(lead)).some((d) => d.questionId === questionId)).toBe(true);
    expect(await decisions(viewer)).toEqual([]);
  });

  it("niente risposte già date, niente domande di un job non più fermo, niente progetti invisibili", async () => {
    const all = await decisions(lead);
    expect(all.map((d) => d.text ?? d.summary)).not.toContain("Vecchia");
    expect(all.map((d) => d.text)).not.toContain("Non più ferma");
    expect(all.every((d) => d.projectId === projectId)).toBe(true);
    // L'admin vede anche l'altro progetto: il filtro è la visibilità, non un caso del test.
    expect((await decisions("admin")).some((d) => d.projectId === hiddenProjectId)).toBe(true);
  });
});
