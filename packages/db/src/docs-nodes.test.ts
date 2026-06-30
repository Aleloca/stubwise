import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { docGenerations, docNodes, docPages } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del DAG di documentazione (enum `doc_node_status`/
 * `doc_tree`, tabella `doc_nodes`, colonna `doc_pages.links`) sia applicabile su
 * un Postgres reale: persistenza di un nodo radice + un figlio con i default
 * attesi e round-trip dei `links` jsonb su una pagina.
 */
describe("schema: nodi del DAG Docs", () => {
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

  it("persiste un nodo radice (default) e un figlio collegato via parent_id", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    // Radice tecnica: parentId null, default su status/pendingChildren/sourcePaths.
    const [root] = await db
      .insert(docNodes)
      .values({ generationId: gen.id, repositoryId, tree: "technical", parentId: null })
      .returning();
    if (!root) throw new Error("insert del nodo radice non ha restituito la riga");

    const [readRoot] = await db.select().from(docNodes).where(eq(docNodes.id, root.id));
    expect(readRoot?.parentId).toBeNull();
    expect(readRoot?.status).toBe("pending");
    expect(readRoot?.pendingChildren).toBe(0);
    expect(readRoot?.depth).toBe(0);
    expect(readRoot?.sourcePaths).toEqual([]);

    // Figlio: parentId = radice, depth 1.
    const [child] = await db
      .insert(docNodes)
      .values({
        generationId: gen.id,
        repositoryId,
        tree: "technical",
        parentId: root.id,
        depth: 1,
      })
      .returning();
    if (!child) throw new Error("insert del nodo figlio non ha restituito la riga");

    const [readChild] = await db.select().from(docNodes).where(eq(docNodes.id, child.id));
    expect(readChild?.parentId).toBe(root.id);
    expect(readChild?.depth).toBe(1);
    expect(readChild?.status).toBe("pending");
  });

  it("una pagina può portare un valore jsonb in links (round-trip)", async () => {
    const repositoryId = await seedProject();
    const [gen] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!gen) throw new Error("insert della generazione non ha restituito la riga");

    const links = [
      { type: "implements", slug: "modulo-auth", title: "Autenticazione" },
      { type: "related", slug: "panoramica", title: "Panoramica" },
    ];
    const [page] = await db
      .insert(docPages)
      .values({
        repositoryId,
        generationId: gen.id,
        kind: "functional",
        slug: "login",
        title: "Login",
        links,
      })
      .returning();
    if (!page) throw new Error("insert della pagina non ha restituito la riga");

    const [read] = await db
      .select({ links: docPages.links })
      .from(docPages)
      .where(eq(docPages.id, page.id));
    expect(read?.links).toEqual(links);
  });
});
