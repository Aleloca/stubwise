import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  docChatSessions,
  docChunks,
  docGenerations,
  docNodes,
  docPages,
  searchHistory,
  users,
} from "./schema.js";
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

  it("round-trip di una pagina e di un nodo kind/tree 'product'", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    // Nodo product: la finalize mappa `doc_nodes.tree` → `doc_pages.kind`, quindi
    // il valore 'product' deve essere accettato da entrambi gli enum (doc_tree,
    // doc_page_kind) dopo le migrazioni 0045/0046.
    const [node] = await db
      .insert(docNodes)
      .values({ generationId: gen.id, repositoryId, tree: "product", title: "Guida Portale" })
      .returning();
    if (!node) throw new Error("insert del nodo non ha restituito la riga");
    expect(node.tree).toBe("product");

    const [page] = await db
      .insert(docPages)
      .values({
        repositoryId,
        generationId: gen.id,
        kind: "product",
        slug: "guida-portale",
        title: "Guida Portale",
      })
      .returning();
    if (!page) throw new Error("insert della pagina non ha restituito la riga");

    const [read] = await db.select().from(docPages).where(eq(docPages.id, page.id));
    expect(read?.kind).toBe("product");
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

  it("cronologia di ricerca: una sola voce per (utente, tipo, entità)", async () => {
    const repositoryId = await seedProject();
    const userId = await seedUser();
    const entityId = `${repositoryId}:panoramica`;

    const [entry] = await db
      .insert(searchHistory)
      .values({
        userId,
        type: "doc",
        entityId,
        title: "Panoramica",
        subtitle: "technical",
        route: `/docs/${repositoryId}/panoramica`,
        repositoryId,
      })
      .returning();
    if (!entry) throw new Error("insert della cronologia non ha restituito la riga");
    expect(entry.title).toBe("Panoramica");

    // Stesso (utente, tipo, entità): vietato un secondo INSERT (unique).
    await expect(
      db.insert(searchHistory).values({
        userId,
        type: "doc",
        entityId,
        title: "Dup",
        route: `/docs/${repositoryId}/panoramica`,
        repositoryId,
      }),
    ).rejects.toThrow();
  });
});

/**
 * Migrazione 0034 (Fase 2): le sessioni di chat doc sono a DUE livelli — repo o
 * progetto — con un CHECK che impone l'XOR (esattamente uno tra repository_id e
 * project_id valorizzato). Le righe pre-Fase 2 erano tutte repo-level e restano
 * valide; le sessioni di progetto valorizzano solo project_id.
 */
describe("schema: sessioni chat doc a due livelli (0034)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `utente-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("sessione repo-level valida (repository_id valorizzato, project_id NULL)", async () => {
    const { repositoryId } = await seedRepository(db);
    const userId = await seedUser();
    const [row] = await db
      .insert(docChatSessions)
      .values({ repositoryId, userId })
      .returning();
    expect(row?.repositoryId).toBe(repositoryId);
    expect(row?.projectId).toBeNull();
  });

  it("sessione project-level valida (project_id valorizzato, repository_id NULL)", async () => {
    const { projectId } = await seedRepository(db);
    const userId = await seedUser();
    const [row] = await db
      .insert(docChatSessions)
      .values({ projectId, userId })
      .returning();
    expect(row?.projectId).toBe(projectId);
    expect(row?.repositoryId).toBeNull();
  });

  /**
   * Verifica che l'insert violi il CHECK `doc_chat_sessions_scope_chk`. Il driver
   * `postgres` mette il nome del vincolo in `constraint_name`/`detail`, NON nel
   * messaggio top-level: asseriamo lo SQLSTATE 23514 (check_violation) + il nome.
   */
  async function expectScopeCheckViolation(promise: Promise<unknown>): Promise<void> {
    const caught = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).not.toBeNull();
    // Drizzle avvolge l'errore del driver `postgres` in un DrizzleQueryError: il
    // PgError originale (con code/constraint_name) sta su `.cause`.
    type PgError = { code?: string; constraint_name?: string };
    const wrapper = caught as { cause?: PgError } & PgError;
    const pgError: PgError = wrapper.code ? wrapper : (wrapper.cause ?? {});
    expect(pgError.code).toBe("23514");
    expect(pgError.constraint_name).toBe("doc_chat_sessions_scope_chk");
  }

  it("ENTRAMBI valorizzati: viola il CHECK XOR (insert rifiutato)", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const userId = await seedUser();
    await expectScopeCheckViolation(
      db.insert(docChatSessions).values({ projectId, repositoryId, userId }),
    );
  });

  it("NESSUNO valorizzato: viola il CHECK XOR (insert rifiutato)", async () => {
    const userId = await seedUser();
    await expectScopeCheckViolation(db.insert(docChatSessions).values({ userId }));
  });
});
