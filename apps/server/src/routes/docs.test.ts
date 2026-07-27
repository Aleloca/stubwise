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

describe("POST /api/repositories/:repositoryId/docs/resume", () => {
  /** Inserisce una generazione `paused` (pausedAt/pauseReason valorizzati). */
  async function seedPausedGeneration(db: Db, projectId: string): Promise<string> {
    const [gen] = await db
      .insert(docGenerations)
      .values({
        repositoryId: projectId,
        status: "paused",
        trigger: "manual",
        startedAt: new Date(),
        pausedAt: new Date(),
        pauseReason: "provider_limit",
      })
      .returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");
    return gen.id;
  }

  it("member → 403; senza sessione → 401; repository inesistente → 404", async () => {
    const project = await insertProject(testDb.db);

    const asMember = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/resume`,
      headers: { cookie: memberCookie },
    });
    expect(asMember.statusCode).toBe(403);

    const anonymous = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/resume`,
    });
    expect(anonymous.statusCode).toBe(401);

    const missing = await app.inject({
      method: "POST",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/resume",
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("admin su generazione paused → 200 con la generazione running (pausedAt/pauseReason azzerati)", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedPausedGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/resume`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; status: string };
    expect(body.id).toBe(genId);
    expect(body.status).toBe("running");

    // Reread dal DB: running, pausa azzerata.
    const [row] = await testDb.db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.id, genId));
    expect(row!.status).toBe("running");
    expect(row!.pausedAt).toBeNull();
    expect(row!.pauseReason).toBeNull();
  });

  it("nessuna generazione paused → 409 generation_not_paused", async () => {
    const project = await insertProject(testDb.db);
    // Una generazione c'è, ma non è paused: il resume non ha nulla da riprendere.
    await seedSucceededGeneration(testDb.db, project.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/resume`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("generation_not_paused");
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

  it("con generazione paused: la espone come generation al posto della corrente", async () => {
    // La generazione in pausa non è mai la "corrente" (currentDocGenerationId
    // avanza solo alla finalize): lo status la deve esporre esplicitamente,
    // altrimenti il pannello web non potrebbe mai mostrare "in pausa"/"Riprendi ora".
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id, { commitSha: "oldgen01" });
    const [paused] = await testDb.db
      .insert(docGenerations)
      .values({
        repositoryId: project.id,
        status: "paused",
        trigger: "manual",
        startedAt: new Date(),
        pausedAt: new Date(),
        pauseReason: "provider_limit",
      })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/status`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { generation: { id: string; status: string } | null };
    expect(body.generation!.id).toBe(paused!.id);
    expect(body.generation!.status).toBe("paused");
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

describe("GET /api/repositories/:repositoryId/docs/brief", () => {
  const BRIEF = {
    identity: "A ticketing product for support teams.",
    actors: [{ name: "Agent", description: "handles tickets", internal: true }],
    surfaces: [
      { name: "Web app", type: "webapp", rootPath: "apps/web", audience: "customers", internal: false },
    ],
    glossary: [{ term: "Ticket", definition: "a unit of work" }],
    invariants: ["A ticket always has an owner"],
    confidentialFacts: [
      { fact: "18% markup", reason: "pricing", source: "billing.ts", avoid: "never state a margin" },
    ],
    journeys: [{ actor: "Agent", title: "Resolve a ticket", summary: "open, work, close" }],
    existingSources: ["README.md"],
  };

  async function seedGenerationWithBrief(
    projectId: string,
    brief: unknown,
    extra: { commitSha?: string; stats?: unknown } = {},
  ): Promise<string> {
    const [gen] = await testDb.db
      .insert(docGenerations)
      .values({
        repositoryId: projectId,
        status: "succeeded",
        trigger: "manual",
        brief,
        commitSha: extra.commitSha ?? null,
        stats: extra.stats ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning();
    return gen!.id;
  }

  it("con brief: 200 col brief INTERO incluso confidentialFacts + metadati generazione", async () => {
    const project = await insertProject(testDb.db);
    await seedGenerationWithBrief(project.id, BRIEF, { commitSha: "deadbeef1234" });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/brief`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      brief: typeof BRIEF;
      generation: { createdAt: string; commitSha: string | null };
      productExclusions: { title: string; fact: string }[];
    };
    expect(body.brief).toEqual(BRIEF);
    // La superficie interna autenticata ESPONE i fatti riservati (per l'audit).
    expect(body.brief.confidentialFacts[0]!.fact).toBe("18% markup");
    // Metadati della generazione da cui proviene il brief (coerenza A3).
    expect(typeof body.generation.createdAt).toBe("string");
    expect(body.generation.commitSha).toBe("deadbeef1234");
    // Nessuna esclusione (stats null) → lista vuota, mai 500.
    expect(body.productExclusions).toEqual([]);
  });

  it("preferisce la generazione CORRENTE (currentDocGenerationId) alla più recente con brief", async () => {
    const project = await insertProject(testDb.db);
    // Una generazione CORRENTE (più vecchia) e una più recente NON corrente: la route deve
    // restituire la CORRENTE (coerenza con le pagine effettivamente proiettate).
    const currentId = await seedGenerationWithBrief(
      project.id,
      { ...BRIEF, identity: "CURRENT generation brief" },
      { commitSha: "aaaaaaaa1111" },
    );
    await new Promise((r) => setTimeout(r, 5));
    await seedGenerationWithBrief(
      project.id,
      { ...BRIEF, identity: "NEWER non-current brief" },
      { commitSha: "bbbbbbbb2222" },
    );
    await testDb.db
      .update(repositories)
      .set({ currentDocGenerationId: currentId })
      .where(eq(repositories.id, project.id));

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/brief`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      brief: { identity: string };
      generation: { commitSha: string | null };
    };
    expect(body.brief.identity).toBe("CURRENT generation brief");
    expect(body.generation.commitSha).toBe("aaaaaaaa1111");
  });

  it("espone productExclusions da stats.productExclusions della stessa generazione", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedGenerationWithBrief(project.id, BRIEF, {
      stats: {
        pages: 3,
        productExclusions: [{ title: "Pricing guide", fact: "leaked the 18% markup" }],
      },
    });
    await testDb.db
      .update(repositories)
      .set({ currentDocGenerationId: genId })
      .where(eq(repositories.id, project.id));

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/brief`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { productExclusions: { title: string; fact: string }[] };
    expect(body.productExclusions).toEqual([
      { title: "Pricing guide", fact: "leaked the 18% markup" },
    ]);
  });

  it("brief assente (nessuna generazione con brief): 404", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id); // generazione senza brief
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/brief`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("repository inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/brief",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/brief`,
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

  it("espone createdAt, viewCount e significant su ogni nodo", async () => {
    const project = await insertProject(testDb.db);
    await seedSucceededGeneration(testDb.db, project.id);
    // Una release (pagina persistente, generationId null) marcata come minore.
    await testDb.db.insert(docPages).values({
      repositoryId: project.id,
      generationId: null,
      kind: "releases",
      slug: "release-20260724-1200-abc1234",
      title: "Release di prova",
      body: "note",
      significant: false,
      viewCount: 7,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/tree`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      slug: string;
      kind: string;
      createdAt: string;
      viewCount: number;
      significant: boolean | null;
    }[];
    for (const node of body) {
      expect(typeof node.createdAt).toBe("string");
      expect(new Date(node.createdAt).getTime()).not.toBeNaN();
      expect(typeof node.viewCount).toBe("number");
    }
    const release = body.find((n) => n.kind === "releases")!;
    expect(release.significant).toBe(false);
    expect(release.viewCount).toBe(7);
    // Le pagine non-release non hanno significatività.
    expect(body.find((n) => n.kind === "technical")!.significant).toBeNull();
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

  it("espone createdAt, viewCount e significant sulla pagina", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "meta0001" });
    const slug = `tech-overview-${genId.slice(0, 8)}`;

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      createdAt: string;
      viewCount: number;
      significant: boolean | null;
    };
    expect(new Date(body.createdAt).getTime()).not.toBeNaN();
    expect(body.viewCount).toBe(0);
    expect(body.significant).toBeNull();
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

describe("GET /api/repositories/:repositoryId/docs/highlights", () => {
  it("conta per kind, ordina topViewed/recentlyUpdated ed espone le release", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "high001" });
    // Una pagina molto vista e una manuale poco vista.
    await testDb.db.insert(docPages).values([
      {
        repositoryId: project.id,
        generationId: genId,
        kind: "product",
        slug: "getting-started",
        title: "Getting Started",
        body: "# Start",
        viewCount: 42,
      },
      {
        repositoryId: project.id,
        generationId: null,
        kind: "manual",
        slug: "nota",
        title: "Nota",
        isManual: true,
        body: "x",
        viewCount: 3,
      },
      {
        repositoryId: project.id,
        generationId: null,
        kind: "releases",
        slug: "release-20260724-1200-abc1234",
        title: "Release recente",
        body: "note",
        position: -100,
        significant: true,
        // Le release sono le più viste in assoluto: NON devono entrare in topViewed.
        viewCount: 999,
      },
      {
        repositoryId: project.id,
        generationId: null,
        kind: "releases",
        slug: "release-20260720-0900-def5678",
        title: "Release vecchia",
        body: "note",
        position: -50,
        significant: false,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/highlights`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      countsByKind: Record<string, number>;
      topViewed: { slug: string; kind: string; viewCount: number }[];
      recentlyUpdated: { slug: string }[];
      latestReleases: { slug: string; title: string; createdAt: string; significant: boolean | null }[];
    };

    expect(body.countsByKind.technical).toBe(1);
    expect(body.countsByKind.functional).toBe(1);
    expect(body.countsByKind.product).toBe(1);
    expect(body.countsByKind.manual).toBe(1);
    expect(body.countsByKind.releases).toBe(2);

    // topViewed: per viewCount desc, senza release.
    expect(body.topViewed.map((p) => p.slug)[0]).toBe("getting-started");
    expect(body.topViewed.some((p) => p.kind === "releases")).toBe(false);
    expect(body.topViewed[0]!.viewCount).toBe(42);

    // recentlyUpdated: non-release, non vuoto.
    expect(body.recentlyUpdated.length).toBeGreaterThan(0);
    expect(body.recentlyUpdated.some((p) => p.slug.startsWith("release-"))).toBe(false);

    // latestReleases: position asc → la più recente per prima, con metadati.
    expect(body.latestReleases.map((r) => r.slug)).toEqual([
      "release-20260724-1200-abc1234",
      "release-20260720-0900-def5678",
    ]);
    expect(body.latestReleases[0]!.significant).toBe(true);
    expect(new Date(body.latestReleases[0]!.createdAt).getTime()).not.toBeNaN();
  });

  it("repository senza documentazione: conteggi a zero e liste vuote", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/highlights`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      countsByKind: Record<string, number>;
      topViewed: unknown[];
      latestReleases: unknown[];
    };
    expect(body.countsByKind.technical).toBe(0);
    expect(body.topViewed).toEqual([]);
    expect(body.latestReleases).toEqual([]);
  });

  it("repository inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/highlights",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repositories/:repositoryId/docs/pages/:slug/view", () => {
  it("incrementa il contatore viste: 204 e viewCount +1", async () => {
    const project = await insertProject(testDb.db);
    const genId = await seedSucceededGeneration(testDb.db, project.id, { commitSha: "views001" });
    const slug = `tech-overview-${genId.slice(0, 8)}`;

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/repositories/${project.id}/docs/pages/${slug}/view`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(204);
    }

    const page = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/pages/${slug}`,
      headers: { cookie: memberCookie },
    });
    expect((page.json() as { viewCount: number }).viewCount).toBe(2);
  });

  it("slug inesistente: 404", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/pages/non-esiste/view`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "POST",
      url: `/api/repositories/${project.id}/docs/pages/qualsiasi/view`,
    });
    expect(res.statusCode).toBe(401);
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
