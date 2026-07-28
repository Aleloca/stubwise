import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { graphJobs, projects, repoGraphs, repositories } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let graphsDir: string;
let repositoryId: string;

/** Directory degli artefatti graphify del repository corrente (sul finto volume). */
function outDir(id = repositoryId): string {
  return join(graphsDir, id, "graphify-out");
}

/** Scrive i tre artefatti serviti dalle route (graph.json, report, html). */
async function writeArtifacts(): Promise<void> {
  await mkdir(outDir(), { recursive: true });
  await writeFile(join(outDir(), "graph.json"), JSON.stringify({ nodes: [], edges: [] }), "utf8");
  await writeFile(join(outDir(), "GRAPH_REPORT.md"), "# Report\n\nComunità 0\n", "utf8");
  await writeFile(join(outDir(), "graph.html"), "<!DOCTYPE html><html><body>ok</body></html>", "utf8");
}

/** Inserisce la riga repo_graphs del repository corrente con i campi dati. */
async function insertGraphRow(
  values: Partial<typeof repoGraphs.$inferInsert> = {},
): Promise<void> {
  await testDb.db.insert(repoGraphs).values({ repositoryId, ...values });
}

/** Attiva/disattiva il toggle graphEnabled del repository corrente. */
async function setGraphEnabled(value: boolean): Promise<void> {
  await testDb.db
    .update(repositories)
    .set({ graphEnabled: value })
    .where(eq(repositories.id, repositoryId));
}

beforeAll(async () => {
  testDb = await startTestDb();
  graphsDir = await mkdtemp(join(tmpdir(), "stubwise-graphs-"));
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
    graphsDir,
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
  await rm(graphsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  ({ repositoryId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await rm(join(graphsDir, repositoryId), { recursive: true, force: true });
  await testDb.db.delete(graphJobs);
  await testDb.db.delete(repoGraphs);
  await testDb.db.delete(projects);
});

describe("GET /api/repositories/:id/graph — metadati", () => {
  it("senza sessione risponde 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/repositories/${repositoryId}/graph` });
    expect(res.statusCode).toBe(401);
  });

  it("repository inesistente → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${randomUUID()}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza riga repo_graphs → status none e campi null", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      status: "none",
      commitSha: null,
      nodeCount: null,
      edgeCount: null,
      communityCount: null,
      labeled: false,
      generatedAt: null,
      setupPrUrl: null,
      error: null,
      jobPending: false,
      setupPrJobPending: false,
      setupPrError: null,
    });
  });

  it("status done con artefatti presenti → espone contatori, sha e toggle", async () => {
    await setGraphEnabled(true);
    await writeArtifacts();
    const generatedAt = new Date("2026-07-27T10:00:00.000Z");
    await insertGraphRow({
      status: "done",
      commitSha: "abc1234",
      nodeCount: 5701,
      edgeCount: 11463,
      communityCount: 263,
      labeled: true,
      setupPrUrl: "https://github.com/acme/repo/pull/7",
      generatedAt,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      status: "done",
      commitSha: "abc1234",
      nodeCount: 5701,
      edgeCount: 11463,
      communityCount: 263,
      labeled: true,
      setupPrUrl: "https://github.com/acme/repo/pull/7",
      generatedAt: generatedAt.toISOString(),
      jobPending: false,
    });
  });

  it("status done ma graph.json assente → risponde none E resetta la riga", async () => {
    await insertGraphRow({
      status: "done",
      commitSha: "abc1234",
      nodeCount: 10,
      edgeCount: 20,
      communityCount: 3,
      labeled: true,
      generatedAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "none",
      commitSha: null,
      nodeCount: null,
      edgeCount: null,
      communityCount: null,
      labeled: false,
      generatedAt: null,
    });

    const [row] = await testDb.db
      .select()
      .from(repoGraphs)
      .where(eq(repoGraphs.repositoryId, repositoryId));
    expect(row?.status).toBe("none");
    expect(row?.nodeCount).toBeNull();
    expect(row?.commitSha).toBeNull();
    expect(row?.labeled).toBe(false);
  });

  it("job build attivo → jobPending true; job setup_pr attivo → setupPrJobPending true", async () => {
    await testDb.db.insert(graphJobs).values({ repositoryId, kind: "build", status: "running" });
    await testDb.db.insert(graphJobs).values({ repositoryId, kind: "setup_pr", status: "queued" });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.json()).toMatchObject({ jobPending: true, setupPrJobPending: true });
  });

  it("espone l'errore dell'ULTIMO job setup_pr fallito senza toccare lo stato del grafo", async () => {
    await writeArtifacts();
    await insertGraphRow({ status: "done", nodeCount: 1, edgeCount: 0, communityCount: 1 });
    await testDb.db.insert(graphJobs).values({
      repositoryId,
      kind: "setup_pr",
      status: "failed",
      error: "errore vecchio",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await testDb.db.insert(graphJobs).values({
      repositoryId,
      kind: "setup_pr",
      status: "failed",
      error: "push rifiutato dal provider",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph`,
      headers: { cookie: memberCookie },
    });
    expect(res.json()).toMatchObject({
      status: "done",
      error: null,
      setupPrError: "push rifiutato dal provider",
      setupPrJobPending: false,
    });
  });
});

describe("POST /api/repositories/:id/graph/generate", () => {
  it("senza sessione 401, da member 403", async () => {
    const anon = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      payload: {},
    });
    expect(anon.statusCode).toBe(401);

    const member = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    expect(member.statusCode).toBe(403);
  });

  it("toggle graphEnabled spento → 412", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(412);
    const jobs = await testDb.db.select().from(graphJobs);
    expect(jobs).toHaveLength(0);
  });

  it("accoda un job build queued senza not_before e con force dal body", async () => {
    await setGraphEnabled(true);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: { force: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: true });

    const [job] = await testDb.db.select().from(graphJobs);
    expect(job).toMatchObject({
      repositoryId,
      kind: "build",
      status: "queued",
      force: true,
      notBefore: null,
    });
  });

  it("force omesso → job con force false", async () => {
    await setGraphEnabled(true);
    await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    const [job] = await testDb.db.select().from(graphJobs);
    expect(job?.force).toBe(false);
  });

  it("secondo generate con un job build attivo → 409 e nessun job in più", async () => {
    await setGraphEnabled(true);
    const first = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(await testDb.db.select().from(graphJobs)).toHaveLength(1);
  });

  it("repository inesistente → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${randomUUID()}/graph/generate`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repositories/:id/graph/setup-pr", () => {
  it("da member → 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/setup-pr`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("grafo non done → 412", async () => {
    await insertGraphRow({ status: "failed", error: "boom" });
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/setup-pr`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(412);
    expect(await testDb.db.select().from(graphJobs)).toHaveLength(0);
  });

  it("grafo done → accoda un job setup_pr; il secondo dà 409", async () => {
    await writeArtifacts();
    await insertGraphRow({ status: "done", nodeCount: 1, edgeCount: 1, communityCount: 1 });

    const first = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/setup-pr`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(202);
    const [job] = await testDb.db.select().from(graphJobs);
    expect(job).toMatchObject({ kind: "setup_pr", status: "queued", notBefore: null });

    const second = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/graph/setup-pr`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(await testDb.db.select().from(graphJobs)).toHaveLength(1);
  });
});

describe("contenuti dal volume", () => {
  it("GET report → markdown; assente → 404", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/report`,
      headers: { cookie: memberCookie },
    });
    expect(missing.statusCode).toBe(404);

    await writeArtifacts();
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/report`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(res.body).toContain("# Report");
  });

  it("GET html → text/html con CSP restrittiva; assente → 404", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/html`,
      headers: { cookie: memberCookie },
    });
    expect(missing.statusCode).toBe(404);

    await writeArtifacts();
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/html`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("'unsafe-inline'");
    // Il framing è consentito SOLO alla SPA: senza frame-ancestors l'iframe
    // della tab Grafo verrebbe rifiutato (caddy mette X-Frame-Options: DENY
    // globale, e nei browser moderni è questa direttiva a decidere).
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.body).toContain("<!DOCTYPE html>");
  });

  it("GET json → download application/json; assente → 404", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/json`,
      headers: { cookie: memberCookie },
    });
    expect(missing.statusCode).toBe(404);

    await writeArtifacts();
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/json`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="graph.json"');
    expect(JSON.parse(res.body)).toEqual({ nodes: [], edges: [] });
  });

  it("senza sessione i contenuti sono 401", async () => {
    await writeArtifacts();
    for (const suffix of ["report", "html", "json"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/repositories/${repositoryId}/graph/${suffix}`,
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("gli artefatti di un altro repository non sono raggiungibili da questo id", async () => {
    const { repositoryId: other } = await seedRepository(testDb.db);
    await mkdir(outDir(other), { recursive: true });
    await writeFile(join(outDir(other), "GRAPH_REPORT.md"), "# Altro", "utf8");

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${repositoryId}/graph/report`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
    await rm(join(graphsDir, other), { recursive: true, force: true });
  });
});
