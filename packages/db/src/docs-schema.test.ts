import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { docChunks, docGenerations, docPages, docSearchHistory, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

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
    const { repositoryId } = await seedRepository(db);
    return repositoryId;
  }

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `utente-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("persiste una generazione (status default pending) e una pagina manuale (generationId null)", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    const [page] = await db
      .insert(docPages)
      .values({
        repositoryId,
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

  it("permette lo stesso slug a generazioni diverse ma lo vieta dentro una generazione", async () => {
    const repositoryId = await seedProject();
    const [gen1] = await db.insert(docGenerations).values({ repositoryId }).returning();
    const [gen2] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen1 || !gen2) throw new Error("insert delle generazioni non ha restituito la riga");

    // Stesso slug deterministico ("overview") in due generazioni diverse: OK.
    await db
      .insert(docPages)
      .values({ repositoryId, generationId: gen1.id, kind: "technical", slug: "overview", title: "G1" });
    await db
      .insert(docPages)
      .values({ repositoryId, generationId: gen2.id, kind: "technical", slug: "overview", title: "G2" });

    // Stesso slug DENTRO la stessa generazione: vietato (unique generation_id+slug).
    await expect(
      db
        .insert(docPages)
        .values({ repositoryId, generationId: gen1.id, kind: "technical", slug: "overview", title: "dup" }),
    ).rejects.toThrow();
  });

  it("mantiene unico lo slug tra le pagine manuali ma non collide con quelle autogenerate", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    // Una pagina autogenerata con slug "overview"...
    await db
      .insert(docPages)
      .values({ repositoryId, generationId: gen.id, kind: "technical", slug: "overview", title: "auto" });
    // ...non collide con una pagina manuale dello stesso slug (indice parziale).
    await db
      .insert(docPages)
      .values({ repositoryId, generationId: null, kind: "manual", slug: "overview", title: "manuale", isManual: true });

    // Ma due pagine manuali con lo stesso slug nello stesso progetto: vietato.
    await expect(
      db
        .insert(docPages)
        .values({ repositoryId, generationId: null, kind: "manual", slug: "overview", title: "dup", isManual: true }),
    ).rejects.toThrow();
  });

  it("inserisce un chunk con embedding a 1024 dim e fa ricerca per distanza coseno", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    const [page] = await db
      .insert(docPages)
      .values({
        repositoryId,
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
        repositoryId,
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

  it("cronologia di ricerca: una sola voce per (utente, progetto, slug)", async () => {
    const repositoryId = await seedProject();
    const userId = await seedUser();

    const [entry] = await db
      .insert(docSearchHistory)
      .values({ repositoryId, userId, slug: "panoramica", title: "Panoramica", kind: "technical" })
      .returning();
    if (!entry) throw new Error("insert della cronologia non ha restituito la riga");
    expect(entry.title).toBe("Panoramica");

    // Stesso (utente, progetto, slug): vietato un secondo INSERT (unique).
    await expect(
      db
        .insert(docSearchHistory)
        .values({ repositoryId, userId, slug: "panoramica", title: "Dup", kind: "technical" }),
    ).rejects.toThrow();
  });
});
