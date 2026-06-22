import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import { docChunks, docGenerations, docPages, projects } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedGitAccount, startTestDb } from "@stubwise/db/testing";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

// Lo STESSO fake client usato dall'app è usato anche dal test per pre-embeddare
// il contenuto dei chunk: query e lookup vivono così nello stesso spazio. Per
// un testo identice il vettore è identico → distanza coseno 0 → quel chunk
// (e la sua pagina) rankano primi: ecco come rendiamo "semanticamente vicino"
// deterministico col fake basato su hash.
const embeddingClient = createFakeEmbeddingClient();

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

let projectSeq = 0;

async function insertProject(db: Db): Promise<{ id: string; slug: string }> {
  projectSeq++;
  const slug = `docs-search-proj-${projectSeq}`;
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: `Docs Search Project ${projectSeq}`,
      slug,
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      ingestionKey: `ingestion-${slug}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return { id: project.id, slug: project.slug };
}

/** Crea una generazione succeeded (corrente o stale a scelta). */
async function insertGeneration(
  db: Db,
  projectId: string,
  opts: { current?: boolean } = {},
): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({
      projectId,
      status: "succeeded",
      commitSha: randomBytes(4).toString("hex"),
      trigger: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  if (opts.current !== false) {
    await db
      .update(projects)
      .set({ currentDocGenerationId: gen.id })
      .where(eq(projects.id, projectId));
  }
  return gen.id;
}

let pageSeq = 0;

/**
 * Inserisce una pagina con un chunk il cui embedding è quello del contenuto del
 * chunk, calcolato con lo STESSO fake client dell'app. `generationId` null =
 * pagina manuale.
 */
async function insertPageWithChunk(
  db: Db,
  projectId: string,
  generationId: string | null,
  page: { title: string; body: string; chunkContent: string; kind?: "technical" | "functional" | "manual" },
): Promise<string> {
  pageSeq++;
  const kind = page.kind ?? (generationId === null ? "manual" : "technical");
  const [row] = await db
    .insert(docPages)
    .values({
      projectId,
      generationId,
      kind,
      slug: `page-${pageSeq}`,
      title: page.title,
      body: page.body,
      isManual: generationId === null,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");

  const [vector] = await embeddingClient.embed([page.chunkContent]);
  await db.insert(docChunks).values({
    pageId: row.id,
    projectId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return row.slug;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient,
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

interface SearchHit {
  slug: string;
  title: string;
  kind: string;
  snippet: string;
  score: number;
  source: string;
}

describe("GET /api/projects/:projectId/docs/search", () => {
  it("una query semanticamente vicina a un chunk restituisce quella pagina per prima", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);

    // Chunk il cui contenuto è ESATTAMENTE la query: vettore identico → distanza
    // coseno 0 → score 1 → primo in classifica.
    const target = "L'autenticazione usa cookie di sessione firmati e argon2.";
    const targetSlug = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Auth",
      body: "Pagina auth.",
      chunkContent: target,
    });
    // Rumore: chunk con contenuto diverso → vettore diverso → distanza > 0.
    await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Deploy",
      body: "Come si fa il deploy con docker compose.",
      chunkContent: "Il deploy avviene tramite docker compose e un reverse proxy.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=${encodeURIComponent(target)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchHit[];
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]!.slug).toBe(targetSlug);
    // Match esatto del chunk = score semantico massimo.
    expect(body[0]!.score).toBeGreaterThan(0.99);
    expect(["semantic", "hybrid"]).toContain(body[0]!.source);
  });

  it("il full-text cattura un token esatto che il semantico potrebbe mancare", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);

    // Token distintivo SOLO nel titolo: il chunk (e quindi il semantico) parla
    // d'altro, ma il full-text su title+body lo trova.
    const slug = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Zxqwfoobar Configuration Reference",
      body: "Riferimento alla configurazione del modulo Zxqwfoobar.",
      chunkContent: "Generiche note tecniche senza il token distintivo.",
    });
    // Altre pagine di rumore (semantica lontana, niente token).
    await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Other",
      body: "Contenuto generico non correlato.",
      chunkContent: "Contenuto generico non correlato qualunque.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=Zxqwfoobar`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchHit[];
    const hit = body.find((h) => h.slug === slug);
    expect(hit).toBeDefined();
    // Trovata via full-text (o hybrid se anche il semantico l'ha pescata).
    expect(["fulltext", "hybrid"]).toContain(hit!.source);
  });

  it("è scopata a generazione corrente + manuali: i chunk stale non compaiono", async () => {
    const project = await insertProject(testDb.db);
    // Generazione STALE (non corrente) con un chunk che matcha esattamente.
    const staleGenId = await insertGeneration(testDb.db, project.id, { current: false });
    const staleQuery = "Contenuto stale che non deve mai uscire dalla ricerca.";
    const staleSlug = await insertPageWithChunk(testDb.db, project.id, staleGenId, {
      title: "Stale Page",
      body: staleQuery,
      chunkContent: staleQuery,
    });
    // Generazione CORRENTE con almeno una pagina (così c'è uno scope valido).
    const currentGenId = await insertGeneration(testDb.db, project.id);
    await insertPageWithChunk(testDb.db, project.id, currentGenId, {
      title: "Current Page",
      body: "Contenuto della generazione corrente.",
      chunkContent: "Contenuto della generazione corrente qualsiasi.",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=${encodeURIComponent(staleQuery)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchHit[];
    // Pur essendo un match perfetto, la pagina stale NON deve comparire.
    expect(body.some((h) => h.slug === staleSlug)).toBe(false);
  });

  it("include le pagine manuali (generationId null)", async () => {
    const project = await insertProject(testDb.db);
    await insertGeneration(testDb.db, project.id);
    const manualQuery = "Procedura manuale di onboarding del nuovo sviluppatore.";
    const manualSlug = await insertPageWithChunk(testDb.db, project.id, null, {
      title: "Onboarding",
      body: manualQuery,
      chunkContent: manualQuery,
      kind: "manual",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=${encodeURIComponent(manualQuery)}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchHit[];
    expect(body[0]!.slug).toBe(manualSlug);
  });

  it("q di soli spazi: 400", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=${encodeURIComponent("   ")}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("q assente: 400 (validazione Zod)", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000000/docs/search?q=ciao",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/docs/search?q=ciao`,
    });
    expect(res.statusCode).toBe(401);
  });
});
