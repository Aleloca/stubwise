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

describe("GET /api/docs/spaces", () => {
  it("elenca solo i progetti con documentazione (con conteggio pagine)", async () => {
    const withDocs = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, withDocs.id, { commitSha: "space01" });
    const withoutDocs = await insertProject(testDb.db);

    const res = await app.inject({
      method: "GET",
      url: "/api/docs/spaces",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projectId: string;
      pageCount: number;
      lastCommitSha: string | null;
    }[];
    const ids = body.map((s) => s.projectId);
    expect(ids).toContain(withDocs.id);
    expect(ids).not.toContain(withoutDocs.id);
    const space = body.find((s) => s.projectId === withDocs.id)!;
    expect(space.pageCount).toBe(2);
    expect(space.lastCommitSha).toBe("space01");
  });

  it("un progetto con solo pagine manuali compare nell'hub", async () => {
    const project = await insertProject(testDb.db);
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Solo Manuale", body: "ciao" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/docs/spaces",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { projectId: string; pageCount: number }[];
    const space = body.find((s) => s.projectId === project.id);
    expect(space).toBeDefined();
    expect(space!.pageCount).toBe(1);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/docs/spaces" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/projects/:projectId/docs/tree", () => {
  it("ritorna le pagine della generazione corrente + manuali, raggruppate per kind", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id);
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Nota Manuale", slug: "nota-manuale", body: "x" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/tree`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; isManual: boolean; slug: string }[];
    const kinds = body.map((n) => n.kind);
    expect(kinds).toContain("technical");
    expect(kinds).toContain("functional");
    expect(kinds).toContain("manual");
    // Raggruppate per kind: ogni kind compare in un blocco contiguo (l'ordine
    // segue l'enum doc_page_kind, non l'alfabeto).
    const blocks = kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]);
    expect(new Set(blocks).size).toBe(blocks.length);
    expect(body.find((n) => n.slug === "nota-manuale")!.isManual).toBe(true);
  });

  it("esclude le pagine di generazioni NON correnti, include sempre le manuali", async () => {
    const project = await insertProject(testDb.db);
    // Vecchia generazione (non corrente).
    const oldGenId = await seedSucceededGeneration(testDb.db, project.id, {
      commitSha: "old111",
      current: false,
    });
    // Nuova generazione corrente.
    await seedSucceededGeneration(testDb.db, project.id, { commitSha: "new222" });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/tree`,
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { id: string }[];
    // Nessuna pagina della generazione vecchia.
    const oldPages = await testDb.db
      .select({ id: docPages.id })
      .from(docPages)
      .where(eq(docPages.generationId, oldGenId));
    const oldIds = new Set(oldPages.map((p) => p.id));
    expect(body.some((n) => oldIds.has(n.id))).toBe(false);
    // Le due pagine della generazione corrente sono presenti.
    expect(body).toHaveLength(2);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/docs/tree",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:projectId/docs/pages/:slug", () => {
  it("ritorna la pagina autogenerata con commitSha della generazione", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "page999" });
    const slug = `tech-overview-${genId.slice(0, 8)}`;

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title: string; body: string; commitSha: string; kind: string };
    expect(body.title).toBe("Technical Overview");
    expect(body.body).toContain("Dettagli tecnici");
    expect(body.commitSha).toBe("page999");
    expect(body.kind).toBe("technical");
  });

  it("slug inesistente: 404", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/pages/non-esiste`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("pagina di una generazione non corrente: 404", async () => {
    const project = await insertProject(testDb.db);
    const oldGenId = await seedSucceededGeneration(testDb.db, project.id, {
      commitSha: "stale01",
      current: false,
    });
    await seedSucceededGeneration(testDb.db, project.id, { commitSha: "fresh02" });
    const staleSlug = `tech-overview-${oldGenId.slice(0, 8)}`;

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/pages/${staleSlug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("manual pages CRUD", () => {
  it("crea una pagina manuale: 201, isManual true, kind manual, slug derivato", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Guida Operativa", body: "# Guida" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      slug: string;
      kind: string;
      isManual: boolean;
      commitSha: string | null;
    };
    expect(body.kind).toBe("manual");
    expect(body.isManual).toBe(true);
    expect(body.slug).toBe("guida-operativa");
    expect(body.commitSha).toBeNull();
  });

  it("slug duplicato nello stesso progetto: 409", async () => {
    const project = await insertProject(testDb.db);
    const payload = { title: "Conflitto", slug: "conflitto", body: "a" };
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it("modifica title/body: 200", async () => {
    const project = await insertProject(testDb.db);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Da Modificare", slug: "da-modificare", body: "vecchio" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
      payload: { title: "Modificata", body: "nuovo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title: string; body: string };
    expect(body.title).toBe("Modificata");
    expect(body.body).toBe("nuovo");
  });

  it("elimina una pagina manuale: 204, poi 404", async () => {
    const project = await insertProject(testDb.db);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Da Eliminare", slug: "da-eliminare", body: "x" },
    });
    const id = (created.json() as { id: string }).id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("una pagina AUTOGENERATA non è modificabile via manual: 404", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id);
    const [generated] = await testDb.db
      .select({ id: docPages.id })
      .from(docPages)
      .where(eq(docPages.generationId, genId));

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/docs/manual/${generated!.id}`,
      headers: { cookie: memberCookie },
      payload: { title: "Hack" },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/docs/manual/${generated!.id}`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(404);

    // La pagina autogenerata è ancora lì, intatta.
    const [still] = await testDb.db
      .select()
      .from(docPages)
      .where(eq(docPages.id, generated!.id));
    expect(still).toBeDefined();
    expect(still!.title).toBe("Technical Overview");
  });

  it("creazione senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docs/manual`,
      payload: { title: "Anon", body: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});
