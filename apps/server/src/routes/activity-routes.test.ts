import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityReportEntries, activityReports, gitIdentities, projects, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const DATE = "2026-07-14";

let testDb: TestDb;
let app: FastifyInstance;
let memberCookie: string;
let memberId: string;
let projectId: string;
const PROJECT_NAME = "Progetto di test";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ memberCookie, memberId } = await seedUsers(app));
  // L'avatar del membro entra nel resolvedUser: lo valorizziamo per verificarlo.
  await testDb.db
    .update(users)
    .set({ slackAvatarUrl: "https://avatars.example/member.png" })
    .where(eq(users.id, memberId));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  ({ projectId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await testDb.db.delete(activityReports);
  await testDb.db.delete(gitIdentities);
  await testDb.db.delete(projects);
});

/** Crea un report `done` per il progetto con due entries (una risolta, una no). */
async function seedReport(): Promise<void> {
  const inserted = await testDb.db
    .insert(activityReports)
    .values({ projectId, date: DATE, status: "done" })
    .returning({ id: activityReports.id });
  const reportId = inserted[0]!.id;

  // Il membro possiede l'email git "dev@member.it".
  await testDb.db.insert(gitIdentities).values({ userId: memberId, email: "dev@member.it" });

  await testDb.db.insert(activityReportEntries).values([
    {
      reportId,
      gitEmail: "dev@member.it",
      authorName: "Dev Member",
      commitCount: 3,
      additions: 100,
      deletions: 20,
      repoIds: ["repo-1"],
      commits: [
        { sha: "aaa111", subject: "feat: uno", repoId: "repo-1" },
        { sha: "bbb222", subject: "fix: due", repoId: "repo-1" },
        { sha: "ccc333", subject: "chore: tre", repoId: "repo-1" },
      ],
      aiSummary: "Ha lavorato su feature.",
    },
    {
      reportId,
      gitEmail: "stranger@x.it",
      authorName: "Stranger",
      commitCount: 1,
      additions: 5,
      deletions: 1,
      repoIds: ["repo-1"],
      commits: [{ sha: "ddd444", subject: "docs: quattro", repoId: "repo-1" }],
      aiSummary: null,
    },
  ]);
}

describe("GET /api/activity", () => {
  it("senza sessione → 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/activity?date=${DATE}` });
    expect(res.statusCode).toBe(401);
  });

  it("date malformata → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/activity?date=14-07-2026",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("giorno senza report → projects e developers vuoti", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { date: string; projects: unknown[]; developers: unknown[] };
    expect(body.date).toBe(DATE);
    expect(body.projects).toEqual([]);
    expect(body.developers).toEqual([]);
  });

  it("vista per-progetto: entries con resolvedUser risolto e null", async () => {
    await seedReport();
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projects: {
        project: { id: string; name: string; slug: string };
        date: string;
        status: string;
        entries: {
          gitEmail: string;
          authorName: string | null;
          resolvedUser: { id: string; email: string; avatarUrl: string | null } | null;
          commitCount: number;
          additions: number;
          deletions: number;
          commits: { sha: string; subject: string; repoId: string }[];
          aiSummary: string | null;
        }[];
      }[];
    };
    expect(body.projects).toHaveLength(1);
    const view = body.projects[0]!;
    expect(view.project.id).toBe(projectId);
    expect(view.project.name).toBe(PROJECT_NAME);
    expect(view.status).toBe("done");
    expect(view.date).toBe(DATE);
    expect(view.entries).toHaveLength(2);

    const resolved = view.entries.find((e) => e.gitEmail === "dev@member.it")!;
    expect(resolved.resolvedUser).not.toBeNull();
    expect(resolved.resolvedUser!.id).toBe(memberId);
    expect(resolved.resolvedUser!.email).toBe("member@example.com");
    expect(resolved.resolvedUser!.avatarUrl).toBe("https://avatars.example/member.png");
    expect(resolved.commitCount).toBe(3);
    expect(resolved.commits).toHaveLength(3);

    const unresolved = view.entries.find((e) => e.gitEmail === "stranger@x.it")!;
    expect(unresolved.resolvedUser).toBeNull();
  });

  it("vista per-dev: membro risolto una volta, sconosciuto come dev separato", async () => {
    await seedReport();
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      developers: {
        resolvedUser: { id: string; email: string; avatarUrl: string | null } | null;
        gitEmail: string | null;
        authorName: string | null;
        totalCommits: number;
        totalAdditions: number;
        totalDeletions: number;
        perProject: {
          projectId: string;
          projectName: string;
          commitCount: number;
          aiSummary: string | null;
          commits: { sha: string; subject: string; repoId: string }[];
        }[];
      }[];
    };
    expect(body.developers).toHaveLength(2);

    const member = body.developers.find((d) => d.resolvedUser?.id === memberId)!;
    expect(member).toBeDefined();
    expect(member.resolvedUser!.email).toBe("member@example.com");
    expect(member.totalCommits).toBe(3);
    expect(member.totalAdditions).toBe(100);
    expect(member.totalDeletions).toBe(20);
    expect(member.perProject).toHaveLength(1);
    expect(member.perProject[0]!.projectId).toBe(projectId);
    expect(member.perProject[0]!.projectName).toBe(PROJECT_NAME);
    expect(member.perProject[0]!.commitCount).toBe(3);

    const stranger = body.developers.find((d) => d.resolvedUser === null)!;
    expect(stranger).toBeDefined();
    expect(stranger.gitEmail).toBe("stranger@x.it");
    expect(stranger.totalCommits).toBe(1);
  });

  it("membro con più email git è unito sotto lo stesso resolvedUser", async () => {
    // Due progetti, ciascuno con un'entry attribuita a un'email DIVERSA dello
    // stesso membro: nella vista per-dev deve comparire una sola volta.
    const { projectId: projectId2 } = await seedRepository(testDb.db);

    await testDb.db.insert(gitIdentities).values([
      { userId: memberId, email: "a@member.it" },
      { userId: memberId, email: "b@member.it" },
    ]);

    const ins1 = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: DATE, status: "done" })
      .returning({ id: activityReports.id });
    const r1 = ins1[0]!.id;
    const ins2 = await testDb.db
      .insert(activityReports)
      .values({ projectId: projectId2, date: DATE, status: "done" })
      .returning({ id: activityReports.id });
    const r2 = ins2[0]!.id;

    await testDb.db.insert(activityReportEntries).values([
      {
        reportId: r1,
        gitEmail: "a@member.it",
        authorName: "A",
        commitCount: 2,
        additions: 10,
        deletions: 3,
        repoIds: ["repo-1"],
        commits: [{ sha: "a1", subject: "s1", repoId: "repo-1" }],
        aiSummary: null,
      },
      {
        reportId: r2,
        gitEmail: "b@member.it",
        authorName: "B",
        commitCount: 4,
        additions: 40,
        deletions: 7,
        repoIds: ["repo-2"],
        commits: [{ sha: "b1", subject: "s2", repoId: "repo-2" }],
        aiSummary: null,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      developers: {
        resolvedUser: { id: string } | null;
        totalCommits: number;
        totalAdditions: number;
        totalDeletions: number;
        perProject: { projectId: string }[];
      }[];
    };
    expect(body.developers).toHaveLength(1);
    const member = body.developers[0]!;
    expect(member.resolvedUser!.id).toBe(memberId);
    expect(member.totalCommits).toBe(6);
    expect(member.totalAdditions).toBe(50);
    expect(member.totalDeletions).toBe(10);
    expect(member.perProject).toHaveLength(2);
  });
});
