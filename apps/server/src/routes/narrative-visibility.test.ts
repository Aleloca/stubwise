import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  activityReports,
  aiJobs,
  prReviews,
  projectBriefs,
  projectDecisions,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat } from "../test/fixtures.js";

/**
 * Le rotte NARRATIVE del progetto rispettano i permessi di lettura (ruling
 * R49): timeline, review di PR, report giornalieri, brief e registro
 * decisioni raccontano ticket, PR e codice, e un Contributor (solo i propri
 * ticket, niente `repos.view`) non deve leggerli da qui quando non li
 * leggerebbe dalle loro rotte.
 *
 * Test a DUE UTENTI sugli stessi dati: il Legacy Member (tutti i `*.view_all`
 * e `repos.view`, come un member di oggi) deve vedere TUTTO — nessuno perde
 * nulla — e il Contributor solo ciò che è suo.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const TODAY = new Date().toISOString().slice(0, 10);

interface TestUser {
  id: string;
  headers: { authorization: string };
}

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let repositoryId: string;
/** Legacy Member: vede tutto come oggi. */
let legacy: TestUser;
/** Contributor: solo i propri ticket, niente `repos.view` né `tickets.view_all`. */
let contributor: TestUser;
let legacyTicket: string;
let contributorTicket: string;
let briefId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  legacy = await createUserWithPat(app, "legacy@example.com");
  contributor = await createUserWithPat(app, "contributor@example.com");
  await addMember(app, projectId, legacy.id, "legacy_member");
  await addMember(app, projectId, contributor.id, "contributor");

  const insertTicket = async (number: number, title: string, requestedByUserId: string) => {
    const [row] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number,
        title,
        type: "task",
        priority: "medium",
        source: "manual",
        requestedByUserId,
      })
      .returning({ id: tickets.id });
    return row!.id;
  };
  legacyTicket = await insertTicket(1, "Ticket del legacy", legacy.id);
  contributorTicket = await insertTicket(2, "Ticket del contributor", contributor.id);

  await testDb.db.insert(aiJobs).values({
    ticketId: legacyTicket,
    status: "pr_opened",
    prUrl: "https://github.com/acme/repo/pull/7",
    finishedAt: new Date(),
  });
  await testDb.db.insert(prReviews).values({
    repositoryId,
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    prTitle: "PR del legacy",
    headSha: "abc123",
    ticketId: legacyTicket,
    status: "completed",
    verdict: "approve",
  });
  await testDb.db
    .insert(activityReports)
    .values({ projectId, date: TODAY, status: "done", summary: "Giornata di commit" });
  const [brief] = await testDb.db
    .insert(projectBriefs)
    .values({
      projectId,
      periodStart: TODAY,
      periodEnd: TODAY,
      status: "done",
      summary: "Il progetto racconta il ticket del legacy",
      finishedAt: new Date(),
    })
    .returning({ id: projectBriefs.id });
  briefId = brief!.id;
  await testDb.db.insert(projectDecisions).values([
    {
      projectId,
      source: "manual",
      sourceKey: "manual:legacy",
      ticketId: legacyTicket,
      title: "Decisione sul ticket del legacy",
      decision: "Sì",
    },
    {
      projectId,
      source: "manual",
      sourceKey: "manual:contributor",
      ticketId: contributorTicket,
      title: "Decisione sul ticket del contributor",
      decision: "No",
    },
  ]);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function get(user: TestUser, url: string) {
  return app.inject({ method: "GET", url, headers: user.headers });
}

interface TimelineEntry {
  kind: string;
  ticketNumber?: number;
}

async function timelineKinds(user: TestUser): Promise<TimelineEntry[]> {
  const res = await get(user, `/api/projects/${projectId}/timeline`);
  expect(res.statusCode).toBe(200);
  return (res.json() as { entries: TimelineEntry[] }).entries;
}

describe("timeline", () => {
  it("il Legacy Member vede tutto: ticket di tutti, PR, report, brief", async () => {
    const entries = await timelineKinds(legacy);
    const opened = entries.filter((e) => e.kind === "ticket_opened").map((e) => e.ticketNumber);
    expect(opened.sort()).toEqual([1, 2]);
    expect(entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["pr_opened", "report_day", "brief", "decision"]),
    );
  });

  it("il Contributor vede solo i propri ticket, niente PR, report né brief", async () => {
    const entries = await timelineKinds(contributor);
    const opened = entries.filter((e) => e.kind === "ticket_opened").map((e) => e.ticketNumber);
    expect(opened).toEqual([2]);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("pr_opened")).toBe(false);
    expect(kinds.has("report_day")).toBe(false);
    expect(kinds.has("brief")).toBe(false);
    // Le decisioni restano: sono fatti del progetto (il riferimento ai ticket
    // la timeline non lo porta).
    expect(kinds.has("decision")).toBe(true);
  });

  it("chiedere un tipo non permesso con ?kinds= non lo fa uscire", async () => {
    const res = await get(contributor, `/api/projects/${projectId}/timeline?kinds=pr_opened,brief`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entries: unknown[] }).entries).toEqual([]);
  });
});

describe("review, report, brief", () => {
  it("GET /reviews: il Legacy Member sì, il Contributor no (repos.view)", async () => {
    const ok = await get(legacy, `/api/projects/${projectId}/reviews`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(1);
    expect((await get(contributor, `/api/projects/${projectId}/reviews`)).statusCode).toBe(403);
  });

  it("GET /api/activity: il report del progetto solo a chi ha repos.view", async () => {
    const ids = async (user: TestUser) =>
      (
        (await get(user, `/api/activity?date=${TODAY}`)).json() as {
          projects: { project: { id: string } }[];
        }
      ).projects.map((p) => p.project.id);
    expect(await ids(legacy)).toEqual([projectId]);
    expect(await ids(contributor)).toEqual([]);
  });

  it("brief: elenco e dettaglio solo con tickets.view_all", async () => {
    const list = await get(legacy, `/api/projects/${projectId}/briefs`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect((await get(legacy, `/api/briefs/${briefId}`)).statusCode).toBe(200);
    expect((await get(contributor, `/api/projects/${projectId}/briefs`)).statusCode).toBe(403);
    expect((await get(contributor, `/api/briefs/${briefId}`)).statusCode).toBe(403);
  });
});

describe("registro decisioni", () => {
  interface Decision {
    title: string;
    ticketId: string | null;
    ticketNumber: number | null;
  }
  const byTitle = async (user: TestUser) => {
    const res = await get(user, `/api/projects/${projectId}/decisions`);
    expect(res.statusCode).toBe(200);
    return new Map((res.json() as Decision[]).map((d) => [d.title, d]));
  };

  it("il Legacy Member vede ogni riferimento ai ticket", async () => {
    const decisions = await byTitle(legacy);
    expect(decisions.get("Decisione sul ticket del legacy")).toMatchObject({
      ticketId: legacyTicket,
      ticketNumber: 1,
    });
    expect(decisions.get("Decisione sul ticket del contributor")).toMatchObject({
      ticketId: contributorTicket,
      ticketNumber: 2,
    });
  });

  it("il Contributor vede le decisioni, ma il riferimento al ticket altrui è tolto", async () => {
    const decisions = await byTitle(contributor);
    expect(decisions.get("Decisione sul ticket del legacy")).toMatchObject({
      ticketId: null,
      ticketNumber: null,
    });
    expect(decisions.get("Decisione sul ticket del contributor")).toMatchObject({
      ticketId: contributorTicket,
      ticketNumber: 2,
    });
  });
});
