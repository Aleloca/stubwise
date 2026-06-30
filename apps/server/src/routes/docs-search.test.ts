import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import type { EmbeddingClient } from "@stubwise/embeddings";
import { buildApp } from "../app.js";
import { retrieveChunks } from "./docs-retrieval.js";
import { docChunks, docGenerations, docPages, repositories } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
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

async function insertProject(db: Db): Promise<{ id: string; slug: string }> {
  const { repositoryId } = await seedRepository(db);
  const [repository] = await db
    .select({ slug: repositories.slug })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return { id: repositoryId, slug: repository!.slug };
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
      repositoryId: projectId,
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
      .update(repositories)
      .set({ currentDocGenerationId: gen.id })
      .where(eq(repositories.id, projectId));
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
      repositoryId: projectId,
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
    repositoryId: projectId,
    generationId,
    content: page.chunkContent,
    embedding: vector,
  });
  return row.slug;
}

/**
 * Inserisce una pagina con PIÙ chunk; gli embedding sono calcolati col client
 * passato (per i test sul dedup serve determinismo controllato). Restituisce lo
 * slug della pagina.
 */
async function insertPageWithChunks(
  db: Db,
  client: EmbeddingClient,
  projectId: string,
  generationId: string | null,
  page: { title: string; body: string; chunkContents: string[] },
): Promise<string> {
  pageSeq++;
  const [row] = await db
    .insert(docPages)
    .values({
      repositoryId: projectId,
      generationId,
      kind: generationId === null ? "manual" : "technical",
      slug: `page-${pageSeq}`,
      title: page.title,
      body: page.body,
      isManual: generationId === null,
    })
    .returning();
  if (!row) throw new Error("insert della pagina non ha restituito la riga");

  const vectors = await client.embed(page.chunkContents);
  await db.insert(docChunks).values(
    page.chunkContents.map((content, i) => ({
      pageId: row.id,
      repositoryId: projectId,
      generationId,
      content,
      embedding: vectors[i],
    })),
  );
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

describe("GET /api/repositories/:projectId/docs/search", () => {
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
      url: `/api/repositories/${project.id}/docs/search?q=${encodeURIComponent(target)}`,
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
      url: `/api/repositories/${project.id}/docs/search?q=Zxqwfoobar`,
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
      url: `/api/repositories/${project.id}/docs/search?q=${encodeURIComponent(staleQuery)}`,
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
      url: `/api/repositories/${project.id}/docs/search?q=${encodeURIComponent(manualQuery)}`,
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
      url: `/api/repositories/${project.id}/docs/search?q=${encodeURIComponent("   ")}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("q assente: 400 (validazione Zod)", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/search`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/repositories/00000000-0000-0000-0000-000000000000/docs/search?q=ciao",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const project = await insertProject(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/repositories/${project.id}/docs/search?q=ciao`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("embedding KO: fallback full-text, niente 500 (token esatto trovato)", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);

    // Token distintivo nel titolo/body → lo trova SOLO il full-text. Il chunk
    // c'è ma il suo embedding è irrilevante: il client di embedding fallirà.
    const slug = await insertPageWithChunk(testDb.db, project.id, genId, {
      title: "Qzxvplumber Service Manual",
      body: "Manuale del servizio Qzxvplumber con dettagli operativi.",
      chunkContent: "Contenuto del chunk senza il token distintivo.",
    });

    // Client che RIFIUTA embed: simula Ollama down/timeout/non-200.
    const failingClient: EmbeddingClient = {
      async embed() {
        throw new Error("embedding service unavailable (boom)");
      },
    };

    // Via funzione diretta: deve restituire i match full-text, non lanciare.
    const results = await retrieveChunks(
      testDb.db,
      failingClient,
      project.id,
      "Qzxvplumber",
    );
    const hit = results.find((r) => r.slug === slug);
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("fulltext");
    // Fascia full-text-only: sempre sotto 0.5.
    expect(hit!.score).toBeLessThan(0.5);

    // Via endpoint: con un'app costruita sul client che fallisce, niente 500.
    const failApp = buildApp({
      db: testDb.db,
      sessionSecret: SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      publicUrl: "https://stubwise.example.com",
      embeddingClient: failingClient,
    });
    try {
      // Niente re-seed: il cookie member è firmato con lo STESSO SESSION_SECRET,
      // quindi è valido anche su questa app (stesso DB, stesso secret).
      const res = await failApp.inject({
        method: "GET",
        url: `/api/repositories/${project.id}/docs/search?q=Qzxvplumber`,
        headers: { cookie: memberCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SearchHit[];
      expect(body.some((h) => h.slug === slug)).toBe(true);
    } finally {
      await failApp.close();
    }
  });

  it("over-fetch dedup: una pagina multi-chunk non scaccia le pagine a singolo chunk", async () => {
    const project = await insertProject(testDb.db);
    const genId = await insertGeneration(testDb.db, project.id);

    // Embedding client deterministico a vettori 1024-dim controllati: i valori
    // non-nulli vivono solo nelle prime 2 componenti (il resto è 0), così la
    // distanza coseno è pilotabile dall'angolo nel piano e0-e1. La query "q"
    // coincide col vettore dei chunk multi-chunk (distanza 0); le pagine a
    // singolo chunk sono leggermente più lontane ma comunque rilevanti.
    const DIM = 1024;
    function planeVec(angle: number): number[] {
      const v = new Array<number>(DIM).fill(0);
      v[0] = Math.cos(angle);
      v[1] = Math.sin(angle);
      return v;
    }
    const vectors: Record<string, number[]> = {
      q: planeVec(0),
      // Pagina multi-chunk: 4 chunk tutti a distanza 0 dalla query.
      "multi-0": planeVec(0),
      "multi-1": planeVec(0),
      "multi-2": planeVec(0),
      "multi-3": planeVec(0),
    };
    // 4 pagine a singolo chunk: angolo crescente → distanza coseno crescente,
    // piccola (resta nel cono dei top, ma fuori dai chunk multi-chunk).
    const singleContents = ["single-0", "single-1", "single-2", "single-3"];
    singleContents.forEach((c, i) => {
      vectors[c] = planeVec(0.1 * (i + 1));
    });
    const controlledClient: EmbeddingClient = {
      async embed(inputs: string[]) {
        return inputs.map((s) => {
          const v = vectors[s];
          if (!v) throw new Error(`vettore non definito per: ${s}`);
          return v;
        });
      },
    };

    // Pagina con 4 chunk: senza over-fetch, con LIMIT 4 chunk riempirebbe la
    // finestra e scaccerebbe le pagine a singolo chunk.
    const multiSlug = await insertPageWithChunks(testDb.db, controlledClient, project.id, genId, {
      title: "Multi Chunk Page",
      body: "Pagina con più chunk in cima.",
      chunkContents: ["multi-0", "multi-1", "multi-2", "multi-3"],
    });
    const singleSlugs: string[] = [];
    for (const c of singleContents) {
      singleSlugs.push(
        await insertPageWithChunks(testDb.db, controlledClient, project.id, genId, {
          title: `Single ${c}`,
          body: `Pagina a singolo chunk ${c}.`,
          chunkContents: [c],
        }),
      );
    }

    // k = 4: ci aspettiamo la pagina multi-chunk + 3 pagine a singolo chunk
    // (4 pagine DISTINTE), non 1 pagina + chunk duplicati.
    const results = await retrieveChunks(testDb.db, controlledClient, project.id, "q", { k: 4 });
    const slugs = results.map((r) => r.slug);
    // 4 pagine distinte.
    expect(new Set(slugs).size).toBe(4);
    // La multi-chunk c'è una sola volta.
    expect(slugs.filter((s) => s === multiSlug).length).toBe(1);
    // Almeno 3 pagine a singolo chunk sono presenti (non scacciate).
    const singlesPresent = singleSlugs.filter((s) => slugs.includes(s)).length;
    expect(singlesPresent).toBe(3);
    // Tutti i match sono semantici e nella fascia alta [0.5, 1].
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });
});
