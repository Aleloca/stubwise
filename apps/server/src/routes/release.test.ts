import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  encrypt,
  gitAccounts,
  prReviews,
  projectEnvironments,
  repositories,
  serverMetrics,
  servers,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicket, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

/**
 * Rotta di rilascio (fase 8, Task 9): il CANCELLO che rende vero il secondo
 * divieto della fase 7. requireAdmin verificato SIA come status SIA come
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
  ({ adminCookie, memberCookie } = await seedUsers(app));
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
  overrides: { prUrl?: string; prNumber?: number; verdict?: "approve" | "request_changes" | null } = {},
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
  it("un member riceve 403, e nessun merge parte (fetch mai chiamata)", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, memberCookie);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await testDb.db
      .select({ prState: ticketRepositories.prState })
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(row?.prState).toBe("open");
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

  it("l'admin rilascia: check verdi → 200 { merged: true, sha }", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = greenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await release(ticketId, repositoryId, adminCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merged: true, sha: "deadbeef" });
    // I check sono stati DAVVERO letti verdi (non degradati a no_checks):
    // altrimenti questo test passerebbe anche con un check-runs rotto.
    expect(fetchMock.mock.calls.some((c) => c[0] === CHECK_RUNS_URL)).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0] === MERGE_URL)).toBe(true);
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
    expect(res.json()).toEqual({ merged: true, sha: "extdeadbeef" });
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
  it("un member riceve 403: 'una pagina sola, per il maintainer'", async () => {
    const res = await app.inject({ method: "GET", url: "/api/release-queue", headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(403);
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
    await testDb.db.insert(projectEnvironments).values({ projectId, name, kind: "staging", serverId: server!.id });
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
});
