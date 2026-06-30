import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import {
  aiProviders,
  docGenerationJobs,
  docGenerations,
  docPages,
  repositories,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

/**
 * Inserisce un repository (con il suo progetto-gruppo) e ne restituisce id/slug/
 * name. In Fase 1 i Docs sono per-repository: l'`id` restituito è il repositoryId
 * usato dalle route `/api/repositories/:repositoryId/docs/...` e dalle colonne
 * repository-level (docPages.repositoryId, docGenerations.repositoryId, ecc.).
 */
async function insertProject(db: Db): Promise<{ id: string; slug: string; name: string }> {
  const { repositoryId } = await seedRepository(db);
  const [repository] = await db
    .select({ slug: repositories.slug, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return { id: repositoryId, slug: repository!.slug, name: repository!.name };
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
      repositoryId: projectId,
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
      repositoryId: projectId,
      generationId: gen.id,
      kind: "technical",
      slug: `tech-overview-${gen.id.slice(0, 8)}`,
      title: "Technical Overview",
      position: 0,
      sourcePath: "src/index.ts",
      body: "# Technical\n\nDettagli tecnici.",
    },
    {
      repositoryId: projectId,
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
      .update(repositories)
      .set({ currentDocGenerationId: gen.id })
      .where(eq(repositories.id, projectId));
  }
  return gen.id;
}

let providerSeq = 0;

/** Inserisce un provider AI (enabled di default), label/secret fittizia. */
async function insertProvider(
  db: Db,
  opts: { enabled?: boolean; kind?: "api_key" | "account"; label?: string } = {},
): Promise<{ id: string; label: string; kind: "api_key" | "account" }> {
  providerSeq++;
  const kind = opts.kind ?? "api_key";
  const label = opts.label ?? `Provider ${providerSeq}`;
  const [provider] = await db
    .insert(aiProviders)
    .values({
      kind,
      label,
      secretEncrypted: "enc-secret",
      position: providerSeq,
      enabled: opts.enabled ?? true,
    })
    .returning();
  if (!provider) throw new Error("insert del provider non ha restituito la riga");
  return { id: provider.id, label: provider.label, kind: provider.kind };
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

describe("POST /api/repositories/:projectId/docs/generate", () => {
  it("un member non può: 403", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("l'admin accoda un job: 202 con status queued", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { id: string; status: string; trigger: string };
    expect(body.status).toBe("queued");
    expect(body.trigger).toBe("manual");

    const rows = await testDb.db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.repositoryId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
  });

  it("ri-trigger con un job attivo: restituisce lo stesso job (200, idempotente)", async () => {
    const project = await insertProject(testDb.db);
    const first = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { id: string }).id;

    const second = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(firstId);

    // Nessun secondo job accodato.
    const rows = await testDb.db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.repositoryId, project.id));
    expect(rows).toHaveLength(1);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/generate",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("il body con providerId viene ignorato: il job non porta alcun pin", async () => {
    // Il provider non si sceglie più al trigger (la scelta vive sul progetto):
    // un eventuale body è inerte e il job si crea senza pin a livello di job.
    const project = await insertProject(testDb.db);
    const provider = await insertProvider(testDb.db, { enabled: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
      payload: { providerId: provider.id },
    });
    expect(res.statusCode).toBe(202);

    const rows = await testDb.db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.repositoryId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
  });
});

describe("GET /api/repositories/:projectId/docs/status", () => {
  it("nessuna generazione: generation e latestJob null", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/status`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ generation: null, latestJob: null, pinnedProvider: null });
  });

  it("con generazione corrente e job: li restituisce entrambi", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "deadbeef" });
    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/generate`,
      headers: { cookie: adminCookie },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/status`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generation: { id: string; status: string; commitSha: string; cost: string } | null;
      latestJob: { status: string } | null;
      pinnedProvider: unknown;
    };
    expect(body.generation!.id).toBe(genId);
    expect(body.generation!.status).toBe("succeeded");
    expect(body.generation!.commitSha).toBe("deadbeef");
    expect(body.generation!.cost).toBe("1.250000");
    expect(body.latestJob!.status).toBe("queued");
    // Nessun pin né sulla generazione né sul job → null.
    expect(body.pinnedProvider).toBeNull();
  });

  it("con generazione corrente pinnata: espone pinnedProvider {id,label,kind}", async () => {
    // Il pin ora vive sulla generazione (doc_generations.pinned_provider_id),
    // scritto dal worker dal provider del progetto: lo seediamo qui.
    const project = await insertProject(testDb.db);
    const provider = await insertProvider(testDb.db, { kind: "account", label: "Pinned Co" });
    const [gen] = await testDb.db
      .insert(docGenerations)
      .values({
        repositoryId: project.id,
        status: "succeeded",
        trigger: "manual",
        pinnedProviderId: provider.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning();
    await testDb.db
      .update(repositories)
      .set({ currentDocGenerationId: gen!.id })
      .where(eq(repositories.id, project.id));

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/status`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pinnedProvider: { id: string; label: string; kind: string } | null;
    };
    expect(body.pinnedProvider).toEqual({
      id: provider.id,
      label: "Pinned Co",
      kind: "account",
    });
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/status",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/status`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/docs/spaces", () => {
  it("elenca tutti i progetti come spazi, anche quelli senza documentazione", async () => {
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
      repositoryId: string;
      pageCount: number;
      lastCommitSha: string | null;
      lastGenerationAt: string | null;
    }[];
    // Il progetto con doc: conteggio + commit della generazione corrente.
    const docs = body.find((s) => s.repositoryId === withDocs.id)!;
    expect(docs.pageCount).toBe(2);
    expect(docs.lastCommitSha).toBe("space01");
    // Il progetto SENZA doc compare comunque (è l'entry point per generare):
    // pageCount 0, nessuna generazione.
    const none = body.find((s) => s.repositoryId === withoutDocs.id);
    expect(none).toBeDefined();
    expect(none!.pageCount).toBe(0);
    expect(none!.lastCommitSha).toBeNull();
    expect(none!.lastGenerationAt).toBeNull();
  });

  it("pageCount conta solo la generazione corrente + manuali, non quelle stale", async () => {
    const project = await insertProject(testDb.db);
    // Generazione stale (non corrente): 2 pagine che NON devono essere contate.
    await seedSucceededGeneration(testDb.db, project.id, {
      commitSha: "stalecnt",
      current: false,
    });
    // Generazione corrente: altre 2 pagine.
    await seedSucceededGeneration(testDb.db, project.id, { commitSha: "currcnt" });
    // Una pagina manuale (generationId null): va contata.
    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Manuale Conteggio", slug: "manuale-conteggio", body: "x" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/docs/spaces",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      repositoryId: string;
      pageCount: number;
      lastCommitSha: string | null;
    }[];
    const space = body.find((s) => s.repositoryId === project.id)!;
    // 2 (corrente) + 1 (manuale) = 3; le 2 stale sono escluse.
    expect(space.pageCount).toBe(3);
    // Commit/date sono quelli della generazione CORRENTE, non della stale.
    expect(space.lastCommitSha).toBe("currcnt");
  });

  it("un progetto con solo pagine manuali compare nell'hub", async () => {
    const project = await insertProject(testDb.db);
    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Solo Manuale", body: "ciao" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/docs/spaces",
      headers: { cookie: memberCookie },
    });
    const body = res.json() as { repositoryId: string; pageCount: number }[];
    const space = body.find((s) => s.repositoryId === project.id);
    expect(space).toBeDefined();
    expect(space!.pageCount).toBe(1);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/docs/spaces" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/repositories/:projectId/docs/tree", () => {
  it("ritorna le pagine della generazione corrente + manuali, raggruppate per kind", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id);
    await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Nota Manuale", slug: "nota-manuale", body: "x" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/tree`,
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
      url: `/api/repositories/${project.id}/docs/tree`,
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
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/tree",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/repositories/:projectId/docs/pages/:slug", () => {
  it("ritorna la pagina autogenerata con commitSha della generazione", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "page999" });
    const slug = `tech-overview-${genId.slice(0, 8)}`;

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title: string; body: string; commitSha: string; kind: string };
    expect(body.title).toBe("Technical Overview");
    expect(body.body).toContain("Dettagli tecnici");
    expect(body.commitSha).toBe("page999");
    expect(body.kind).toBe("technical");
  });

  it("ritorna i cross-link (links) della pagina raggruppabili per type", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "links001" });
    const slug = `linked-page-${genId.slice(0, 8)}`;
    await testDb.db.insert(docPages).values({
      repositoryId: project.id,
      generationId: genId,
      kind: "functional",
      slug,
      title: "Linked Page",
      body: "# Linked\n\nCon cross-link.",
      links: [
        { type: "implements", slug: "tech-a", title: "Tech A" },
        { type: "implemented_by", slug: "func-b", title: "Func B" },
        { type: "related", slug: "rel-c", title: "Rel C" },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      links: { type: string; slug: string; title: string }[] | null;
    };
    expect(body.links).toEqual([
      { type: "implements", slug: "tech-a", title: "Tech A" },
      { type: "implemented_by", slug: "func-b", title: "Func B" },
      { type: "related", slug: "rel-c", title: "Rel C" },
    ]);
  });

  it("pagina senza cross-link: links è null", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "nolink01" });
    // Le pagine seedate non hanno la colonna links → null.
    const slug = `tech-overview-${genId.slice(0, 8)}`;

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { links: unknown }).links).toBeNull();
  });

  it("slug inesistente: 404", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/non-esiste`,
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
      url: `/api/repositories/${project.id}/docs/pages/${staleSlug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("slug condiviso tra una pagina manuale e una della generazione corrente: ritorna deterministicamente quella autogenerata", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "shared99" });
    // Pagina autogenerata con uno slug e una manuale con LO STESSO slug: con la
    // nuova unicità per-generazione coesistono. La route deve restituire una sola
    // riga, deterministicamente quella della generazione corrente (autogenerata).
    const sharedSlug = "guida-condivisa";
    await testDb.db.insert(docPages).values({
      repositoryId: project.id,
      generationId: genId,
      kind: "technical",
      slug: sharedSlug,
      title: "Auto Condivisa",
      body: "# Auto\n\nContenuto autogenerato.",
    });
    await testDb.db.insert(docPages).values({
      repositoryId: project.id,
      generationId: null,
      kind: "manual",
      slug: sharedSlug,
      title: "Manuale Condivisa",
      isManual: true,
      body: "# Manuale\n\nContenuto manuale.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${sharedSlug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title: string; kind: string; isManual: boolean; commitSha: string };
    // Preferita la pagina della generazione corrente (generationId NOT NULL).
    expect(body.title).toBe("Auto Condivisa");
    expect(body.isManual).toBe(false);
    expect(body.commitSha).toBe("shared99");
  });
});

describe("manual pages CRUD", () => {
  it("crea una pagina manuale: 201, isManual true, kind manual, slug derivato", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
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
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it("modifica title/body: 200", async () => {
    const project = await insertProject(testDb.db);
    const created = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Da Modificare", slug: "da-modificare", body: "vecchio" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${project.id}/docs/manual/${id}`,
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
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Da Eliminare", slug: "da-eliminare", body: "x" },
    });
    const id = (created.json() as { id: string }).id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it("una pagina AUTOGENERATA non è modificabile via manual: 404", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id);
    // La generazione ha due pagine (technical + functional): si prende quella
    // technical in modo DETERMINISTICO (il SELECT senza ORDER BY non garantisce
    // l'ordine; l'asserzione finale verifica il titolo "Technical Overview").
    const [generated] = await testDb.db
      .select({ id: docPages.id })
      .from(docPages)
      .where(and(eq(docPages.generationId, genId), eq(docPages.kind, "technical")));

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${project.id}/docs/manual/${generated!.id}`,
      headers: { cookie: memberCookie },
      payload: { title: "Hack" },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/repositories/${project.id}/docs/manual/${generated!.id}`,
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

  it("parentId valido nello stesso progetto: 201", async () => {
    const project = await insertProject(testDb.db);
    const parent = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Padre", slug: "padre", body: "x" },
    });
    const parentId = (parent.json() as { id: string }).id;

    const child = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Figlio", slug: "figlio", parentId, body: "y" },
    });
    expect(child.statusCode).toBe(201);
    expect((child.json() as { parentId: string }).parentId).toBe(parentId);
  });

  it("parentId di un altro progetto: 400 invalid_parent", async () => {
    const projectA = await insertProject(testDb.db);
    const projectB = await insertProject(testDb.db);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectB.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Estraneo", slug: "estraneo", body: "x" },
    });
    const foreignId = (foreign.json() as { id: string }).id;

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${projectA.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Orfano", slug: "orfano", parentId: foreignId, body: "y" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_parent");
  });

  it("self-parent in patch: 400 invalid_parent", async () => {
    const project = await insertProject(testDb.db);
    const created = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Auto", slug: "auto", body: "x" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${project.id}/docs/manual/${id}`,
      headers: { cookie: memberCookie },
      payload: { parentId: id },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_parent");
  });

  it("position negativa: 400", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      headers: { cookie: memberCookie },
      payload: { title: "Negativa", slug: "negativa", position: -1, body: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creazione senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/manual`,
      payload: { title: "Anon", body: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});
