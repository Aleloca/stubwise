import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentQuestions,
  aiJobs,
  prCorrections,
  prReviews,
  projectDecisions,
  ticketEvents,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicketRepository, startTestDb } from "@stubwise/db/testing";
import type { TicketHistory } from "@stubwise/shared";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * `GET /api/tickets/:id/history` contro un Postgres vero: le query del loader
 * (`services/ticket-history.ts`) e la rotta. La REGOLA (quali righe diventano
 * quale evento, l'ordine, il `round`) è del modulo puro
 * `buildTicketHistory` (`@stubwise/notifications`) e ha i suoi test: qui si
 * verifica che le righe GIUSTE — quelle di QUESTO ticket — gli arrivino.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let repositoryId: string;
let ticketNumber = 1;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const t = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 9, 2, h, m, s));
const PR_URL = "https://github.com/acme/r/pull/4";

async function newTicket(): Promise<string> {
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: ticketNumber++,
      title: "Storia",
      type: "bug",
      priority: "medium",
      source: "manual",
    })
    .returning({ id: tickets.id });
  return row!.id;
}

async function seedReview(ticketId: string | null, finishedAt: Date, prNumber = 4) {
  const [row] = await testDb.db
    .insert(prReviews)
    .values({
      repositoryId,
      prNumber,
      prUrl: PR_URL,
      prTitle: "Fix",
      headSha: "abcdef1",
      ticketId,
      status: "completed",
      verdict: "approve",
      createdAt: finishedAt,
      startedAt: finishedAt,
      finishedAt,
    })
    .returning({ id: prReviews.id });
  return row!.id;
}

async function seedCorrection(
  ticketId: string,
  trigger: "review" | "stubwise" | "provider",
  createdAt: Date,
  extra: { requestedByUserId?: string; login?: string } = {},
) {
  const [row] = await testDb.db
    .insert(prCorrections)
    .values({
      ticketId,
      repositoryId,
      prNumber: 4,
      trigger,
      status: "done",
      requestedByUserId: extra.requestedByUserId ?? null,
      requestedByProviderLogin: extra.login ?? null,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: prCorrections.id });
  return row!.id;
}

function getHistory(id: string, cookie: string | null = users.memberCookie) {
  return app.inject({
    method: "GET",
    url: `/api/tickets/${id}/history`,
    headers: cookie === null ? {} : { cookie },
  });
}

describe("GET /api/tickets/:id/history", () => {
  it("401 senza sessione", async () => {
    const ticketId = await newTicket();
    const res = await getHistory(ticketId, null);
    expect(res.statusCode).toBe(401);
  });

  it("404 su un ticket inesistente", async () => {
    const res = await getHistory(randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "ticket_not_found" });
  });

  it("un ticket senza niente: storia vuota, total 0", async () => {
    const ticketId = await newTicket();
    const res = await getHistory(ticketId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], total: 0 });
  });

  it("il ticket #1: fix, review, tre correzioni da tre origini — e un member la vede come /activity", async () => {
    const ticketId = await newTicket();
    await seedTicketRepository(testDb.db, {
      ticketId,
      repositoryId,
      prUrl: PR_URL,
      prNumber: 4,
    });
    const [fix] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "pr_opened",
        prUrl: PR_URL,
        requestedByUserId: users.adminId,
        createdAt: t(8, 58),
        startedAt: t(9, 0),
        finishedAt: t(9, 6),
      })
      .returning({ id: aiJobs.id });
    const r1 = await seedReview(ticketId, t(9, 9));
    const c1 = await seedCorrection(ticketId, "stubwise", t(9, 10), {
      requestedByUserId: users.adminId,
    });
    const [cj1] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "pr_opened", correctionId: c1, createdAt: t(9, 10), finishedAt: t(9, 13) })
      .returning({ id: aiJobs.id });
    const c2 = await seedCorrection(ticketId, "provider", t(9, 25), { login: "mario" });
    const c3 = await seedCorrection(ticketId, "stubwise", t(11, 45), {
      requestedByUserId: users.memberId,
    });
    await testDb.db.insert(ticketEvents).values({
      ticketId,
      actorId: null,
      kind: "status_changed",
      payload: { from: "in_review", to: "done" },
      createdAt: t(12, 0),
    });
    // Un evento che NON è un cambio di stato non entra.
    await testDb.db.insert(ticketEvents).values({
      ticketId,
      actorId: users.adminId,
      kind: "title_changed",
      payload: null,
      createdAt: t(12, 1),
    });
    const [q] = await testDb.db
      .insert(agentQuestions)
      .values({
        jobId: fix!.id,
        ticketId,
        round: 1,
        question: "Quale?",
        options: [{ label: "A" }, { label: "B" }],
        askedAt: t(9, 1),
        answer: { optionIndex: 0 },
        answeredAt: t(9, 2),
        answeredByUserId: users.memberId,
      })
      .returning({ id: agentQuestions.id });
    const [d] = await testDb.db
      .insert(projectDecisions)
      .values({
        projectId,
        source: "plan_review",
        sourceKey: `plan:${randomUUID()}`,
        sourceRef: { jobId: fix!.id, mode: "execute" },
        ticketId,
        title: "Piano approvato",
        decision: "ok",
        decidedByUserId: users.adminId,
        decidedAt: t(9, 3),
      })
      .returning({ id: projectDecisions.id });

    const res = await getHistory(ticketId, users.memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TicketHistory;
    expect(body.total).toBe(11);
    expect(body.events.map((e) => e.id)).toEqual([
      expect.stringMatching(/^ticket_closed:/),
      `changes_requested:${c3}`,
      `changes_requested:${c2}`,
      `correction_pushed:${cj1!.id}`,
      `changes_requested:${c1}`,
      `review_completed:${r1}`,
      `pr_opened:${fix!.id}`,
      `plan_approved:${d!.id}`,
      `question_answered:${q!.id}`,
      `question_asked:${q!.id}`,
      `run_started:${fix!.id}`,
    ]);
    const byId = new Map(body.events.map((e) => [e.id, e]));
    expect(byId.get(`changes_requested:${c2}`)).toMatchObject({
      actor: { type: "provider", name: "mario" },
      prNumber: 4,
      prUrl: PR_URL,
      round: 2,
    });
    expect(byId.get(`changes_requested:${c3}`)).toMatchObject({
      actor: { type: "user", name: "member@example.com" },
      round: 3,
    });
    expect(byId.get(`correction_pushed:${cj1!.id}`)).toMatchObject({ round: 1, prUrl: PR_URL });
    expect(byId.get(`run_started:${fix!.id}`)?.actor).toEqual({
      type: "user",
      name: "admin@example.com",
    });
    expect(body.events[0]).toMatchObject({ kind: "ticket_closed", detail: "done", actor: null });
  });

  it("le righe di un ALTRO ticket non entrano (job, domanda, decisione, review, correzione, evento, URL)", async () => {
    const mine = await newTicket();
    const other = await newTicket();
    const MY_URL = "https://github.com/acme/r/pull/4";
    const OTHER_URL = "https://github.com/acme/r/pull/4#altro-ticket";
    await seedTicketRepository(testDb.db, { ticketId: mine, repositoryId, prUrl: MY_URL, prNumber: 4 });
    await seedTicketRepository(testDb.db, {
      ticketId: other,
      repositoryId,
      prUrl: OTHER_URL,
      prNumber: 4,
    });
    const myReview = await seedReview(mine, t(10, 0));
    const myCorrection = await seedCorrection(mine, "review", t(10, 0, 30));

    const [otherJob] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: other,
        status: "pr_opened",
        prUrl: OTHER_URL,
        createdAt: t(9, 0),
        startedAt: t(9, 0),
        finishedAt: t(9, 5),
      })
      .returning({ id: aiJobs.id });
    const [otherQuestion] = await testDb.db
      .insert(agentQuestions)
      .values({
        jobId: otherJob!.id,
        ticketId: other,
        round: 1,
        question: "Altrove?",
        options: [{ label: "A" }, { label: "B" }],
        askedAt: t(9, 1),
      })
      .returning({ id: agentQuestions.id });
    const [otherDecision] = await testDb.db
      .insert(projectDecisions)
      .values({
        projectId,
        source: "plan_review",
        sourceKey: `plan:${randomUUID()}`,
        sourceRef: { jobId: otherJob!.id, mode: "execute" },
        ticketId: other,
        title: "Piano approvato",
        decision: "ok",
        decidedAt: t(9, 2),
      })
      .returning({ id: projectDecisions.id });
    const otherReview = await seedReview(other, t(10, 1));
    const otherCorrection = await seedCorrection(other, "stubwise", t(10, 2));
    await testDb.db.insert(ticketEvents).values({
      ticketId: other,
      actorId: null,
      kind: "status_changed",
      payload: { from: "triaged", to: "in_progress" },
      createdAt: t(10, 3),
    });

    const body = (await getHistory(mine)).json() as TicketHistory;
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(`review_completed:${myReview}`);
    expect(ids).toContain(`changes_requested:${myCorrection}`);
    for (const absent of [
      `run_started:${otherJob!.id}`,
      `pr_opened:${otherJob!.id}`,
      `question_asked:${otherQuestion!.id}`,
      `plan_approved:${otherDecision!.id}`,
      `review_completed:${otherReview}`,
      `changes_requested:${otherCorrection}`,
    ]) {
      expect(ids).not.toContain(absent);
    }
    expect(ids.some((id) => id.startsWith("status_changed:"))).toBe(false);
    // L'URL della PR della mia correzione è quello della MIA riga
    // `ticket_repositories`, mai quello dell'altro ticket sulla stessa PR.
    expect(body.events.find((e) => e.id === `changes_requested:${myCorrection}`)?.prUrl).toBe(
      MY_URL,
    );
    expect(body.events.some((e) => e.prUrl === OTHER_URL)).toBe(false);
  });

  it("routing: il dettaglio GET /:id risponde ancora, e /:id/history non è catturata da altro", async () => {
    const ticketId = await newTicket();
    const detail = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: users.memberCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: ticketId, title: "Storia" });
    const history = await getHistory(ticketId);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({ events: [], total: 0 });
  });
});
