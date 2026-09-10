import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { encrypt, gitAccounts, repositories, ticketRepositories } from "@stubwise/db";
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
        new Response(JSON.stringify({ head: { sha: "headsha123" } }), { status: 200 }),
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

  it("il provider rifiuta il merge (405 → not_mergeable): 409, esito NON scritto localmente", async () => {
    const { ticketId, repositoryId } = await seedOpenPr();
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PR_DETAIL_URL && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ head: { sha: "headsha123" } }), { status: 200 }));
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
});
