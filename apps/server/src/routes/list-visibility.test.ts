import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  activityCommits,
  activityDevSummaries,
  activityReports,
  agentRuns,
  agentSessions,
  aiJobs,
  backlogItemRequesters,
  backlogItems,
  backlogItemTickets,
  docPages,
  milestones,
  notifications,
  projectFollows,
  projectMembers,
  projects,
  repositories,
  roles,
  searchHistory,
  tickets,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Elenchi, ricerca, conteggi, utenti e inbox filtrati per progetto (Task 8,
 * design `docs/plans/2026-10-22-permessi-progetto-design.md`, «Gli elenchi
 * filtrano, non solo i dettagli»).
 *
 * Test a DUE UTENTI sugli stessi dati: ogni dato esiste sia nel progetto A sia
 * nel progetto B, e chi è membro di A soltanto non deve vedere nulla di B —
 * nemmeno ciò che ha chiesto lui stesso prima di perdere l'accesso (revoca a
 * lettura). Il full admin, membro implicito di ogni progetto, vede entrambi:
 * è la prova che il filtro c'è perché lo dice la regola, non perché i dati di
 * B mancano.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
/** Parola presente SOLO nei dati di test di questo file, in A e in B. */
const WORD = "zebrafind";
const DATE = "2026-07-14";

type Headers = { authorization: string };
interface TestUser {
  id: string;
  headers: Headers;
}

let testDb: TestDb;
let app: FastifyInstance;
let seeded: SeededUsers;
let projectA: string;
let projectB: string;
let repoA: string;
let repoB: string;
/** Legacy Member di A (ha tutti i `*.view_all`), non di B. */
let alice: TestUser;
/** Legacy Member di B. */
let bob: TestUser;
/** Contributor di A: senza `tickets.view_all` né `backlog.view_all`. */
let carol: TestUser;
/** Contributor di A con un ruolo d'istanza SENZA `users.view_all`. */
let dave: TestUser;
/** Project Lead di A (ha `project.usage.view`), senza `usage.view` d'istanza. */
let erin: TestUser;
/** Ruolo di progetto personalizzato in A: solo `repos.view` (niente `*.view_all`). */
let frank: TestUser;
let ticketAliceA: string;
let ticketOtherA: string;
let ticketCarolA: string;
let ticketAliceB: string;
let itemA: string;
let itemB: string;
let milestoneA: string;
let sessionAliceA: string;
let sessionCarolA: string;
let sessionItemA: string;

async function insertTicket(
  projectId: string,
  number: number,
  title: string,
  requestedByUserId: string | null,
  milestoneId: string | null = null,
): Promise<string> {
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
      milestoneId,
    })
    .returning({ id: tickets.id });
  return row!.id;
}

async function insertSession(projectId: string, ticketId: string, number: number): Promise<string> {
  const [job] = await testDb.db.insert(aiJobs).values({ ticketId, status: "pr_opened" }).returning();
  const [row] = await testDb.db
    .insert(agentSessions)
    .values({
      ownerKey: `ai_job:${job!.id}`,
      kind: "ai_job",
      title: `#${number} fix`,
      projectId,
      ticketId,
      aiJobId: job!.id,
    })
    .returning({ id: agentSessions.id });
  return row!.id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  seeded = await seedUsers(app);
  ({ projectId: projectA, repositoryId: repoA } = await seedRepository(testDb.db));
  ({ projectId: projectB, repositoryId: repoB } = await seedRepository(testDb.db));
  await testDb.db.update(projects).set({ name: `${WORD} Alfa` }).where(eq(projects.id, projectA));
  await testDb.db.update(projects).set({ name: `${WORD} Beta` }).where(eq(projects.id, projectB));
  await testDb.db.update(repositories).set({ name: `${WORD} repo A` }).where(eq(repositories.id, repoA));
  await testDb.db.update(repositories).set({ name: `${WORD} repo B` }).where(eq(repositories.id, repoB));

  alice = await createUserWithPat(app, "alice@example.com");
  bob = await createUserWithPat(app, "bob@example.com");
  carol = await createUserWithPat(app, "carol@example.com");
  dave = await createUserWithPat(app, "dave@example.com");
  erin = await createUserWithPat(app, "erin@example.com");
  await addMember(app, projectA, alice.id, "legacy_member");
  await addMember(app, projectB, bob.id, "legacy_member");
  await addMember(app, projectA, carol.id, "contributor");
  await addMember(app, projectA, dave.id, "contributor");
  await addMember(app, projectA, erin.id, "project_lead");
  frank = await createUserWithPat(app, "frank@example.com");
  const [reposOnly] = await testDb.db
    .insert(roles)
    .values({ name: "Solo repository", scope: "project", permissions: ["repos.view"] })
    .returning({ id: roles.id });
  await testDb.db.insert(projectMembers).values({ projectId: projectA, userId: frank.id, roleId: reposOnly!.id });
  // Ruolo d'istanza personalizzato SENZA `users.view_all` (il preset `User`
  // ce l'ha, ruling R1).
  const [noDirectory] = await testDb.db
    .insert(roles)
    .values({ name: "Senza rubrica", scope: "instance", permissions: ["monitor.view"] })
    .returning({ id: roles.id });
  await testDb.db.update(users).set({ instanceRoleId: noDirectory!.id }).where(eq(users.id, dave.id));

  const [milestone] = await testDb.db
    .insert(milestones)
    .values({ projectId: projectA, name: "M1" })
    .returning({ id: milestones.id });
  milestoneA = milestone!.id;
  ticketAliceA = await insertTicket(projectA, 1, `${WORD} di Alice in A`, alice.id, milestoneA);
  ticketOtherA = await insertTicket(projectA, 2, `${WORD} altrui in A`, bob.id);
  ticketCarolA = await insertTicket(projectA, 3, `${WORD} di Carol in A`, carol.id, milestoneA);
  // Chiesto da Alice, ma in un progetto che non vede (più).
  ticketAliceB = await insertTicket(projectB, 1, `${WORD} di Alice in B`, alice.id);

  const [a] = await testDb.db
    .insert(backlogItems)
    .values({ projectId: projectA, title: `${WORD} voce A`, source: "manual" })
    .returning({ id: backlogItems.id });
  const [b] = await testDb.db
    .insert(backlogItems)
    .values({ projectId: projectB, title: `${WORD} voce B`, source: "manual" })
    .returning({ id: backlogItems.id });
  itemA = a!.id;
  itemB = b!.id;
  await testDb.db.insert(backlogItemRequesters).values([
    { itemId: itemA, userId: alice.id },
    { itemId: itemA, userId: carol.id },
    { itemId: itemB, userId: alice.id },
  ]);
  await testDb.db.insert(backlogItemTickets).values([
    { itemId: itemA, ticketId: ticketAliceA, role: "origin" },
    { itemId: itemA, ticketId: ticketCarolA, role: "origin" },
  ]);

  sessionAliceA = await insertSession(projectA, ticketAliceA, 1);
  sessionCarolA = await insertSession(projectA, ticketCarolA, 3);
  const [itemSession] = await testDb.db
    .insert(agentSessions)
    .values({
      ownerKey: `backlog_item:${itemA}`,
      kind: "backlog_item",
      title: "stima",
      projectId: projectA,
      backlogItemId: itemA,
    })
    .returning({ id: agentSessions.id });
  sessionItemA = itemSession!.id;
  // Un job fallito su un ticket ALTRUI: conta nel polso solo per chi ha
  // `tickets.view_all`.
  await testDb.db.insert(aiJobs).values({ ticketId: ticketOtherA, status: "failed" });

  await testDb.db.insert(docPages).values([
    { repositoryId: repoA, kind: "technical", slug: "pagina-a", title: `${WORD} A`, body: `Il ${WORD} di A.`, isManual: true },
    { repositoryId: repoB, kind: "technical", slug: "pagina-b", title: `${WORD} B`, body: `Il ${WORD} di B.`, isManual: true },
  ]);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function get(user: TestUser | { headers: { cookie: string } }, url: string) {
  return app.inject({ method: "GET", url, headers: user.headers });
}

const admin = () => ({ headers: { cookie: seeded.adminCookie } });

describe("progetti e polso", () => {
  it("GET /api/projects: solo i progetti di cui si è membri; il full admin li vede tutti", async () => {
    const aliceIds = ((await get(alice, "/api/projects")).json() as { id: string }[]).map((p) => p.id);
    expect(aliceIds).toContain(projectA);
    expect(aliceIds).not.toContain(projectB);
    const adminIds = ((await get(admin(), "/api/projects")).json() as { id: string }[]).map((p) => p.id);
    expect(adminIds).toEqual(expect.arrayContaining([projectA, projectB]));
  });

  it("GET /api/projects/pulse: i progetti visibili, non quelli seguiti", async () => {
    // Il member di `seedUsers` non è membro di nulla: seguire B non gli dà B.
    await testDb.db.insert(projectFollows).values({ userId: seeded.memberId, projectId: projectB });
    const memberPulse = await get({ headers: { cookie: seeded.memberCookie } }, "/api/projects/pulse");
    expect(memberPulse.statusCode).toBe(200);
    expect(memberPulse.json()).toEqual([]);

    // Alice non segue nulla, ma è membro di A.
    const ids = ((await get(alice, "/api/projects/pulse")).json() as { projectId: string }[]).map(
      (p) => p.projectId,
    );
    expect(ids).toEqual([projectA]);
  });
});

describe("polso: i ticket seguono `tickets.view_all`", () => {
  type Summary = {
    projectId: string;
    stalled: { ticketId: string; title: string }[];
    failedCount: number;
    waitingForMerge: unknown[];
    running: unknown[];
  };

  it("un Contributor vede il titolo dei SUOI ticket, non degli altrui, e conteggi coerenti", async () => {
    const forCarol = ((await get(carol, "/api/projects/pulse")).json() as Summary[]).find(
      (p) => p.projectId === projectA,
    )!;
    expect(forCarol.stalled.map((t) => t.ticketId)).toEqual([ticketCarolA]);
    // Il job fallito è su un ticket altrui: non si conta.
    expect(forCarol.failedCount).toBe(0);
    const raw = JSON.stringify(forCarol);
    expect(raw).not.toContain("altrui in A");
    expect(raw).not.toContain("di Alice in A");

    const forAlice = ((await get(alice, "/api/projects/pulse")).json() as Summary[]).find(
      (p) => p.projectId === projectA,
    )!;
    expect(forAlice.stalled.map((t) => t.ticketId).sort()).toEqual(
      [ticketAliceA, ticketOtherA, ticketCarolA].sort(),
    );
    expect(forAlice.failedCount).toBe(1);
  });
});

describe("ticket", () => {
  it("elenco, conteggio e filtri: niente di B, nemmeno i ticket chiesti da sé", async () => {
    const res = await get(alice, "/api/tickets?limit=50");
    const body = res.json() as { items: { id: string }[]; total: number };
    expect(body.items.map((t) => t.id).sort()).toEqual([ticketAliceA, ticketOtherA, ticketCarolA].sort());
    expect(body.total).toBe(3);

    const mine = (await get(alice, "/api/tickets?mine=true")).json() as { items: { id: string }[]; total: number };
    expect(mine.items.map((t) => t.id)).toEqual([ticketAliceA]);
    expect(mine.total).toBe(1);

    const onB = (await get(alice, `/api/tickets?projectId=${projectB}`)).json() as {
      items: unknown[];
      total: number;
    };
    expect(onB.items).toEqual([]);
    expect(onB.total).toBe(0);

    const adminBody = (await get(admin(), "/api/tickets?limit=50")).json() as { items: { id: string }[] };
    expect(adminBody.items.map((t) => t.id)).toContain(ticketAliceB);
  });

  it("milestone: senza `tickets.view_all` i conteggi contano solo i propri ticket", async () => {
    const forCarol = (await get(carol, `/api/milestones?projectId=${projectA}`)).json() as {
      id: string;
      counts: { total: number };
    }[];
    expect(forCarol.find((m) => m.id === milestoneA)?.counts.total).toBe(1);
    const detail = (await get(carol, `/api/milestones/${milestoneA}`)).json() as { counts: { total: number } };
    expect(detail.counts.total).toBe(1);

    const forAlice = (await get(alice, `/api/milestones?projectId=${projectA}`)).json() as {
      id: string;
      counts: { total: number };
    }[];
    expect(forAlice.find((m) => m.id === milestoneA)?.counts.total).toBe(2);
  });

});

describe("sessioni degli agenti (ruling R26)", () => {
  type List = { live: { id: string }[]; recent: { id: string }[] };
  const ids = (body: List) => [...body.live, ...body.recent].map((s) => s.id);
  const all = () => [sessionAliceA, sessionCarolA, sessionItemA];

  it("senza `repos.view` (Contributor) nessuna sessione: elenco vuoto, dettaglio ed eventi 404", async () => {
    const forCarol = ids((await get(carol, "/api/agent-sessions")).json() as List);
    for (const id of all()) {
      expect(forCarol).not.toContain(id);
      expect((await get(carol, `/api/agent-sessions/${id}`)).statusCode).toBe(404);
      expect((await get(carol, `/api/agent-sessions/${id}/events`)).statusCode).toBe(404);
    }
  });

  it("con `repos.view` e i `*.view_all` (Legacy Member) le vede tutte", async () => {
    const forAlice = ids((await get(alice, "/api/agent-sessions")).json() as List);
    expect(forAlice).toEqual(expect.arrayContaining(all()));
    expect((await get(alice, `/api/agent-sessions/${sessionItemA}/events`)).statusCode).toBe(200);
  });

  it("con `repos.view` ma senza `*.view_all`: niente sessioni di ticket o voci altrui", async () => {
    const forFrank = ids((await get(frank, "/api/agent-sessions")).json() as List);
    for (const id of all()) expect(forFrank).not.toContain(id);
    expect((await get(frank, `/api/agent-sessions/${sessionAliceA}`)).statusCode).toBe(404);
    expect((await get(frank, `/api/agent-sessions/${sessionItemA}`)).statusCode).toBe(404);
    expect((await get(frank, `/api/agent-sessions/${sessionItemA}/events`)).statusCode).toBe(404);

    // Diventato richiedente della voce, la sua sessione gli compare.
    await testDb.db.insert(backlogItemRequesters).values({ itemId: itemA, userId: frank.id });
    const after = ids((await get(frank, "/api/agent-sessions")).json() as List);
    expect(after).toContain(sessionItemA);
    expect((await get(frank, `/api/agent-sessions/${sessionItemA}/events`)).statusCode).toBe(200);
    await testDb.db
      .delete(backlogItemRequesters)
      .where(and(eq(backlogItemRequesters.itemId, itemA), eq(backlogItemRequesters.userId, frank.id)));
  });
});

describe("backlog", () => {
  it("elenco e conteggio: niente di B, nemmeno le voci di cui si è richiedenti", async () => {
    const body = (await get(alice, "/api/backlog")).json() as { items: { id: string }[]; total: number };
    expect(body.items.map((i) => i.id)).toEqual([itemA]);
    expect(body.total).toBe(1);
    const mine = (await get(alice, "/api/backlog?mine=true")).json() as { items: { id: string }[] };
    expect(mine.items.map((i) => i.id)).toEqual([itemA]);

    const adminBody = (await get(admin(), "/api/backlog")).json() as { items: { id: string }[] };
    expect(adminBody.items.map((i) => i.id)).toContain(itemB);
  });

  it("`ticketCount` segue `tickets.view_all`: senza, conta solo i propri", async () => {
    const forCarol = (await get(carol, "/api/backlog")).json() as {
      items: { id: string; ticketCount: number }[];
    };
    expect(forCarol.items.find((i) => i.id === itemA)?.ticketCount).toBe(1);
    const forAlice = (await get(alice, "/api/backlog")).json() as {
      items: { id: string; ticketCount: number }[];
    };
    expect(forAlice.items.find((i) => i.id === itemA)?.ticketCount).toBe(2);
  });
});

describe("ricerca", () => {
  type Results = {
    tickets: { items: { id: string }[] };
    projects: { items: { id: string }[] };
    repositories: { items: { id: string }[] };
    docs: { items: { repositoryId: string }[] };
  };

  it("GET /api/search: ticket, progetti, repository e Docs solo dei progetti visibili", async () => {
    const res = await get(alice, `/api/search?q=${WORD}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Results;
    expect(body.tickets.items.map((t) => t.id).sort()).toEqual(
      [ticketAliceA, ticketOtherA, ticketCarolA].sort(),
    );
    expect(body.projects.items.map((p) => p.id)).toEqual([projectA]);
    expect(body.repositories.items.map((r) => r.id)).toEqual([repoA]);
    expect(body.docs.items.map((d) => d.repositoryId)).toEqual([repoA]);

    const adminBody = (await get(admin(), `/api/search?q=${WORD}`)).json() as Results;
    expect(adminBody.tickets.items.map((t) => t.id)).toContain(ticketAliceB);
    expect(adminBody.projects.items.map((p) => p.id)).toContain(projectB);
    expect(adminBody.repositories.items.map((r) => r.id)).toContain(repoB);
    expect(adminBody.docs.items.map((d) => d.repositoryId)).toContain(repoB);
  });

  it("GET /api/search: i ticket altrui seguono `tickets.view_all`", async () => {
    const body = (await get(carol, `/api/search?q=${WORD}`)).json() as Results;
    expect(body.tickets.items.map((t) => t.id)).toEqual([ticketCarolA]);
  });

  it("GET /api/search/docs-semantic: solo i Docs dei progetti con `docs.view`", async () => {
    const global = (await get(alice, `/api/search/docs-semantic?q=${WORD}`)).json() as {
      repositoryId: string;
    }[];
    expect(global.some((d) => d.repositoryId === repoA)).toBe(true);
    expect(global.some((d) => d.repositoryId === repoB)).toBe(false);

    const scopedB = await get(alice, `/api/search/docs-semantic?q=${WORD}&repositoryId=${repoB}`);
    expect(scopedB.statusCode).toBe(200);
    expect(scopedB.json()).toEqual([]);

    // Senza alcun progetto: niente, non tutta l'istanza.
    const none = await get({ headers: { cookie: seeded.memberCookie } }, `/api/search/docs-semantic?q=${WORD}`);
    expect(none.json()).toEqual([]);

    const adminGlobal = (await get(admin(), `/api/search/docs-semantic?q=${WORD}`)).json() as {
      repositoryId: string;
    }[];
    expect(adminGlobal.some((d) => d.repositoryId === repoB)).toBe(true);
  });

  it("cronologia: le voci di un progetto non visibile non si mostrano, ma restano", async () => {
    await testDb.db.insert(searchHistory).values([
      { userId: alice.id, type: "project", entityId: projectA, title: "A", route: "/a" },
      { userId: alice.id, type: "project", entityId: projectB, title: "B", route: "/b" },
      { userId: alice.id, type: "ticket", entityId: ticketAliceB, title: "tB", route: "/tb" },
      { userId: alice.id, type: "repository", entityId: repoB, title: "rB", route: "/rb" },
      { userId: alice.id, type: "doc", entityId: `${repoB}:pagina-b`, title: "dB", route: "/db", repositoryId: repoB },
      { userId: alice.id, type: "ticket", entityId: ticketAliceA, title: "tA", route: "/ta" },
    ]);
    const entries = (await get(alice, "/api/search/history")).json() as { entityId: string }[];
    expect(entries.map((e) => e.entityId).sort()).toEqual([projectA, ticketAliceA].sort());
    const rows = await testDb.db.select().from(searchHistory).where(eq(searchHistory.userId, alice.id));
    expect(rows).toHaveLength(6);
  });
});

describe("attività", () => {
  it("report e commit solo dei progetti visibili; il riassunto di chi ha lavorato altrove è nascosto", async () => {
    const [ra] = await testDb.db
      .insert(activityReports)
      .values({ projectId: projectA, date: DATE, status: "done", summary: "Giornata di A" })
      .returning({ id: activityReports.id });
    const [rb] = await testDb.db
      .insert(activityReports)
      .values({ projectId: projectB, date: DATE, status: "done", summary: "Giornata di B" })
      .returning({ id: activityReports.id });
    const commit = (reportId: string, repoId: string, sha: string, authorEmail: string) => ({
      reportId,
      repoId,
      sha,
      authorEmail,
      authorName: authorEmail,
      committedAt: new Date(`${DATE}T08:00:00Z`),
      subject: `commit ${sha}`,
      additions: 1,
      deletions: 0,
      aiDescription: null,
    });
    await testDb.db.insert(activityCommits).values([
      commit(ra!.id, repoA, "a1", "shared@dev.it"),
      commit(ra!.id, repoA, "a2", "onlya@dev.it"),
      commit(rb!.id, repoB, "b1", "shared@dev.it"),
    ]);
    await testDb.db.insert(activityDevSummaries).values([
      { date: DATE, gitEmail: "shared@dev.it", summary: "Ha lavorato su A e su B" },
      { date: DATE, gitEmail: "onlya@dev.it", summary: "Ha lavorato su A" },
    ]);

    type Body = {
      projects: { project: { id: string } }[];
      developers: {
        gitEmail: string | null;
        summary: string | null;
        byProject: { project: { id: string } }[];
      }[];
    };
    const body = (await get(alice, `/api/activity?date=${DATE}`)).json() as Body;
    expect(body.projects.map((p) => p.project.id)).toEqual([projectA]);
    const shared = body.developers.find((d) => d.gitEmail === "shared@dev.it");
    expect(shared?.byProject.map((p) => p.project.id)).toEqual([projectA]);
    expect(shared?.summary).toBeNull();
    expect(body.developers.find((d) => d.gitEmail === "onlya@dev.it")?.summary).toBe("Ha lavorato su A");

    const adminBody = (await get(admin(), `/api/activity?date=${DATE}`)).json() as Body;
    expect(adminBody.projects.map((p) => p.project.id).sort()).toEqual([projectA, projectB].sort());
    expect(adminBody.developers.find((d) => d.gitEmail === "shared@dev.it")?.summary).toBe(
      "Ha lavorato su A e su B",
    );
  });
});

describe("consumi", () => {
  it("con `project.usage.view` solo quei progetti; senza alcun permesso 403", async () => {
    const run = (projectId: string | null, costUsd: string) => ({
      operation: "summary",
      projectId,
      model: "claude-test",
      inputTokens: 10,
      outputTokens: 1,
      costUsd,
    });
    await testDb.db.insert(agentRuns).values([run(projectA, "1"), run(projectB, "2"), run(null, "4")]);

    type Costs = { totals: { costUsd: number }; byProject: { projectId: string | null }[] };
    const res = await get(erin, "/api/ai-usage/costs");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Costs;
    expect(body.totals.costUsd).toBe(1);
    expect(body.byProject.map((p) => p.projectId)).toEqual([projectA]);

    const breakdown = (await get(erin, "/api/ai-usage/breakdown?groupBy=project")).json() as {
      rows: { key: string | null }[];
    };
    expect(breakdown.rows.map((r) => r.key)).toEqual([projectA]);

    const adminBody = (await get(admin(), "/api/ai-usage/costs")).json() as Costs;
    expect(adminBody.totals.costUsd).toBe(7);

    // Alice (Legacy Member) non ha `project.usage.view` né `usage.view`.
    expect((await get(alice, "/api/ai-usage/costs")).statusCode).toBe(403);
    expect((await get(alice, "/api/ai-usage/breakdown?groupBy=project")).statusCode).toBe(403);
  });
});

describe("utenti", () => {
  it("senza `users.view_all`: sé stessi, chi condivide un progetto e i full admin", async () => {
    const res = await get(dave, "/api/users");
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { id: string }[]).map((u) => u.id);
    expect(ids.sort()).toEqual([seeded.adminId, alice.id, carol.id, dave.id, erin.id, frank.id].sort());
    expect(ids).not.toContain(bob.id);
    expect(ids).not.toContain(seeded.memberId);
  });

  it("con `users.view_all` (preset User): tutti", async () => {
    const ids = ((await get(alice, "/api/users")).json() as { id: string }[]).map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([bob.id, seeded.memberId, dave.id]));
  });
});

describe("preferiti (follow)", () => {
  it("GET mostra solo i progetti visibili; PUT non vede né cancella gli altri", async () => {
    await testDb.db.insert(projectFollows).values([
      { userId: alice.id, projectId: projectA },
      { userId: alice.id, projectId: projectB },
    ]);
    expect((await get(alice, "/api/me/follows")).json()).toEqual({ projectIds: [projectA] });

    const putB = await app.inject({
      method: "PUT",
      url: "/api/me/follows",
      headers: alice.headers,
      payload: { projectIds: [projectB] },
    });
    expect(putB.statusCode).toBe(400);

    const clear = await app.inject({
      method: "PUT",
      url: "/api/me/follows",
      headers: alice.headers,
      payload: { projectIds: [] },
    });
    expect(clear.statusCode).toBe(204);
    const rows = await testDb.db.select().from(projectFollows).where(eq(projectFollows.userId, alice.id));
    // Il follow di B resta in tabella (revoca a lettura).
    expect(rows.map((r) => r.projectId)).toEqual([projectB]);
  });
});

describe("inbox", () => {
  const planReview = {
    kind: "job.plan_review",
    ticketNumber: 1,
    ticketTitle: "Piano",
    projectName: "p",
    ticketUrl: "https://stubwise.test/tickets/1",
  };
  const google = {
    kind: "google.proposal",
    proposalId: "0f5c9d31-6666-4777-8888-999900001111",
    source: "email",
    messageUrl: "https://mail.google.com/mail/u/0/#all/1",
    projectName: "p",
    signal: "request",
    from: "Laura <laura@cliente.test>",
    subject: "Export",
    receivedAt: "2026-09-07T08:14:00.000Z",
    question: "Come diamo seguito?",
    options: [{ label: "Non fare nulla", consequence: "Niente." }],
    actions: [{ type: "ignore" }],
    recommendedIndex: 0,
    allowFreeText: false,
  };

  async function seedCard(
    kind: "job.plan_review" | "google.proposal",
    projectId: string | null,
  ): Promise<string> {
    const [row] = await testDb.db
      .insert(notifications)
      .values({
        userId: alice.id,
        kind,
        event: kind === "google.proposal" ? google : planReview,
        projectId,
        ticketId: projectId === projectB ? ticketAliceB : null,
        status: "open",
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  it("CARD VECCHIA senza project_id: il progetto si ricava dal ticket, e chi non è membro non la vede", async () => {
    // Card pubblicate prima della colonna `project_id` (pre-T10): esistono in
    // produzione con `project_id` nullo ma con il ticket. Il filtro deve
    // ricavare il progetto dal ticket, non trattarle come eventi d'istanza.
    const [old] = await testDb.db
      .insert(notifications)
      .values({
        userId: carol.id,
        kind: "job.plan_review",
        event: planReview,
        projectId: null,
        ticketId: ticketAliceB,
        status: "open",
      })
      .returning({ id: notifications.id });
    const [instance] = await testDb.db
      .insert(notifications)
      .values({ userId: carol.id, kind: "job.plan_review", event: planReview, projectId: null, status: "open" })
      .returning({ id: notifications.id });

    const body = (await get(carol, "/api/inbox")).json() as { items: { id: string }[]; total: number };
    expect(body.items.map((i) => i.id)).toEqual([instance!.id]);
    expect(body.total).toBe(1);
    expect((await get(carol, "/api/inbox/unread-count")).json()).toEqual({ count: 1 });
    const post = (url: string) => app.inject({ method: "POST", url, headers: carol.headers });
    expect((await post(`/api/inbox/${old!.id}/read`)).statusCode).toBe(404);
    expect((await post(`/api/inbox/${old!.id}/actions/approve_plan`)).statusCode).toBe(404);

    // Il full admin (membro implicito di B) la vedrebbe: la stessa card,
    // riassegnata a lui, compare.
    await testDb.db.update(notifications).set({ userId: seeded.adminId }).where(eq(notifications.id, old!.id));
    const adminList = (await get(admin(), "/api/inbox")).json() as { items: { id: string }[] };
    expect(adminList.items.map((i) => i.id)).toContain(old!.id);
  });

  it("le card di un progetto non più visibile non si elencano, non si contano, e le azioni danno 404", async () => {
    const onA = await seedCard("job.plan_review", projectA);
    const onB = await seedCard("job.plan_review", projectB);
    const mailOnB = await seedCard("google.proposal", projectB);
    const instance = await seedCard("job.plan_review", null);

    const list = await get(alice, "/api/inbox");
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: { id: string }[]; total: number };
    expect(body.items.map((i) => i.id).sort()).toEqual([onA, mailOnB, instance].sort());
    expect(body.total).toBe(3);
    expect((await get(alice, "/api/inbox/unread-count")).json()).toEqual({ count: 3 });

    const post = (url: string, payload?: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: alice.headers, ...(payload ? { payload } : {}) });
    expect((await post(`/api/inbox/${onB}/read`)).statusCode).toBe(404);
    expect((await post(`/api/inbox/${onB}/snooze`, { until: "1h" })).statusCode).toBe(404);
    expect((await post(`/api/inbox/${onB}/handled`)).statusCode).toBe(404);
    expect((await post(`/api/inbox/${onB}/actions/approve_plan`)).statusCode).toBe(404);

    // La riga non è stata riscritta.
    const [row] = await testDb.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, onB), eq(notifications.userId, alice.id)));
    expect(row?.status).toBe("open");
    expect(row?.readAt).toBeNull();

    // Torna membro di B: la card riappare, nessuna riga da ripristinare.
    await addMember(app, projectB, alice.id, "legacy_member");
    const again = (await get(alice, "/api/inbox")).json() as { items: { id: string }[] };
    expect(again.items.map((i) => i.id)).toContain(onB);
  });
});
