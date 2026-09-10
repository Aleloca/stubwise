import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { encrypt, gitAccounts, prReviews, repositories, ticketRepositories, tickets } from "@stubwise/db";
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

  return { ticketId, repositoryId, trId: tr!.id };
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
    verdict: overrides.verdict === undefined ? "approve" : overrides.verdict,
    prSummary: "Cambia solo un typo.",
  });

  return { ticketId, repositoryId, prNumber, prUrl };
}

function release(ticketId: string, repositoryId: string, cookie: string) {
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/repositories/${repositoryId}/release`,
    headers: { cookie },
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
});
