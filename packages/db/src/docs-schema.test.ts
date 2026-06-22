import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { docChunks, docGenerations, docPages, projects } from "./schema.js";
import { seedGitAccount, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del dominio Docs (estensione pgvector + tabelle)
 * sia applicabile su un Postgres reale: persistenza di generazioni/pagine
 * (incluse le manuali con generationId null) e round-trip dell'embedding con
 * ricerca per distanza coseno (indice HNSW).
 */
describe("schema: dominio Docs", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedProject(): Promise<string> {
    const gitAccountId = await seedGitAccount(db);
    const [project] = await db
      .insert(projects)
      .values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        provider: "github",
        gitAccountId,
        repoUrl: "https://example.com/repo.git",
        defaultBranch: "main",
        ingestionKey: randomUUID(),
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  it("persiste una generazione (status default pending) e una pagina manuale (generationId null)", async () => {
    const projectId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ projectId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    const [page] = await db
      .insert(docPages)
      .values({
        projectId,
        generationId: null,
        kind: "manual",
        slug: "guida",
        title: "Guida",
        isManual: true,
      })
      .returning();
    if (!page) throw new Error("insert della pagina non ha restituito la riga");

    const [read] = await db.select().from(docPages).where(eq(docPages.id, page.id));
    expect(read?.generationId).toBeNull();
    expect(read?.isManual).toBe(true);
    expect(read?.kind).toBe("manual");
    expect(gen.status).toBe("pending");
  });

  it("inserisce un chunk con embedding a 1024 dim e fa ricerca per distanza coseno", async () => {
    const projectId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ projectId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    const [page] = await db
      .insert(docPages)
      .values({
        projectId,
        generationId: gen.id,
        kind: "technical",
        slug: "panoramica",
        title: "Panoramica",
      })
      .returning();
    if (!page) throw new Error("insert della pagina non ha restituito la riga");

    // Vettore unitario sul primo asse: distanza coseno minima da sé stesso.
    const emb = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const [chunk] = await db
      .insert(docChunks)
      .values({
        pageId: page.id,
        projectId,
        generationId: gen.id,
        content: "ciao",
        embedding: emb,
      })
      .returning();
    if (!chunk) throw new Error("insert del chunk non ha restituito la riga");

    const rows = await db.execute<{ content: string }>(sql`
      SELECT content FROM doc_chunks
      ORDER BY embedding <=> ${`[${emb.join(",")}]`}::vector
      LIMIT 1
    `);
    expect(rows[0]?.content).toBe("ciao");

    // Round-trip dell'embedding attraverso Drizzle: copre vector.fromDriver,
    // che la SELECT raw sopra (solo content) non esercita.
    const [read] = await db
      .select({ embedding: docChunks.embedding })
      .from(docChunks)
      .where(eq(docChunks.id, chunk.id));
    expect(Array.isArray(read?.embedding)).toBe(true);
    expect(read?.embedding).toHaveLength(1024);
    expect(read?.embedding?.[0]).toBe(1);
  });
});
