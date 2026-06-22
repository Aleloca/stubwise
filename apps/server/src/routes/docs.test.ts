import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  docGenerationJobs,
  docGenerations,
  docPages,
  projects,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedGitAccount, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

let projectSeq = 0;

/** Inserisce un progetto minimo valido, slug/ingestionKey univoci per chiamata. */
async function insertProject(db: Db): Promise<{ id: string; slug: string; name: string }> {
  projectSeq++;
  const slug = `docs-proj-${projectSeq}`;
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: `Docs Project ${projectSeq}`,
      slug,
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      ingestionKey: `ingestion-${slug}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return { id: project.id, slug: project.slug, name: project.name };
}

/**
 * Crea una generazione `succeeded` per il progetto, ne piazza alcune pagine
 * (technical/functional) e la imposta come corrente. Restituisce l'id della
 * generazione.
 */
async function seedSucceededGeneration(
  db: Db,
  projectId: string,
  opts: { commitSha?: string; current?: boolean } = {},
): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      projectId,
      status: "succeeded",
      commitSha: opts.commitSha ?? "abc1234",
      trigger: "manual",
      model: "gpt-test",
      cost: "1.250000",
      stats: { pages: 2 },
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");

  await db.insert(docPages).values([
    {
      projectId,
      generationId: gen.id,
      kind: "technical",
      slug: `tech-overview-${gen.id.slice(0, 8)}`,
      title: "Technical Overview",
      position: 0,
      sourcePath: "src/index.ts",
      body: "# Technical\n\nDettagli tecnici.",
    },
    {
      projectId,
      generationId: gen.id,
      kind: "functional",
      slug: `func-overview-${gen.id.slice(0, 8)}`,
      title: "Functional Overview",
      position: 0,
      body: "# Functional\n\nDettagli funzionali.",
    },
  ]);

  if (opts.current !== false) {
    await db
      .update(projects)
      .set({ currentDocGenerationId: gen.id })
      .where(eq(projects.id, projectId));
  }
  return gen.id;
}

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

describe("POST /api/projects/:projectId/docs/generate", () => {
  it("un member non può: 403", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("l'admin accoda un job: 202 con status queued", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { id: string; status: string; trigger: string };
    expect(body.status).toBe("queued");
    expect(body.trigger).toBe("manual");

    const rows = await testDb.db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
  });

  it("ri-trigger con un job attivo: restituisce lo stesso job (200, idempotente)", async () => {
    const project = await insertProject(testDb.db);
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { id: string }).id;

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(firstId);

    // Nessun secondo job accodato.
    const rows = await testDb.db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.projectId, project.id));
    expect(rows).toHaveLength(1);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/docs/generate",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:projectId/docs/status", () => {
  it("nessuna generazione: generation e latestJob null", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/status`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ generation: null, latestJob: null });
  });

  it("con generazione corrente e job: li restituisce entrambi", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "deadbeef" });
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/status`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generation: { id: string; status: string; commitSha: string; cost: string } | null;
      latestJob: { status: string } | null;
    };
    expect(body.generation!.id).toBe(genId);
    expect(body.generation!.status).toBe("succeeded");
    expect(body.generation!.commitSha).toBe("deadbeef");
    expect(body.generation!.cost).toBe("1.250000");
    expect(body.latestJob!.status).toBe("queued");
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/docs/status",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/status`,
    });
    expect(res.statusCode).toBe(401);
  });
});
