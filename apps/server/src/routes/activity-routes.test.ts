import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityReports,
  gitIdentities,
  projects,
  users,
} from "@stubwise/db";
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
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let projectId: string;
let repositoryId: string;
const PROJECT_NAME = "Progetto di test";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
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
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await testDb.db.delete(activityReports);
  await testDb.db.delete(activityDevSummaries);
  await testDb.db.delete(activityDayRollups);
  await testDb.db.delete(gitIdentities);
  await testDb.db.delete(projects);
});

/**
 * Crea un report `done` per il progetto con 4 commit: 3 del membro (email git
 * "dev@member.it") + 1 di uno sconosciuto ("stranger@x.it"). Additions/deletions
 * del membro sommano 100/20, dello sconosciuto 5/1.
 */
async function seedReport(): Promise<void> {
  const inserted = await testDb.db
    .insert(activityReports)
    .values({ projectId, date: DATE, status: "done" })
    .returning({ id: activityReports.id });
  const reportId = inserted[0]!.id;

  // Il membro possiede l'email git "dev@member.it".
  await testDb.db.insert(gitIdentities).values({ userId: memberId, email: "dev@member.it" });

  await testDb.db.insert(activityCommits).values([
    {
      reportId,
      repoId: repositoryId,
      sha: "aaa111",
      authorEmail: "dev@member.it",
      authorName: "Dev Member",
      committedAt: new Date("2026-07-14T08:00:00Z"),
      subject: "feat: uno",
      additions: 50,
      deletions: 10,
      aiDescription: "Ha aggiunto la feature uno.",
    },
    {
      reportId,
      repoId: repositoryId,
      sha: "bbb222",
      authorEmail: "dev@member.it",
      authorName: "Dev Member",
      committedAt: new Date("2026-07-14T09:00:00Z"),
      subject: "fix: due",
      additions: 30,
      deletions: 5,
      aiDescription: null,
    },
    {
      reportId,
      repoId: repositoryId,
      sha: "ccc333",
      authorEmail: "dev@member.it",
      authorName: "Dev Member",
      committedAt: new Date("2026-07-14T10:00:00Z"),
      subject: "chore: tre",
      additions: 20,
      deletions: 5,
      aiDescription: null,
    },
    {
      reportId,
      repoId: repositoryId,
      sha: "ddd444",
      authorEmail: "stranger@x.it",
      authorName: "Stranger",
      committedAt: new Date("2026-07-14T11:00:00Z"),
      subject: "docs: quattro",
      additions: 5,
      deletions: 1,
      aiDescription: null,
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

  it("date ben formata ma impossibile → 400 invalid_date", async () => {
    for (const bad of ["2026-13-40", "2026-02-30"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/activity?date=${bad}`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe("invalid_date");
    }
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

  it("vista per-progetto: header aggregato e commit con resolvedUser risolto/null", async () => {
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
        status: string;
        header: {
          commitCount: number;
          additions: number;
          deletions: number;
          authorCount: number;
        };
        commits: {
          sha: string;
          authorEmail: string;
          authorName: string | null;
          resolvedUser: { id: string; email: string; avatarUrl: string | null } | null;
          committedAt: string;
          subject: string;
          additions: number;
          deletions: number;
          aiDescription: string | null;
        }[];
      }[];
    };
    expect(body.projects).toHaveLength(1);
    const view = body.projects[0]!;
    expect(view.project.id).toBe(projectId);
    expect(view.project.name).toBe(PROJECT_NAME);
    expect(view.status).toBe("done");
    // 4 commit totali: 3 del membro (100/20) + 1 sconosciuto (5/1), 2 autori.
    expect(view.header).toEqual({
      commitCount: 4,
      additions: 105,
      deletions: 21,
      authorCount: 2,
    });
    expect(view.commits).toHaveLength(4);
    // Ordine cronologico ASC per committedAt.
    expect(view.commits.map((c) => c.sha)).toEqual(["aaa111", "bbb222", "ccc333", "ddd444"]);

    const resolved = view.commits.find((c) => c.sha === "aaa111")!;
    // L'email git dell'autore è esposta nel commit (serve al link inline in /activity).
    expect(resolved.authorEmail).toBe("dev@member.it");
    expect(resolved.resolvedUser).not.toBeNull();
    expect(resolved.resolvedUser!.id).toBe(memberId);
    expect(resolved.resolvedUser!.email).toBe("member@example.com");
    expect(resolved.resolvedUser!.avatarUrl).toBe("https://avatars.example/member.png");
    expect(resolved.aiDescription).toBe("Ha aggiunto la feature uno.");
    expect(resolved.committedAt).toBe("2026-07-14T08:00:00.000Z");

    const unresolved = view.commits.find((c) => c.sha === "ddd444")!;
    expect(unresolved.resolvedUser).toBeNull();
    expect(unresolved.aiDescription).toBeNull();
  });

  it("vista per-dev: membro risolto aggregato, sconosciuto come dev separato", async () => {
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
        header: {
          commitCount: number;
          additions: number;
          deletions: number;
          projectCount: number;
        };
        byProject: {
          project: { id: string; name: string; slug: string };
          commits: { sha: string; subject: string; aiDescription: string | null }[];
        }[];
      }[];
    };
    expect(body.developers).toHaveLength(2);

    const member = body.developers.find((d) => d.resolvedUser?.id === memberId)!;
    expect(member).toBeDefined();
    expect(member.resolvedUser!.email).toBe("member@example.com");
    expect(member.header).toEqual({
      commitCount: 3,
      additions: 100,
      deletions: 20,
      projectCount: 1,
    });
    expect(member.byProject).toHaveLength(1);
    expect(member.byProject[0]!.project.id).toBe(projectId);
    expect(member.byProject[0]!.project.name).toBe(PROJECT_NAME);
    expect(member.byProject[0]!.commits.map((c) => c.sha)).toEqual(["aaa111", "bbb222", "ccc333"]);

    const stranger = body.developers.find((d) => d.resolvedUser === null)!;
    expect(stranger).toBeDefined();
    expect(stranger.gitEmail).toBe("stranger@x.it");
    expect(stranger.header.commitCount).toBe(1);
  });

  it("membro con più email git è unito sotto lo stesso resolvedUser", async () => {
    // Due progetti, ciascuno con un commit attribuito a un'email DIVERSA dello
    // stesso membro: nella vista per-dev deve comparire una sola volta.
    const { projectId: projectId2, repositoryId: repositoryId2 } =
      await seedRepository(testDb.db);

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

    await testDb.db.insert(activityCommits).values([
      {
        reportId: r1,
        repoId: repositoryId,
        sha: "a1",
        authorEmail: "a@member.it",
        authorName: "A",
        committedAt: new Date("2026-07-14T08:00:00Z"),
        subject: "s1",
        additions: 10,
        deletions: 3,
        aiDescription: null,
      },
      {
        reportId: r1,
        repoId: repositoryId,
        sha: "a2",
        authorEmail: "a@member.it",
        authorName: "A",
        committedAt: new Date("2026-07-14T08:30:00Z"),
        subject: "s1b",
        additions: 0,
        deletions: 0,
        aiDescription: null,
      },
      {
        reportId: r2,
        repoId: repositoryId2,
        sha: "b1",
        authorEmail: "b@member.it",
        authorName: "B",
        committedAt: new Date("2026-07-14T09:00:00Z"),
        subject: "s2",
        additions: 40,
        deletions: 7,
        aiDescription: null,
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
        header: {
          commitCount: number;
          additions: number;
          deletions: number;
          projectCount: number;
        };
        byProject: { project: { id: string } }[];
      }[];
    };
    expect(body.developers).toHaveLength(1);
    const member = body.developers[0]!;
    expect(member.resolvedUser!.id).toBe(memberId);
    expect(member.header).toEqual({
      commitCount: 3,
      additions: 50,
      deletions: 10,
      projectCount: 2,
    });
    expect(member.byProject).toHaveLength(2);
  });

  it("più email dello stesso membro sullo STESSO progetto → byProject una riga", async () => {
    // Due email git dello stesso membro committano allo stesso progetto nello
    // stesso giorno: byProject deve aggregarle in UNA sola riga per quel
    // progetto, concatenando i commit (niente header progetto duplicati).
    await testDb.db.insert(gitIdentities).values([
      { userId: memberId, email: "a@member.it" },
      { userId: memberId, email: "b@member.it" },
    ]);

    const ins = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: DATE, status: "done" })
      .returning({ id: activityReports.id });
    const reportId = ins[0]!.id;

    await testDb.db.insert(activityCommits).values([
      {
        reportId,
        repoId: repositoryId,
        sha: "a1",
        authorEmail: "a@member.it",
        authorName: "A",
        committedAt: new Date("2026-07-14T08:00:00Z"),
        subject: "s1",
        additions: 10,
        deletions: 3,
        aiDescription: "Sommario A.",
      },
      {
        reportId,
        repoId: repositoryId,
        sha: "b1",
        authorEmail: "b@member.it",
        authorName: "B",
        committedAt: new Date("2026-07-14T09:00:00Z"),
        subject: "s2",
        additions: 40,
        deletions: 7,
        aiDescription: "Sommario B.",
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
        header: { commitCount: number; projectCount: number };
        byProject: {
          project: { id: string };
          commits: { sha: string }[];
        }[];
      }[];
    };
    expect(body.developers).toHaveLength(1);
    const member = body.developers[0]!;
    expect(member.resolvedUser!.id).toBe(memberId);
    expect(member.header.commitCount).toBe(2);
    expect(member.header.projectCount).toBe(1);
    expect(member.byProject).toHaveLength(1);
    const row = member.byProject[0]!;
    expect(row.project.id).toBe(projectId);
    expect(row.commits.map((c) => c.sha).sort()).toEqual(["a1", "b1"]);
  });

  it("developers con stesso commitCount → ordinati in modo deterministico per email", async () => {
    // Due dev NON risolti con lo stesso numero di commit (1 ciascuno): senza
    // tie-breaker l'ordine sarebbe arbitrario. Ci aspettiamo ordine alfabetico
    // per gitEmail: "aaa@x.it" prima di "zzz@x.it".
    const ins = await testDb.db
      .insert(activityReports)
      .values({ projectId, date: DATE, status: "done" })
      .returning({ id: activityReports.id });
    const reportId = ins[0]!.id;

    await testDb.db.insert(activityCommits).values([
      {
        reportId,
        repoId: repositoryId,
        sha: "z1",
        authorEmail: "zzz@x.it",
        authorName: "Zed",
        committedAt: new Date("2026-07-14T08:00:00Z"),
        subject: "s-z",
        additions: 1,
        deletions: 1,
        aiDescription: null,
      },
      {
        reportId,
        repoId: repositoryId,
        sha: "a1",
        authorEmail: "aaa@x.it",
        authorName: "Ann",
        committedAt: new Date("2026-07-14T09:00:00Z"),
        subject: "s-a",
        additions: 1,
        deletions: 1,
        aiDescription: null,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      developers: { gitEmail: string | null; header: { commitCount: number } }[];
    };
    expect(body.developers).toHaveLength(2);
    expect(body.developers.every((d) => d.header.commitCount === 1)).toBe(true);
    // Il commit "zzz" è cronologicamente primo, ma l'ordine finale è per email.
    expect(body.developers.map((d) => d.gitEmail)).toEqual(["aaa@x.it", "zzz@x.it"]);
  });

  it("report queued/running senza commit → appare in projects, developers vuoto", async () => {
    await testDb.db
      .insert(activityReports)
      .values({ projectId, date: DATE, status: "running" });

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projects: {
        project: { id: string };
        status: string;
        header: { commitCount: number };
        commits: unknown[];
      }[];
      developers: unknown[];
    };
    expect(body.projects).toHaveLength(1);
    const view = body.projects[0]!;
    expect(view.project.id).toBe(projectId);
    expect(view.status).toBe("running");
    expect(view.header.commitCount).toBe(0);
    expect(view.commits).toEqual([]);
    expect(body.developers).toEqual([]);
  });

  it("projects[].summary popolato dal report.summary (null se assente)", async () => {
    await seedReport();
    await testDb.db
      .update(activityReports)
      .set({ summary: "Riassunto del progetto per la giornata." })
      .where(eq(activityReports.projectId, projectId));

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: { summary: string | null }[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.summary).toBe("Riassunto del progetto per la giornata.");
  });

  it("projects[].summary null quando il report non ha summary", async () => {
    await seedReport();
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: { summary: string | null }[] };
    expect(body.projects[0]!.summary).toBeNull();
  });

  it("developers[].summary: risolto per userId, non risolto per gitEmail, null se assente", async () => {
    await seedReport();
    // Riassunto per il membro risolto (per userId) e per lo sconosciuto (per email).
    await testDb.db.insert(activityDevSummaries).values([
      { date: DATE, userId: memberId, summary: "Sintesi del membro." },
      { date: DATE, gitEmail: "stranger@x.it", summary: "Sintesi dello sconosciuto." },
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
        gitEmail: string | null;
        summary: string | null;
      }[];
    };
    const member = body.developers.find((d) => d.resolvedUser?.id === memberId)!;
    expect(member.summary).toBe("Sintesi del membro.");
    const stranger = body.developers.find((d) => d.resolvedUser === null)!;
    expect(stranger.summary).toBe("Sintesi dello sconosciuto.");
  });

  it("developers[].summary null quando manca la riga per il gruppo", async () => {
    await seedReport();
    // Solo il membro ha una riga: lo sconosciuto resta senza summary.
    await testDb.db
      .insert(activityDevSummaries)
      .values({ date: DATE, userId: memberId, summary: "Solo il membro." });

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as {
      developers: { resolvedUser: { id: string } | null; summary: string | null }[];
    };
    const stranger = body.developers.find((d) => d.resolvedUser === null)!;
    expect(stranger.summary).toBeNull();
  });

  it("developersSummaryPending true: report done + commit + nessun rollup", async () => {
    await seedReport();
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { developersSummaryPending: boolean };
    expect(body.developersSummaryPending).toBe(true);
  });

  it("developersSummaryPending false: rollup del giorno già presente", async () => {
    await seedReport();
    await testDb.db.insert(activityDayRollups).values({ date: DATE });
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { developersSummaryPending: boolean };
    expect(body.developersSummaryPending).toBe(false);
  });

  it("developersSummaryPending false: un report non è done (running)", async () => {
    await seedReport();
    // Aggiungo un secondo progetto con report ancora running: non tutti done.
    const { projectId: p2 } = await seedRepository(testDb.db);
    await testDb.db.insert(activityReports).values({ projectId: p2, date: DATE, status: "running" });

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { developersSummaryPending: boolean };
    expect(body.developersSummaryPending).toBe(false);
  });

  it("developersSummaryPending false: report done ma nessun commit", async () => {
    await testDb.db.insert(activityReports).values({ projectId, date: DATE, status: "done" });
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { developersSummaryPending: boolean };
    expect(body.developersSummaryPending).toBe(false);
  });

  it("developersSummaryPending false: giorno senza report", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { developersSummaryPending: boolean };
    expect(body.developersSummaryPending).toBe(false);
  });

  it("projects[].staleCommitCount dal report; staleCommitTotal = somma", async () => {
    await seedReport();
    // Il report del progetto ha 2 commit del giorno non ancora inclusi.
    await testDb.db
      .update(activityReports)
      .set({ staleCommitCount: 2 })
      .where(eq(activityReports.projectId, projectId));

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projects: { staleCommitCount: number }[];
      staleCommitTotal: number;
    };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.staleCommitCount).toBe(2);
    expect(body.staleCommitTotal).toBe(2);
  });

  it("staleCommitTotal somma lo stale di TUTTI i report del giorno", async () => {
    await seedReport();
    await testDb.db
      .update(activityReports)
      .set({ staleCommitCount: 2 })
      .where(eq(activityReports.projectId, projectId));
    // Secondo progetto con report done e 3 commit stale.
    const { projectId: p2 } = await seedRepository(testDb.db);
    await testDb.db
      .insert(activityReports)
      .values({ projectId: p2, date: DATE, status: "done", staleCommitCount: 3 });

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { staleCommitTotal: number };
    expect(body.staleCommitTotal).toBe(5);
  });

  it("staleCommitCount default 0 e staleCommitTotal 0 senza stale", async () => {
    await seedReport();
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as {
      projects: { staleCommitCount: number }[];
      staleCommitTotal: number;
    };
    expect(body.projects[0]!.staleCommitCount).toBe(0);
    expect(body.staleCommitTotal).toBe(0);
  });

  it("giorno senza report → staleCommitTotal 0", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/activity?date=${DATE}`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { staleCommitTotal: number };
    expect(body.staleCommitTotal).toBe(0);
  });
});

describe("POST /api/activity/generate", () => {
  // Data sicuramente NON futura (evita dipendenze dall'orologio reale del CI).
  const PAST_DATE = "2020-01-15";

  /** Data di domani (UTC) come YYYY-MM-DD. */
  function tomorrowUtc(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** Abilita `dailyReportEnabled` per i progetti indicati. */
  async function enable(ids: string[]): Promise<void> {
    for (const id of ids) {
      await testDb.db
        .update(projects)
        .set({ dailyReportEnabled: true })
        .where(eq(projects.id, id));
    }
  }

  it("senza sessione → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      payload: { date: PAST_DATE },
    });
    expect(res.statusCode).toBe(401);
  });

  it("member (non admin) → 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: memberCookie },
      payload: { date: PAST_DATE },
    });
    expect(res.statusCode).toBe(403);
  });

  it("data malformata/impossibile → 400 invalid_date", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: "2026-13-40" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_date");
  });

  it("data futura → 400 date_in_future", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: tomorrowUtc() },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("date_in_future");
  });

  it("accoda un report queued per ogni progetto abilitato (ignora i disabilitati)", async () => {
    // `projectId` (da beforeEach) resta disabilitato; ne creiamo due abilitati.
    const { projectId: p1 } = await seedRepository(testDb.db);
    const { projectId: p2 } = await seedRepository(testDb.db);
    await enable([p1, p2]);

    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { queued: number }).queued).toBe(2);

    const rows = await testDb.db
      .select({ projectId: activityReports.projectId, status: activityReports.status })
      .from(activityReports)
      .where(eq(activityReports.date, PAST_DATE));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    expect(rows.map((r) => r.projectId).sort()).toEqual([p1, p2].sort());
    // Il progetto disabilitato NON è stato accodato.
    expect(rows.some((r) => r.projectId === projectId)).toBe(false);
  });

  it("ri-chiamata stessa data → queued 0 (onConflictDoNothing, nessun doppione)", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    await enable([p1]);

    const first = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE },
    });
    expect((first.json() as { queued: number }).queued).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { queued: number }).queued).toBe(0);

    const rows = await testDb.db
      .select({ id: activityReports.id })
      .from(activityReports)
      .where(eq(activityReports.date, PAST_DATE));
    expect(rows).toHaveLength(1);
  });

  it("nessun progetto abilitato → queued 0", async () => {
    // Solo `projectId` da beforeEach, disabilitato.
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { queued: number }).queued).toBe(0);
  });

  it("force=false (default): report done esistente NON toccato, resta done", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    await enable([p1]);
    await testDb.db
      .insert(activityReports)
      .values({ projectId: p1, date: PAST_DATE, status: "done" });

    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE },
    });
    expect(res.statusCode).toBe(200);
    // Nessun report nuovo accodato: il done resta done.
    expect((res.json() as { queued: number }).queued).toBe(0);

    const rows = await testDb.db
      .select({ status: activityReports.status })
      .from(activityReports)
      .where(eq(activityReports.projectId, p1));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
  });

  it("force=true: report done → queued (stale azzerato); mancante → queued; running intoccato", async () => {
    // p1: report done con stale=4 → deve tornare queued e stale=0.
    // p2: report running → NON toccato.
    // p3: abilitato senza report → accodato queued.
    const { projectId: p1 } = await seedRepository(testDb.db);
    const { projectId: p2 } = await seedRepository(testDb.db);
    const { projectId: p3 } = await seedRepository(testDb.db);
    await enable([p1, p2, p3]);

    await testDb.db
      .insert(activityReports)
      .values({ projectId: p1, date: PAST_DATE, status: "done", staleCommitCount: 4 });
    await testDb.db
      .insert(activityReports)
      .values({ projectId: p2, date: PAST_DATE, status: "running" });

    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE, force: true },
    });
    expect(res.statusCode).toBe(200);
    // 1 nuovo (p3) + 1 forzato (p1). Il running (p2) non conta.
    expect((res.json() as { queued: number }).queued).toBe(2);

    const byProject = new Map(
      (
        await testDb.db
          .select({
            projectId: activityReports.projectId,
            status: activityReports.status,
            stale: activityReports.staleCommitCount,
          })
          .from(activityReports)
          .where(eq(activityReports.date, PAST_DATE))
      ).map((r) => [r.projectId, r]),
    );
    // p1: done → queued, stale azzerato.
    expect(byProject.get(p1)!.status).toBe("queued");
    expect(byProject.get(p1)!.stale).toBe(0);
    // p2: running intoccato.
    expect(byProject.get(p2)!.status).toBe("running");
    // p3: nuovo report queued.
    expect(byProject.get(p3)!.status).toBe("queued");
  });

  it("force=true: report failed → rimesso queued", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    await enable([p1]);
    await testDb.db
      .insert(activityReports)
      .values({ projectId: p1, date: PAST_DATE, status: "failed" });

    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE, force: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { queued: number }).queued).toBe(1);

    const rows = await testDb.db
      .select({ status: activityReports.status })
      .from(activityReports)
      .where(eq(activityReports.projectId, p1));
    expect(rows[0]!.status).toBe("queued");
  });

  it("force=true: report già queued NON viene ri-accodato (non conta)", async () => {
    const { projectId: p1 } = await seedRepository(testDb.db);
    await enable([p1]);
    await testDb.db
      .insert(activityReports)
      .values({ projectId: p1, date: PAST_DATE, status: "queued" });

    const res = await app.inject({
      method: "POST",
      url: "/api/activity/generate",
      headers: { cookie: adminCookie },
      payload: { date: PAST_DATE, force: true },
    });
    expect(res.statusCode).toBe(200);
    // Nulla di nuovo né forzato: resta l'unico queued esistente.
    expect((res.json() as { queued: number }).queued).toBe(0);

    const rows = await testDb.db
      .select({ id: activityReports.id })
      .from(activityReports)
      .where(eq(activityReports.projectId, p1));
    expect(rows).toHaveLength(1);
  });
});
