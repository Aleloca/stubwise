import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  aiJobs,
  projectMembers,
  roles,
  instanceSettings,
  releaseCiRuns,
  encrypt,
  environmentServers,
  gitAccounts,
  prCorrections,
  prReviews,
  projects,
  projectEnvironments,
  releases,
  repositories,
  serverMetrics,
  servers,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, seedTicket, startTestDb } from "@stubwise/db/testing";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * Rotta di rilascio (fase 8, Task 9): il CANCELLO che rende vero il secondo
 * divieto della fase 7. `release.merge` verificato SIA come status SIA come
 * effetto (nessun merge partito), check rossi che bloccano, PR già chiusa
 * che risponde pulito.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PLAINTEXT_TOKEN = "token-git-in-chiaro-da-non-salvare";

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

const PR_URL = "https://github.com/acme/demo-shop/pull/42";
const PR_DETAIL_URL = "https://api.github.com/repos/acme/demo-shop/pulls/42";
const MERGE_URL = "https://api.github.com/repos/acme/demo-shop/pulls/42/merge";
const CHECK_RUNS_URL = "https://api.github.com/repos/acme/demo-shop/commits/headsha123/check-runs?per_page=100";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Repository + account GitHub con credenziali DAVVERO decifrabili, e un ticket con una PR aperta. */
async function seedOpenPr(overrides: { testStatus?: "passed" | "failed" | "skipped" | null } = {}) {
  const [account] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: "Account di test",
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: PLAINTEXT_TOKEN }), ENCRYPTION_KEY),
    })
    .returning();
  const { repositoryId, projectId } = await seedRepository(testDb.db, { provider: "github" });
  // Ricollega il repository all'account con credenziali VERE (seedRepository
  // ne crea uno con un blob placeholder non decifrabile).
  await testDb.db
    .update(repositories)
    .set({ gitAccountId: account!.id, repoUrl: "https://github.com/acme/demo-shop" })
    .where(eq(repositories.id, repositoryId));

  const { ticketId } = await seedTicket(testDb.db, { projectId, repositoryId });
  const [tr] = await testDb.db
    .insert(ticketRepositories)
    .values({
      ticketId,
      repositoryId,
      branch: "stubwise/ticket-1",
      prUrl: PR_URL,
      prState: "open",
      testStatus: overrides.testStatus ?? "passed",
    })
    .returning();

  return { ticketId, repositoryId, projectId, trId: tr!.id };
}

/**
 * Repository + account con credenziali vere e un ticket, ma NESSUNA riga
 * `ticket_repositories` — solo una review completata (review fix Task 1):
 * rappresenta una PR aperta a mano fuori da Stubwise, che riceve verdetto e
 * riassunto dalla PR review automatica ma nessun test interno né rischio.
 */
async function seedExternalPr(
  overrides: { prUrl?: string; prNumber?: number; verdict?: "approve" | "request_changes" | null; targetBranch?: string | null } = {},
) {
  const [account] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: "Account esterno di test",
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: PLAINTEXT_TOKEN }), ENCRYPTION_KEY),
    })
    .returning();
  const { repositoryId, projectId } = await seedRepository(testDb.db, { provider: "github" });
  await testDb.db
    .update(repositories)
    .set({ gitAccountId: account!.id, repoUrl: "https://github.com/acme/demo-shop" })
    .where(eq(repositories.id, repositoryId));

  const { ticketId } = await seedTicket(testDb.db, { projectId, repositoryId });
  const prNumber = overrides.prNumber ?? 77;
  const prUrl = overrides.prUrl ?? `https://github.com/acme/demo-shop/pull/${prNumber}`;
  await testDb.db.insert(prReviews).values({
    repositoryId,
    ticketId,
    prNumber,
    prUrl,
    prTitle: "Fix esterno",
    headSha: "extsha123",
    status: "completed",
    // Una review completata è sempre partita (`runPrReview` scrive
    // `started_at` alla partenza; la 0081 ha fatto il backfill sulle storiche).
    startedAt: new Date(),
    verdict: overrides.verdict === undefined ? "approve" : overrides.verdict,
    prSummary: "Cambia solo un typo.",
    // Il ramo su cui la PR andrà (review della F1: senza, il merge non registra
    // il rilascio). `main` è il ramo di default, quindi di rilascio.
    targetBranch: overrides.targetBranch === undefined ? "main" : overrides.targetBranch,
  });

  return { ticketId, repositoryId, prNumber, prUrl };
}

/**
 * La riga `pr_reviews` che il poller crea al CLAIM (C10): `running`,
 * `started_at` null, NESSUN ticket (lo risolve `runPrReview` alla fine),
 * nessun verdetto. `createdAt` esplicito e DOPO quello della review completata:
 * col default `now()` due insert ravvicinati possono avere lo stesso istante, e
 * il test non riprodurrebbe la condizione del difetto («la più recente è quella
 * in attesa») — vedi la trappola (c) del mutation testing in CLAUDE.md.
 */
async function seedWaitingReview(input: { repositoryId: string; prNumber: number; prUrl: string }) {
  await testDb.db.insert(prReviews).values({
    repositoryId: input.repositoryId,
    ticketId: null,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    prTitle: "Fix in attesa di review",
    headSha: "waitingsha456",
    status: "running",
    startedAt: null,
    verdict: null,
    createdAt: new Date(Date.now() + 60_000),
  });
}

function release(ticketId: string, repositoryId: string, cookie: string) {
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
    headers: { cookie },
  });
}

/** Mock fetch per una PR ESTERNA aperta senza check (dettaglio + check-runs vuoti). */
function externalFetch(prNumber: number) {
  const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
  const checksUrl = "https://api.github.com/repos/acme/demo-shop/commits/extheadsha/check-runs?per_page=100";
  return vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === detailUrl && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ state: "open", head: { sha: "extheadsha" } }), { status: 200 }),
      );
    }
    if (url === checksUrl && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
}

/** Mock fetch che risponde verde (check-runs + merge) su TUTTE le richieste GitHub coinvolte. */
function greenFetch() {
  return vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === PR_DETAIL_URL && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ state: "open", head: { sha: "headsha123" } }), { status: 200 }),
      );
    }
    if (url === CHECK_RUNS_URL && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
          { status: 200 },
        ),
      );
    }
    if (url === MERGE_URL && method === "PUT") {
      return Promise.resolve(
        new Response(JSON.stringify({ merged: true, sha: "deadbeef" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  });
}

describe("POST /api/tickets/:id/repositories/:repositoryId/release", () => {
  it("senza release.merge (Legacy Member, Developer del progetto) → 403, e nessun merge parte (fetch mai chiamata)", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    await addMember(app, projectId, memberId);
    const developer = await createUserWithPat(app, `dev-${randomUUID()}@example.com`);
    await addMember(app, projectId, developer.id, "developer");
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    for (const headers of [{ cookie: memberCookie }, developer.headers]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { code: string }).code).toBe("forbidden");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await testDb.db
      .select({ prState: ticketRepositories.prState })
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(row?.prState).toBe("open");
  });

  it("non membro del progetto → 404 (non 403), e nessun merge parte", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const outsider = await createUserWithPat(app, `fuori-${randomUUID()}@example.com`);
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un Project Lead (non admin d'istanza) rilascia: release.merge è il permesso, non il ruolo", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    const lead = await createUserWithPat(app, `lead-${randomUUID()}@example.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
      headers: lead.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls.some((c) => c[0] === MERGE_URL)).toBe(true);
  });

  it("senza sessione: 401, nessun merge parte", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
    });

    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("review F1: la PR di un COLLEGA (riga del ticket review) si registra col SUO target e titolo; verso develop niente rilascio, verso main sì", async () => {
    for (const [target, expected] of [["develop", null], ["main", /-V\d+$/]] as const) {
      const { ticketId, repositoryId, trId } = await seedOpenPr();
      await testDb.db.update(tickets).set({ type: "review", title: "PR Review: Feature X (#42)" }).where(eq(tickets.id, ticketId));
      await testDb.db.update(ticketRepositories).set({ branch: "feature-x", adoptedAt: new Date() }).where(eq(ticketRepositories.id, trId));
      await testDb.db.insert(prReviews).values({ repositoryId, ticketId, prNumber: 42, prUrl: PR_URL, prTitle: "Feature X", headSha: "headsha123", status: "completed", sourceBranch: "feature-x", targetBranch: target });
      vi.stubGlobal("fetch", greenFetch());
      const res = await release(ticketId, repositoryId, adminCookie);
      expect(res.statusCode).toBe(200);
      const rows = await testDb.db.select().from(releases).where(eq(releases.repositoryId, repositoryId));
      if (expected === null) {
        expect(res.json()).toMatchObject({ releaseCode: null });
        expect(rows).toEqual([]);
      } else {
        expect((res.json() as { releaseCode: string }).releaseCode).toMatch(expected);
        expect(rows).toEqual([expect.objectContaining({ title: "Feature X" })]);
      }
    }
  });

  it("area 8, F1: un merge che non è sul ramo di rilascio non fa un rilascio, e la risposta lo dice (releaseCode null)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db.update(repositories).set({ releaseBranch: "production" }).where(eq(repositories.id, repositoryId));
    vi.stubGlobal("fetch", greenFetch());

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.json()).toEqual({ merged: true, sha: "deadbeef", releaseCode: null });
  });

  it("l'admin rilascia: check verdi → 200 { merged: true, sha }", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(200);
    // Area 8, F1: il merge sul ramo di rilascio (il default) fa nascere il rilascio, e la risposta lo dice.
    expect(res.json()).toEqual({ merged: true, sha: "deadbeef", releaseCode: expect.stringMatching(/-V\d+$/) });
    // I check sono stati DAVVERO letti verdi (non degradati a no_checks):
    // altrimenti questo test passerebbe anche con un check-runs rotto.
    expect(fetchMock.mock.calls.some((c) => c[0] === CHECK_RUNS_URL)).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0] === MERGE_URL)).toBe(true);
  });

  it("area 8, F1: il merge da Stubwise crea il rilascio, via Stubwise, col commit di merge (il webhook dopo non ne crea un secondo)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    expect((await release(ticketId, repositoryId, adminCookie)).statusCode).toBe(200);
    const rows = await testDb.db.select().from(releases).where(eq(releases.repositoryId, repositoryId));
    expect(rows).toEqual([expect.objectContaining({ viaStubwise: true, mergeSha: "deadbeef" })]);
    expect(rows[0]!.mergedBy).not.toBeNull();
  });

  it("check rossi: 409 checks_failed, NESSUNA chiamata di merge", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ head: { sha: "headsha123" } }), { status: 200 }));
      }
      if (url === CHECK_RUNS_URL && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("unexpected call", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("checks_failed");
    expect(fetchMock.mock.calls.some((c) => c[0] === MERGE_URL)).toBe(false);
  });

  it("PR già chiusa (prState != open): 409 already_closed, nessuna chiamata al provider", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db
      .update(ticketRepositories)
      .set({ prState: "merged" })
      .where(eq(ticketRepositories.ticketId, ticketId));
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("already_closed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nessuna riga ticket_repositories per (ticket, repo): 404", async () => {
    const missingUuid = "00000000-0000-0000-0000-000000000000";
    const { ticketId } = await seedOpenPr();
    const res = await release(ticketId, missingUuid, adminCookie);
    expect(res.statusCode).toBe(404);
  });

  it("il provider rifiuta il merge (405) e la rilettura conferma la PR ancora APERTA → 409 not_mergeable", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    // PR_DETAIL_URL è chiamata DUE volte: dentro getPullRequestChecks (per
    // headSha/check-runs) e di nuovo dentro la rilettura post-405 (per lo
    // stato) — entrambe con `state: "open"`, quindi la rilettura CONFERMA
    // che non era una PR già chiusa da qualcun altro.
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ state: "open", head: { sha: "headsha123" } }), { status: 200 }),
        );
      }
      if (url === CHECK_RUNS_URL && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
      }
      if (url === MERGE_URL && method === "PUT") {
        return Promise.resolve(new Response("not mergeable", { status: 405 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("not_mergeable");
    const [row] = await testDb.db
      .select({ prState: ticketRepositories.prState })
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(row?.prState).toBe("open");
  });

  it("il provider rifiuta il merge (405) ma la rilettura dice CHIUSA → 409 already_closed, non not_mergeable (review fix Task 4)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        // Ogni MergeFailureReason ("not_mergeable" incluso) copre sia
        // conflitti reali sia una PR già mergiata da qualcun altro — GitHub
        // e Bitbucket non li distinguono nello status HTTP del fallimento
        // del merge. La rilettura live qui è quella che decide davvero.
        return Promise.resolve(
          new Response(JSON.stringify({ state: "closed", head: { sha: "headsha123" } }), { status: 200 }),
        );
      }
      if (url === CHECK_RUNS_URL && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
      }
      if (url === MERGE_URL && method === "PUT") {
        return Promise.resolve(new Response("not mergeable", { status: 405 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("already_closed");
  });

  it("check illeggibili (errore di rete): 409 checks_unreadable, NESSUNA chiamata di merge (review fix Task 2)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        // La PR si risolve, ma i check-runs falliscono: `unknown`, MAI
        // `no_checks` — un errore di lettura non è un'assenza di check.
        return Promise.resolve(
          new Response(JSON.stringify({ state: "open", head: { sha: "headsha123" } }), { status: 200 }),
        );
      }
      if (url === CHECK_RUNS_URL && method === "GET") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("checks_unreadable");
    expect(fetchMock.mock.calls.some((c) => c[0] === MERGE_URL)).toBe(false);
  });

  it("PR esterna (nessuna riga ticket_repositories, solo una review): l'admin la rilascia lo stesso (review fix Task 1)", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr();
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    const checksUrl = `https://api.github.com/repos/acme/demo-shop/commits/extheadsha/check-runs?per_page=100`;
    const mergeUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}/merge`;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === detailUrl && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ state: "open", head: { sha: "extheadsha" } }), { status: 200 }),
        );
      }
      if (url === checksUrl && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
            { status: 200 },
          ),
        );
      }
      if (url === mergeUrl && method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ merged: true, sha: "extdeadbeef" }), { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merged: true, sha: "extdeadbeef", releaseCode: expect.stringMatching(/-V\d+$/) });
  });

  it("review F1: PR esterna col target IGNOTO (la review non lo sa): il merge c'è, ma nessun rilascio qui (lo registra il webhook)", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr({ targetBranch: null });
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    const checksUrl = `https://api.github.com/repos/acme/demo-shop/commits/extheadsha/check-runs?per_page=100`;
    const mergeUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}/merge`;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === detailUrl && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ state: "open", head: { sha: "extheadsha" } }), { status: 200 }),
        );
      }
      if (url === checksUrl && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
            { status: 200 },
          ),
        );
      }
      if (url === mergeUrl && method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ merged: true, sha: "extdeadbeef" }), { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merged: true, sha: "extdeadbeef", releaseCode: null });
    expect(await testDb.db.select().from(releases).where(eq(releases.repositoryId, repositoryId))).toEqual([]);
  });

  it("PR esterna già chiusa sul provider: 409 already_closed, nessuna chiamata di merge", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr({ prNumber: 78 });
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === detailUrl && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ state: "closed" }), { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("already_closed");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/merge"))).toBe(false);
  });

  it("nessuna riga in NESSUNA delle due sorgenti per (ticket, repo): 404", async () => {
    const { ticketId } = await seedTicket(testDb.db);
    const { repositoryId } = await seedRepository(testDb.db);
    const res = await release(ticketId, repositoryId, adminCookie);
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/release-queue", () => {
  it("'una pagina per chi rilascia': solo le PR dei progetti in cui si ha release.merge", async () => {
    const lead = await createUserWithPat(app, `lead-coda-${randomUUID()}@example.com`);
    const mine = await seedOpenPr();
    const others = await seedOpenPr();
    await addMember(app, mine.projectId, lead.id, "project_lead");
    // Il Legacy Member vede il progetto ma non può rilasciare: coda vuota.
    await addMember(app, mine.projectId, memberId);
    vi.stubGlobal("fetch", greenFetch());

    const asLead = await app.inject({ method: "GET", url: "/api/release-queue", headers: lead.headers });
    expect(asLead.statusCode).toBe(200);
    const leadIds = (asLead.json() as { items: { ticketId: string }[] }).items.map((i) => i.ticketId);
    expect(leadIds).toContain(mine.ticketId);
    expect(leadIds).not.toContain(others.ticketId);

    const asMember = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: memberCookie } });
    expect(asMember.statusCode).toBe(200);
    expect((asMember.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("elenca una PR aperta con testStatus/risk letti dalla riga, e i check letti LIVE", async () => {
    const { ticketId, trId } = await seedOpenPr({ testStatus: "passed" });
    await testDb.db
      .update(ticketRepositories)
      .set({ risk: "low", riskReason: "nessun file sensibile, un solo repository" })
      .where(eq(ticketRepositories.id, trId));
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { ticketId: string; testStatus: string; risk: string; checks: { status: string } }[] };
    const item = body.items.find((i) => i.ticketId === ticketId);
    expect(item).toBeDefined();
    expect(item!.testStatus).toBe("passed");
    expect(item!.risk).toBe("low");
    expect(item!.checks.status).toBe("success");
  });

  it("una PR chiusa non compare in coda", async () => {
    const { ticketId } = await seedOpenPr();
    await testDb.db
      .update(ticketRepositories)
      .set({ prState: "merged" })
      .where(eq(ticketRepositories.ticketId, ticketId));
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as { items: { ticketId: string }[] };
    expect(body.items.some((i) => i.ticketId === ticketId)).toBe(false);
  });

  it("credenziali non decifrabili: la riga resta in lista, degradata a no_checks (mai sparisce)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db
      .update(gitAccounts)
      .set({ encryptedCredentials: "non-decifrabile" })
      .where(
        eq(
          gitAccounts.id,
          (await testDb.db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]!
            .gitAccountId,
        ),
      );
    const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { ticketId: string; checks: { status: string } }[] };
    const item = body.items.find((i) => i.ticketId === ticketId);
    expect(item).toBeDefined();
    // Credenziali non decifrabili per QUESTA riga → nessuna lettura dei
    // check tentata per lei (altre righe della coda, seminate da test
    // precedenti nello stesso file, hanno le proprie credenziali valide e
    // possono legittimamente far scattare fetch: l'assenza di chiamata è
    // una proprietà DI QUESTA riga, non del mock globale).
    expect(item!.checks.status).toBe("no_checks");
  });

  // Review fix Task 1: "la coda mostra davvero tutte le PR aperte".
  // Le righe seminate da test PRECEDENTI in questo stesso file restano nel
  // DB condiviso: i loro ticket non sono mai stati chiusi (releasePullRequest
  // non scrive prState/status in locale, per design — vedi il docblock del
  // servizio), quindi possono comparire come candidati esterni "forse
  // aperti" e far scattare fetch verso URL non mockate qui, che 404 e
  // vengono scartate in silenzio: non è un problema per questi test, che
  // verificano solo presenza/assenza di righe specifiche per ticketId, mai
  // la lunghezza dell'array.

  it("una PR SOLO esterna compare in coda con origin: external, testStatus/risk NULL (non 'da calcolare')", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr({ prNumber: 201 });
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    const checksUrl = `https://api.github.com/repos/acme/demo-shop/commits/extheadsha/check-runs?per_page=100`;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === detailUrl && method === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify({ state: "open", head: { sha: "extheadsha" } }), { status: 200 }),
          );
        }
        if (url === checksUrl && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: {
        ticketId: string;
        origin: string;
        testStatus: string | null;
        risk: string | null;
        reviewVerdict: string | null;
        repositoryId: string;
      }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.origin).toBe("external");
    expect(item!.testStatus).toBeNull();
    expect(item!.risk).toBeNull();
    expect(item!.reviewVerdict).toBe("approve");
  });

  it("una PR presente in ENTRAMBE le sorgenti (stesso repository+numero PR) → una riga sola, origin stubwise", async () => {
    const { ticketId, repositoryId, trId } = await seedOpenPr({ testStatus: "passed" });
    await testDb.db
      .update(ticketRepositories)
      .set({ risk: "low", riskReason: "nessun file sensibile, un solo repository" })
      .where(eq(ticketRepositories.id, trId));
    // STESSO repository, STESSO numero PR (42, da PR_URL): la review
    // automatica gira anche sulle PR di Stubwise, non solo su quelle esterne.
    await testDb.db.insert(prReviews).values({
      repositoryId,
      ticketId,
      prNumber: 42,
      prUrl: PR_URL,
      prTitle: "Fix the bug",
      headSha: "headsha123",
      status: "completed",
      startedAt: new Date(),
      verdict: "approve",
      prSummary: "Cambia solo la formula del totale.",
    });
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; origin: string; testStatus: string | null }[];
    };
    const matches = body.items.filter((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.origin).toBe("stubwise");
    expect(matches[0]!.testStatus).toBe("passed");
  });

  it("una PR ADOTTATA (riga sul ticket review) → una riga sola, origin external: non l'ha aperta Stubwise", async () => {
    const { ticketId, trId } = await seedOpenPr({ testStatus: "passed" });
    await testDb.db.update(tickets).set({ type: "review" }).where(eq(tickets.id, ticketId));
    await testDb.db
      .update(ticketRepositories)
      .set({ branch: "feature/login", adoptedAt: new Date() })
      .where(eq(ticketRepositories.id, trId));
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as { items: { ticketId: string; origin: string; branch: string }[] };
    const matches = body.items.filter((i) => i.ticketId === ticketId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.origin).toBe("external");
    expect(matches[0]!.branch).toBe("feature/login");
  });

  it("una PR esterna chiusa sul provider non compare in coda", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr({ prNumber: 202 });
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === detailUrl && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ state: "closed" }), { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as { items: { ticketId: string; repositoryId: string }[] };
    expect(body.items.some((i) => i.ticketId === ticketId && i.repositoryId === repositoryId)).toBe(false);
  });

  it("un ticket di review già 'done': candidato scartato SENZA chiamare il provider per lui (filtro economico)", async () => {
    const { ticketId, repositoryId, prNumber } = await seedExternalPr({ prNumber: 203 });
    await testDb.db.update(tickets).set({ status: "done" }).where(eq(tickets.id, ticketId));
    const detailUrl = `https://api.github.com/repos/acme/demo-shop/pulls/${prNumber}`;
    const calledForThisPr: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url === detailUrl) calledForThisPr.push(url);
        return Promise.resolve(new Response("", { status: 404 }));
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as { items: { ticketId: string; repositoryId: string }[] };
    expect(body.items.some((i) => i.ticketId === ticketId && i.repositoryId === repositoryId)).toBe(false);
    expect(calledForThisPr).toHaveLength(0);
  });

  it("una review IN ATTESA (senza ticket) dopo una completata: la PR esterna resta in coda col verdetto della completata", async () => {
    const { ticketId, repositoryId, prNumber, prUrl } = await seedExternalPr({
      prNumber: 301,
      verdict: "request_changes",
    });
    await seedWaitingReview({ repositoryId, prNumber, prUrl });
    vi.stubGlobal("fetch", externalFetch(prNumber));

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; origin: string; reviewVerdict: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.origin).toBe("external");
    expect(item!.reviewVerdict).toBe("request_changes");
  });

  it("la coda considera solo le review CON ticket: una completata più recente senza ticket non fa sparire la PR esterna", async () => {
    // `pr_reviews.ticket_id` è ON DELETE SET NULL: anche una review completata
    // può restare senza ticket. Se vincesse la DISTINCT ON, la PR uscirebbe
    // dalla coda (non c'è un ticket da passare al rilascio); deve invece
    // vincere la più recente CON ticket, col suo verdetto.
    const { ticketId, repositoryId, prNumber, prUrl } = await seedExternalPr({
      prNumber: 304,
      verdict: "request_changes",
    });
    await testDb.db.insert(prReviews).values({
      repositoryId,
      ticketId: null,
      prNumber,
      prUrl,
      prTitle: "Fix esterno",
      headSha: "extsha304",
      status: "completed",
      startedAt: new Date(),
      verdict: "approve",
      createdAt: new Date(Date.now() + 60_000),
    });
    vi.stubGlobal("fetch", externalFetch(prNumber));

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; origin: string; reviewVerdict: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.origin).toBe("external");
    expect(item!.reviewVerdict).toBe("request_changes");
  });

  it("una review FALLITA dopo una completata non dà verdetto: la PR esterna tiene quello della completata", async () => {
    // Oggi `runPrReview` scrive il ticket solo all'esito completato, quindi una
    // fallita col ticket non nasce: la riga qui è costruita apposta, con un
    // verdetto residuo, per provare che il verdetto lo danno SOLO le completate.
    const { ticketId, repositoryId, prNumber, prUrl } = await seedExternalPr({
      prNumber: 302,
      verdict: "request_changes",
    });
    await testDb.db.insert(prReviews).values({
      repositoryId,
      ticketId,
      prNumber,
      prUrl,
      prTitle: "Fix esterno",
      headSha: "extsha789",
      status: "failed",
      startedAt: new Date(),
      verdict: "approve",
      error: "agente fallito",
      createdAt: new Date(Date.now() + 60_000),
    });
    vi.stubGlobal("fetch", externalFetch(prNumber));

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.reviewVerdict).toBe("request_changes");
  });

  it("una riga `completed` mai partita (`started_at` null) non dà verdetto, né alla PR esterna né a quella interna", async () => {
    // Stato che il worker non produce (una review completata è sempre partita):
    // costruito apposta per fissare che il verdetto richiede ANCHE `started_at`.
    const ext = await seedExternalPr({ prNumber: 303, verdict: "request_changes" });
    await testDb.db.insert(prReviews).values({
      repositoryId: ext.repositoryId,
      ticketId: ext.ticketId,
      prNumber: ext.prNumber,
      prUrl: ext.prUrl,
      prTitle: "Fix esterno",
      headSha: "extsha000",
      status: "completed",
      startedAt: null,
      verdict: "approve",
      createdAt: new Date(Date.now() + 60_000),
    });
    vi.stubGlobal("fetch", externalFetch(ext.prNumber));

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ext.ticketId && i.repositoryId === ext.repositoryId);
    expect(item).toBeDefined();
    expect(item!.reviewVerdict).toBe("request_changes");

    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db.insert(prReviews).values([
      {
        repositoryId,
        ticketId,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha123",
        status: "completed",
        startedAt: new Date(),
        verdict: "request_changes",
        prSummary: "Manca il test del totale.",
      },
      {
        repositoryId,
        ticketId,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha123",
        status: "completed",
        startedAt: null,
        verdict: "approve",
        prSummary: "Riga mai partita.",
        createdAt: new Date(Date.now() + 60_000),
      },
    ]);
    vi.stubGlobal("fetch", greenFetch());

    const res2 = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body2 = res2.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null; reviewSummary: string | null }[];
    };
    const internal = body2.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(internal).toBeDefined();
    expect(internal!.reviewVerdict).toBe("request_changes");
    expect(internal!.reviewSummary).toBe("Manca il test del totale.");
  });

  it("una review IN ATTESA dopo una completata: la PR interna tiene il verdetto della completata", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db.insert(prReviews).values({
      repositoryId,
      ticketId,
      prNumber: 42,
      prUrl: PR_URL,
      prTitle: "Fix the bug",
      headSha: "headsha123",
      status: "completed",
      startedAt: new Date(),
      verdict: "request_changes",
      prSummary: "Manca il test del totale.",
    });
    await seedWaitingReview({ repositoryId, prNumber: 42, prUrl: PR_URL });
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null; reviewSummary: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.reviewVerdict).toBe("request_changes");
    expect(item!.reviewSummary).toBe("Manca il test del totale.");
  });

  it("una review FALLITA dopo una completata: la PR interna tiene il verdetto della completata", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db.insert(prReviews).values([
      {
        repositoryId,
        ticketId,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha123",
        status: "completed",
        startedAt: new Date(),
        verdict: "request_changes",
        prSummary: "Manca il test del totale.",
      },
      {
        repositoryId,
        ticketId: null,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha123",
        status: "failed",
        startedAt: new Date(),
        verdict: null,
        error: "agente fallito",
        createdAt: new Date(Date.now() + 60_000),
      },
    ]);
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.reviewVerdict).toBe("request_changes");
  });

  it("due review completate sulla PR interna: il verdetto è quello della più recente", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await testDb.db.insert(prReviews).values([
      {
        repositoryId,
        ticketId,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha123",
        status: "completed",
        startedAt: new Date(),
        verdict: "request_changes",
        prSummary: "Manca il test del totale.",
      },
      {
        repositoryId,
        ticketId,
        prNumber: 42,
        prUrl: PR_URL,
        prTitle: "Fix the bug",
        headSha: "headsha124",
        status: "completed",
        startedAt: new Date(Date.now() + 60_000),
        verdict: "approve",
        prSummary: "Il test del totale ora c'è.",
        createdAt: new Date(Date.now() + 60_000),
      },
    ]);
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; reviewVerdict: string | null; reviewSummary: string | null }[];
    };
    const item = body.items.find((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(item).toBeDefined();
    expect(item!.reviewVerdict).toBe("approve");
    expect(item!.reviewSummary).toBe("Il test del totale ora c'è.");
  });

  it("nessuna review completata, solo una IN ATTESA: la PR resta in coda, senza verdetto (non sparisce)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await seedWaitingReview({ repositoryId, prNumber: 42, prUrl: PR_URL });
    vi.stubGlobal("fetch", greenFetch());

    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });

    const body = res.json() as {
      items: { ticketId: string; repositoryId: string; origin: string; reviewVerdict: string | null }[];
    };
    const matches = body.items.filter((i) => i.ticketId === ticketId && i.repositoryId === repositoryId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.origin).toBe("stubwise");
    expect(matches[0]!.reviewVerdict).toBeNull();
  });

  // --- G6: `reviewStale`, il verdetto è su codice superato? -----------------

  type StaleItem = { ticketId: string; repositoryId: string; reviewVerdict: string | null; reviewStale: boolean };

  async function queueItem(ticketId: string, repositoryId: string): Promise<StaleItem> {
    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const item = (res.json() as { items: StaleItem[] }).items.find(
      (i) => i.ticketId === ticketId && i.repositoryId === repositoryId,
    );
    expect(item).toBeDefined();
    return item!;
  }

  async function seedInternalReview(repositoryId: string, ticketId: string, headSha: string) {
    await testDb.db.insert(prReviews).values({
      repositoryId,
      ticketId,
      prNumber: 42,
      prUrl: PR_URL,
      prTitle: "Fix the bug",
      headSha,
      status: "completed",
      startedAt: new Date(),
      verdict: "approve",
      prSummary: "Riassunto.",
    });
  }

  it("G6 PR interna: head della review ABBREVIATA e in maiuscolo, stesso commit per prefisso → reviewStale false", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    // Dal vivo la head è "headsha123" (greenFetch): Bitbucket ne salva un prefisso.
    await seedInternalReview(repositoryId, ticketId, "HEADSHA12");
    vi.stubGlobal("fetch", greenFetch());

    const item = await queueItem(ticketId, repositoryId);
    expect(item.reviewVerdict).toBe("approve");
    expect(item.reviewStale).toBe(false);
  });

  it("G6 PR interna: verdetto su una head DIVERSA da quella di adesso → reviewStale true", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await seedInternalReview(repositoryId, ticketId, "oldsha9999");
    vi.stubGlobal("fetch", greenFetch());

    expect((await queueItem(ticketId, repositoryId)).reviewStale).toBe(true);
  });

  it("G6 PR interna: head della review vuota → reviewStale false (non si afferma niente)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await seedInternalReview(repositoryId, ticketId, "");
    vi.stubGlobal("fetch", greenFetch());

    expect((await queueItem(ticketId, repositoryId)).reviewStale).toBe(false);
  });

  it("G6 PR interna: head dal vivo non disponibile (check illeggibili) → reviewStale false", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    await seedInternalReview(repositoryId, ticketId, "oldsha9999");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))),
    );

    const item = await queueItem(ticketId, repositoryId);
    expect(item.reviewVerdict).toBe("approve");
    expect(item.reviewStale).toBe(false);
  });

  it("G6 PR interna senza review: nessun verdetto → reviewStale false", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());

    const item = await queueItem(ticketId, repositoryId);
    expect(item.reviewVerdict).toBeNull();
    expect(item.reviewStale).toBe(false);
  });

  it("G6 PR esterna: head della review su un altro commit → true; stesso commit per prefisso → false", async () => {
    // seedExternalPr scrive headSha "extsha123"; dal vivo è "extheadsha".
    const stale = await seedExternalPr({ prNumber: 301 });
    vi.stubGlobal("fetch", externalFetch(301));
    expect((await queueItem(stale.ticketId, stale.repositoryId)).reviewStale).toBe(true);

    const fresh = await seedExternalPr({ prNumber: 302 });
    await testDb.db
      .update(prReviews)
      .set({ headSha: "EXTHEADS" })
      .where(eq(prReviews.repositoryId, fresh.repositoryId));
    vi.stubGlobal("fetch", externalFetch(302));
    const item = await queueItem(fresh.ticketId, fresh.repositoryId);
    expect(item.reviewVerdict).toBe("approve");
    expect(item.reviewStale).toBe(false);
  });
});

/**
 * «Già su staging?» (`deployedOn`) — il CABLAGGIO, non solo `sameCommit`: la
 * head letta dal vivo dal provider contro il `commitSha` che l'agente di
 * monitoraggio riporta nell'ultimo campione del server collegato
 * all'ambiente. Campioni seminati come in `project-environments.test.ts`.
 */
describe("GET /api/release-queue — deployedOn", () => {
  const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

  /** Il provider dice che la head della PR è `head` (check verdi). */
  function fetchWithHead(head: string) {
    const checksUrl = `https://api.github.com/repos/acme/demo-shop/commits/${head}/check-runs?per_page=100`;
    return vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ state: "open", head: { sha: head } }), { status: 200 }));
      }
      if (url === checksUrl && method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
  }

  /** Un ambiente staging del progetto, col suo server e l'ultimo campione dell'agente. */
  async function seedStaging(projectId: string, commitSha: string | undefined) {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: `vps-${randomBytes(3).toString("hex")}`, keyHash: `hash-${crypto.randomUUID()}` })
      .returning();
    const name = `staging-${randomBytes(3).toString("hex")}`;
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name, kind: "staging", serverId: server!.id }).returning();
    // Area 8, F1 (R-L2): il server è per repository; come la rotta, lo si scrive per tutte quelle del progetto.
    const repos = await testDb.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.projectId, projectId));
    if (repos.length > 0) await testDb.db.insert(environmentServers).values(repos.map((r) => ({ environmentId: env!.id, repositoryId: r.id, serverId: server!.id })));
    await testDb.db.insert(serverMetrics).values({
      serverId: server!.id,
      ts: new Date(),
      cpuPct: 1,
      load1m: 0.1,
      memUsedBytes: 1000,
      memTotalBytes: 2000,
      swapUsedBytes: 0,
      diskUsedBytes: 1000,
      diskTotalBytes: 2000,
      netRxBytes: 0,
      netTxBytes: 0,
      services: [
        {
          source: "docker",
          name,
          state: "running",
          cpuPct: 1,
          memBytes: 1000,
          restarts: null,
          image: "acme/web:2.0.0",
          ...(commitSha === undefined ? {} : { commitSha }),
        },
      ],
    });
    return name;
  }

  async function deployedOnOf(ticketId: string, repositoryId: string): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const item = (res.json() as { items: { ticketId: string; repositoryId: string; deployedOn: string[] }[] }).items.find(
      (i) => i.ticketId === ticketId && i.repositoryId === repositoryId,
    );
    expect(item).toBeDefined();
    return item!.deployedOn;
  }

  it("head della PR ABBREVIATA (12 caratteri, Bitbucket) contro lo sha completo dell'agente: combacia", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    const staging = await seedStaging(projectId, FULL_SHA);
    vi.stubGlobal("fetch", fetchWithHead(FULL_SHA.slice(0, 12)));

    expect(await deployedOnOf(ticketId, repositoryId)).toEqual([staging]);
    // Area 8, F1: un ambiente STAGING lo riporta → «già su staging» in `/pulls`.
    const pullsOf = async () =>
      ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers: { cookie: adminCookie } })).json() as { items: { onStaging: boolean }[] }).items[0]!;
    expect((await pullsOf()).onStaging).toBe(true);
    await testDb.db.update(projectEnvironments).set({ kind: "production" }).where(and(eq(projectEnvironments.projectId, projectId), eq(projectEnvironments.name, staging)));
    expect((await pullsOf()).onStaging).toBe(false);
  });

  it("commit diverso: deployedOn vuoto (il caso positivo qui sopra non è un vero-per-tutto)", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    await seedStaging(projectId, "fedcba9876543210fedcba9876543210fedcba98");
    vi.stubGlobal("fetch", fetchWithHead(FULL_SHA.slice(0, 12)));

    expect(await deployedOnOf(ticketId, repositoryId)).toEqual([]);
  });

  for (const [label, sha] of [
    ["vuoto", ""],
    ["assente", undefined],
  ] as const) {
    it(`commitSha ${label} nell'ultimo campione: deployedOn è []`, async () => {
      const { ticketId, repositoryId, projectId } = await seedOpenPr();
      await seedStaging(projectId, sha);
      vi.stubGlobal("fetch", fetchWithHead(FULL_SHA.slice(0, 12)));

      expect(await deployedOnOf(ticketId, repositoryId)).toEqual([]);
    });
  }

  it("R-L2: il commit giusto sul server di UN'ALTRA repository dell'ambiente non conta", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    const staging = await seedStaging(projectId, FULL_SHA);
    const other = await seedRepositoryInProject(testDb.db, projectId);
    // Il server dell'ambiente passa all'altra repository; quella della PR resta
    // senza. Configurazione SOLO per repository: niente `server_id` di prima
    // (che varrebbe da ripiego per la repository senza riga, review F1).
    const [row] = await testDb.db.select().from(environmentServers).where(eq(environmentServers.repositoryId, repositoryId));
    await testDb.db.update(projectEnvironments).set({ serverId: null }).where(eq(projectEnvironments.id, row!.environmentId));
    await testDb.db.delete(environmentServers).where(eq(environmentServers.repositoryId, repositoryId));
    await testDb.db.insert(environmentServers).values({ environmentId: row!.environmentId, repositoryId: other, serverId: row!.serverId });
    vi.stubGlobal("fetch", fetchWithHead(FULL_SHA.slice(0, 12)));
    expect(await deployedOnOf(ticketId, repositoryId)).toEqual([]);
    // Rimesso sulla repository della PR, combacia di nuovo (il negativo qui sopra non è un falso-per-tutto).
    await testDb.db.insert(environmentServers).values({ environmentId: row!.environmentId, repositoryId, serverId: row!.serverId });
    expect(await deployedOnOf(ticketId, repositoryId)).toEqual([staging]);
  });

  it("review F1: una repository aggiunta DOPO la scrittura dell'ambiente (nessuna riga sua) usa il server dell'ambiente", async () => {
    const { ticketId, repositoryId, projectId } = await seedOpenPr();
    const staging = await seedStaging(projectId, FULL_SHA);
    // Come una repository nata dopo: la sua riga non c'è, resta il `server_id` di prima.
    await testDb.db.delete(environmentServers).where(eq(environmentServers.repositoryId, repositoryId));
    vi.stubGlobal("fetch", fetchWithHead(FULL_SHA.slice(0, 12)));
    expect(await deployedOnOf(ticketId, repositoryId)).toEqual([staging]);
  });
});

describe("area 8, F1, S5b: le PR aperte del progetto, a chi lo vede", () => {
  it("un Developer vede la PR (con head, controlli, analisi, tetto) e i suoi permessi; non c'è canMerge; chi non vede il progetto: 404", async () => {
    const { projectId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    const dev = await createUserWithPat(app, `dev-${randomUUID().slice(0, 6)}@acme.com`);
    await addMember(app, projectId, dev.id, "developer");
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers: dev.headers });
    expect(res.statusCode).toBe(200);
    const [pull] = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(pull).toMatchObject({
      origin: "stubwise",
      headSha: "headsha123",
      corrections: { count: 0, lastStatus: null },
      cap: 3,
      analysisOnly: null,
      permissions: { analysisOnly: false, requestCorrection: true, editReleaseNotes: true },
    });
    expect(pull).not.toHaveProperty("canMerge");
    // Area 8, F1, S8: il ramo `stubwise/ticket-<N>` è della PR stessa: mai «non correggibile».
    expect((pull as { prState: Record<string, unknown> }).prState).not.toHaveProperty("notFixable");
    const outsider = await createUserWithPat(app, `out-${randomUUID().slice(0, 6)}@acme.com`);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers: outsider.headers })).statusCode).toBe(404);
  });

  describe("area 8, F1, S8: lo stato della PR del collega e «Solo analisi»", () => {
    /** La riga che il worker scrive alla fine della review (S8): da lì la PR si può correggere. */
    async function link(c: { repositoryId: string; prNumber: number; prUrl: string }) {
      const [{ ticketId }] = (await testDb.db.select({ ticketId: prReviews.ticketId }).from(prReviews).where(eq(prReviews.repositoryId, c.repositoryId))) as [{ ticketId: string }];
      await testDb.db.update(tickets).set({ type: "review" }).where(eq(tickets.id, ticketId));
      await testDb.db.insert(ticketRepositories).values({ ticketId, repositoryId: c.repositoryId, branch: "feature/x", prUrl: c.prUrl, prNumber: c.prNumber, prState: "open", adoptedAt: new Date() });
    }

    async function colleaguePr(opts: { verdict?: "approve" | "request_changes"; fromFork?: boolean | null; mode?: "analyze_and_fix" | "analyze_only" | "off" } = {}) {
      const pr = await seedExternalPr({ verdict: opts.verdict ?? "request_changes" });
      await testDb.db
        .update(prReviews)
        .set({ headSha: "extheadsha", sourceBranch: "feature/x", targetBranch: "main", fromFork: opts.fromFork === undefined ? false : opts.fromFork })
        .where(eq(prReviews.repositoryId, pr.repositoryId));
      await testDb.db.update(repositories).set({ colleaguePrs: opts.mode ?? "analyze_and_fix" }).where(eq(repositories.id, pr.repositoryId));
      const [{ projectId }] = await testDb.db.select({ projectId: repositories.projectId }).from(repositories).where(eq(repositories.id, pr.repositoryId)) as [{ projectId: string }];
      vi.stubGlobal("fetch", externalFetch(pr.prNumber));
      const lead = await createUserWithPat(app, `lead-${randomUUID().slice(0, 6)}@acme.com`);
      await addMember(app, projectId, lead.id, "project_lead");
      const pulls = async (headers = lead.headers) =>
        ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers })).json() as { items: Record<string, unknown>[] }).items[0]!;
      const flag = (method: "POST" | "DELETE", headers = lead.headers) =>
        app.inject({ method, url: `/api/repositories/${pr.repositoryId}/pulls/${pr.prNumber}/analysis-only`, headers });
      return { ...pr, projectId, lead, pulls, flag };
    }

    it("chiede modifiche, ramo correggibile, «analisi e correzioni»: «issues», non pronta, Claude la può correggere", async () => {
      const c = await colleaguePr();
      expect(await c.pulls()).toMatchObject({
        prState: { state: "issues", canAutoCorrect: true },
        ready: false,
        fromFork: false,
        mergeable: null,
        colleaguePrs: "analyze_and_fix",
        issues: [{ file: null }],
        // Review del renderer: senza la riga della PR (ancora da collegare) la rotta risponderebbe 404.
        permissions: { analysisOnly: true, requestCorrection: false },
      });
      await link(c);
      expect(await c.pulls()).toMatchObject({ permissions: { requestCorrection: true } });
    });

    it("review del renderer: «Chiedi modifiche» su una PR di un collega vuole prs.adopt E corrections.request, come la rotta", async () => {
      const c = await colleaguePr();
      await link(c);
      const [role] = await testDb.db.insert(roles).values({ name: `solo-adopt-${randomUUID().slice(0, 4)}`, scope: "project", permissions: ["prs.adopt", "tickets.view"] }).returning();
      const u = await createUserWithPat(app, `ad-${randomUUID().slice(0, 6)}@acme.com`);
      await testDb.db.insert(projectMembers).values({ projectId: c.projectId, userId: u.id, roleId: role!.id });
      expect(await c.pulls(u.headers)).toMatchObject({ permissions: { requestCorrection: false } });
    });

    it("approvata sulla head, senza controlli: «clean» e pronta", async () => {
      const c = await colleaguePr({ verdict: "approve" });
      expect(await c.pulls()).toMatchObject({ prState: { state: "clean" }, ready: true, issues: [] });
    });

    it("fork non verificabile: «not_fixable» (fork), e «Chiedi modifiche» non c'è", async () => {
      const c = await colleaguePr({ fromFork: null });
      expect(await c.pulls()).toMatchObject({ prState: { state: "not_fixable", notFixable: "fork" }, fromFork: null, permissions: { requestCorrection: false } });
    });

    it("«Solo analisi»: chi ha prs.adopt lo mette (su tutte le righe, annulla le correzioni aperte) e lo toglie", async () => {
      const c = await colleaguePr();
      const [{ ticketId }] = (await testDb.db.select({ ticketId: prReviews.ticketId }).from(prReviews).where(eq(prReviews.repositoryId, c.repositoryId))) as [{ ticketId: string }];
      // Il ticket della review di una PR di un collega, con la riga che le scrive il worker (S8).
      await testDb.db.update(tickets).set({ type: "review" }).where(eq(tickets.id, ticketId));
      await testDb.db.insert(ticketRepositories).values({ ticketId, repositoryId: c.repositoryId, branch: "feature/x", prUrl: c.prUrl, prNumber: c.prNumber, prState: "open", adoptedAt: new Date() });
      const [corr] = await testDb.db.insert(prCorrections).values({ ticketId, repositoryId: c.repositoryId, prNumber: c.prNumber, trigger: "review", status: "pending" }).returning();
      const on = await c.flag("POST");
      expect(on.statusCode).toBe(200);
      expect(on.json()).toMatchObject({ analysisOnly: { byId: c.lead.id } });
      expect((await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, corr!.id)))[0]!.status).toBe("cancelled");
      // Una review nuova nasce senza: il flag resta (vale su qualunque riga della PR).
      await testDb.db.insert(prReviews).values({ repositoryId: c.repositoryId, prNumber: c.prNumber, prUrl: c.prUrl, prTitle: "t", headSha: "extheadsha", status: "running", createdAt: new Date(Date.now() + 60_000) });
      expect(await c.pulls()).toMatchObject({ analysisOnly: { byId: c.lead.id }, prState: { state: "analyzing" }, permissions: { requestCorrection: false } });
      const off = await c.flag("DELETE");
      expect(off.statusCode).toBe(200);
      expect(off.json()).toEqual({ analysisOnly: null });
      expect(await c.pulls()).toMatchObject({ analysisOnly: null, permissions: { requestCorrection: true } });
    });

    it("«Solo analisi»: un Legacy Member (senza prs.adopt) 403, chi non vede il progetto 404, una PR di Stubwise 409, una PR mai analizzata 404", async () => {
      const c = await colleaguePr();
      const dev = await createUserWithPat(app, `lm-${randomUUID().slice(0, 6)}@acme.com`);
      await addMember(app, c.projectId, dev.id, "legacy_member");
      expect((await c.flag("POST", dev.headers)).statusCode).toBe(403);
      const outsider = await createUserWithPat(app, `out-${randomUUID().slice(0, 6)}@acme.com`);
      expect((await c.flag("POST", outsider.headers)).statusCode).toBe(404);
      expect(await testDb.db.select().from(prReviews).where(and(eq(prReviews.repositoryId, c.repositoryId), eq(prReviews.analysisOnly, true)))).toEqual([]);
      await testDb.db.insert(prReviews).values({ repositoryId: c.repositoryId, prNumber: 5, prUrl: "u5", prTitle: "t", headSha: "s", sourceBranch: "stubwise/ticket-3", status: "completed" });
      expect((await app.inject({ method: "POST", url: `/api/repositories/${c.repositoryId}/pulls/5/analysis-only`, headers: c.lead.headers })).json()).toMatchObject({ code: "not_colleague_pr" });
      expect((await app.inject({ method: "POST", url: `/api/repositories/${c.repositoryId}/pulls/999/analysis-only`, headers: c.lead.headers })).statusCode).toBe(404);
    });
  });

  it("area 8, F1: la storia delle correzioni (dalla più vecchia, con l'esito del job) e owner/repo", async () => {
    const { projectId, ticketId, repositoryId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    const t0 = Date.now() - 3_600_000;
    const add = async (trigger: "review" | "stubwise", status: "done" | "queued" | "cancelled", job: { status: "pr_opened" | "failed"; error?: string } | null, offset: number) => {
      const [c] = await testDb.db.insert(prCorrections).values({ ticketId, repositoryId, prNumber: 42, trigger, status, createdAt: new Date(t0 + offset) }).returning();
      if (job) await testDb.db.insert(aiJobs).values({ ticketId, correctionId: c!.id, status: job.status, error: job.error ?? null });
      return c!.id;
    };
    const pushed = await add("review", "done", { status: "pr_opened" }, 0);
    const stopped = await add("stubwise", "done", { status: "failed", error: "push rifiutato" }, 1000);
    await add("review", "cancelled", null, 1500);
    const running = await add("review", "queued", null, 2000);
    const [pull] = ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers: { cookie: adminCookie } })).json() as { items: Record<string, unknown>[] }).items;
    expect(pull).toMatchObject({
      repositoryFullName: "acme/demo-shop",
      correctionHistory: [
        { id: pushed, trigger: "auto", state: "pushed", why: null, commitSha: null },
        { id: stopped, trigger: "person", state: "stopped", why: "push rifiutato" },
        { id: running, trigger: "auto", state: "running" },
      ],
    });
    expect((pull as { correctionHistory: unknown[] }).correctionHistory).toHaveLength(3);
  });

  it("un Viewer vede la PR ma nessun permesso", async () => {
    const { projectId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    const viewer = await createUserWithPat(app, `v-${randomUUID().slice(0, 6)}@acme.com`);
    await addMember(app, projectId, viewer.id, "viewer");
    const [pull] = ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/pulls`, headers: viewer.headers })).json() as { items: Record<string, unknown>[] }).items;
    expect(pull).toMatchObject({ permissions: { analysisOnly: false, requestCorrection: false, editReleaseNotes: false } });
  });
});

describe("area 8, F1, S9: le note di rilascio di una PR", () => {
  let n = 0;
  async function setup() {
    const pr = await seedOpenPr();
    const code = `Q${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + Math.floor(n / 26) % 26)}`;
    n++;
    await testDb.db.update(projects).set({ code }).where(eq(projects.id, pr.projectId));
    await testDb.db.update(ticketRepositories).set({ prNumber: 42 }).where(eq(ticketRepositories.id, pr.trId));
    const [own] = await testDb.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, pr.ticketId));
    const { ticketId: otherId } = await seedTicket(testDb.db, { projectId: pr.projectId, repositoryId: pr.repositoryId, number: 2 });
    const [other] = await testDb.db.update(tickets).set({ title: "Pagamenti" }).where(eq(tickets.id, otherId)).returning({ number: tickets.number });
    await testDb.db.update(tickets).set({ title: "Checkout" }).where(eq(tickets.id, pr.ticketId));
    const commits = [`${code}-${other!.number}: pagamenti`, "fix ZZZ-1 di un altro progetto", `${code}-9999 inesistente`];
    const fetchCommits = (ok = true) =>
      vi.fn((input: string | URL) =>
        Promise.resolve(
          String(input) === "https://api.github.com/repos/acme/demo-shop/pulls/42/commits?per_page=100" && ok
            ? new Response(JSON.stringify(commits.map((message) => ({ commit: { message } }))), { status: 200 })
            : new Response("", { status: 500 }),
        ),
      );
    const url = `/api/repositories/${pr.repositoryId}/pulls/42/release-notes`;
    return { ...pr, code, own: own!.number, other: other!.number, fetchCommits, url };
  }
  const user = async (projectId: string, preset: string) => {
    const u = await createUserWithPat(app, `${preset}-${randomUUID().slice(0, 6)}@acme.com`);
    await addMember(app, projectId, u.id, preset);
    return u;
  };

  it("la bozza: la task della PR e quelle citate dai commit, SOLO del progetto e solo se esistono; nessun testo salvato", async () => {
    const s = await setup();
    vi.stubGlobal("fetch", s.fetchCommits());
    const viewer = await user(s.projectId, "viewer");
    const res = await app.inject({ method: "GET", url: s.url, headers: viewer.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      body: null,
      commitsRead: true,
      canEdit: false,
      draft: { text: `- ${s.code}-${s.own}: Checkout\n- ${s.code}-${s.other}: Pagamenti`, sources: [`${s.code}-${s.own}`, `${s.code}-${s.other}`] },
    });
  });

  it("i commit illeggibili: la bozza dalla sola task della PR, e lo dice", async () => {
    const s = await setup();
    vi.stubGlobal("fetch", s.fetchCommits(false));
    const viewer = await user(s.projectId, "viewer");
    expect((await app.inject({ method: "GET", url: s.url, headers: viewer.headers })).json()).toMatchObject({ commitsRead: false, draft: { sources: [`${s.code}-${s.own}`] } });
  });

  it("scrivere: chi ha tickets.edit sì (e il testo si rilegge); un Viewer 403 e niente scritto; chi non vede il progetto 404; una PR ignota 404", async () => {
    const s = await setup();
    vi.stubGlobal("fetch", s.fetchCommits());
    const dev = await user(s.projectId, "developer");
    const put = await app.inject({ method: "PUT", url: s.url, headers: dev.headers, payload: { body: "Nuovo checkout." } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ body: "Nuovo checkout.", updatedById: dev.id, canEdit: true });
    // E l'elenco delle PR le porta già (niente GET per PR).
    const pulls = (await app.inject({ method: "GET", url: `/api/projects/${s.projectId}/pulls`, headers: dev.headers })).json() as { items: { releaseNotes: string | null }[] };
    expect(pulls.items[0]!.releaseNotes).toBe("Nuovo checkout.");
    const viewer = await user(s.projectId, "viewer");
    expect((await app.inject({ method: "PUT", url: s.url, headers: viewer.headers, payload: { body: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: s.url, headers: viewer.headers })).json()).toMatchObject({ body: "Nuovo checkout." });
    const outsider = await createUserWithPat(app, `out-${randomUUID().slice(0, 6)}@acme.com`);
    expect((await app.inject({ method: "GET", url: s.url, headers: outsider.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/repositories/${s.repositoryId}/pulls/999/release-notes`, headers: dev.headers })).json()).toMatchObject({ code: "pr_not_found" });
  });
});

describe("area 8, F1, S10: la Home «Rilasci»", () => {
  let seq = 0;
  async function failedRelease(projectId: string, repositoryId: string, opts: { fixTicketId?: string } = {}) {
    seq++;
    const [rel] = await testDb.db
      .insert(releases)
      .values({ code: `R${randomUUID().slice(0, 5).toUpperCase()}-V${seq}`, seq, projectId, repositoryId, prNumber: 100 + seq, prUrl: "u", title: "Checkout", mergeSha: String(seq).padStart(40, "c"), mergedAt: new Date(Date.now() - 60_000), viaStubwise: true, fixTicketId: opts.fixTicketId ?? null })
      .returning();
    await testDb.db.insert(releaseCiRuns).values({ releaseId: rel!.id, providerRunId: "1", name: "test", status: "failed", startedAt: new Date(), endedAt: new Date() });
    return rel!;
  }
  const meReleases = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/api/me/releases", headers })).json() as { failed: { code: string }[]; ready: { prUrl: string }[] };
  const blocksOf = async (headers: Record<string, string>) => ((await app.inject({ method: "GET", url: "/api/me/home", headers })).json() as { blocks: { kind: string }[] }).blocks.map((b) => b.kind);

  it("chi ha release.merge: il blocco nella Home, i falliti (finché la riparazione è aperta) e le PR pronte; un Developer no", async () => {
    const { projectId, repositoryId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    await testDb.db.update(repositories).set({ ciProvider: "github_actions" }).where(eq(repositories.id, repositoryId));
    const lead = await createUserWithPat(app, `lead-${randomUUID().slice(0, 6)}@acme.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    const dev = await createUserWithPat(app, `dev-${randomUUID().slice(0, 6)}@acme.com`);
    await addMember(app, projectId, dev.id, "developer");

    const open = await failedRelease(projectId, repositoryId);
    const { ticketId: closedFix } = await seedTicket(testDb.db, { projectId, repositoryId, number: 50 });
    await testDb.db.update(tickets).set({ status: "done" }).where(eq(tickets.id, closedFix));
    const repaired = await failedRelease(projectId, repositoryId, { fixTicketId: closedFix });

    expect(await blocksOf(lead.headers)).toContain("releases");
    expect(await blocksOf(dev.headers)).not.toContain("releases");
    const mine = await meReleases(lead.headers);
    expect(mine.failed.map((r) => r.code)).toEqual([open.code]);
    expect(mine.failed.map((r) => r.code)).not.toContain(repaired.code);
    // La review automatica è spenta: la PR verde di Stubwise è pronta (niente analisi da aspettare),
    // ma «non analizzata», mai «senza problemi» ((O) di 46).
    expect(mine.ready.map((p) => p.prUrl)).toEqual([PR_URL]);
    expect((mine.ready[0] as unknown as { prState: { state: string } }).prState.state).toBe("analysis_off");
    expect(mine.ready[0]).toMatchObject({ projectId, projectCode: expect.any(String) });
    expect(await meReleases(dev.headers)).toEqual({ failed: [], ready: [] });
  });

  it("con la review accesa e nessuna analisi, la PR non è ancora pronta", async () => {
    const { projectId } = await seedOpenPr();
    vi.stubGlobal("fetch", greenFetch());
    await testDb.db.update(instanceSettings).set({ prReviewEnabled: true }).where(eq(instanceSettings.id, 1));
    try {
      const lead = await createUserWithPat(app, `lead-${randomUUID().slice(0, 6)}@acme.com`);
      await addMember(app, projectId, lead.id, "project_lead");
      expect((await meReleases(lead.headers)).ready).toEqual([]);
    } finally {
      await testDb.db.update(instanceSettings).set({ prReviewEnabled: false }).where(eq(instanceSettings.id, 1));
    }
  });
});
