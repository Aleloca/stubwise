import {
  docChunks,
  docGenerationJobs,
  docGenerations,
  docNodes,
  docPages,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { createFakeEmbeddingClient, FAKE_EMBEDDING_DIMENSION } from "@stubwise/embeddings";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DocNode } from "../nodes.js";
import {
  allRootsDone,
  failGenerationOnRestart,
  finalizeGeneration,
  type FinalizeGenerationDeps,
} from "./finalize.js";

// Test della finalizzazione del DAG (M6): si costruisce un mini-DAG COMPLETO
// direttamente nel DB (una generazione + 2 radici done + figli/nipoti done su
// entrambi gli alberi, con source_paths sovrapposti per gli implements-link), poi
// si esegue finalizeGeneration. Si asseriscono: doc_pages annidate (≥3 livelli),
// doc_chunks con embedding, links implements (functional↔technical) + related,
// swap del puntatore, generazione succeeded con stats, trigger succeeded, prune.

vi.setConfig({ testTimeout: 60_000 });

interface Links {
  type: string;
  slug: string;
  title: string;
}

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

async function createRepository(db: Db): Promise<string> {
  const { repositoryId } = await seedRepository(db);
  return repositoryId;
}

interface InsertNodeOptions {
  parentId?: string | null;
  tree: DocNode["tree"];
  status?: DocNode["status"];
  depth?: number;
  position?: number;
  title?: string;
  slug?: string;
  body?: string;
  sourcePaths?: string[];
  cost?: string;
  error?: string;
}

/** Corpo abbastanza lungo da produrre almeno un chunk markdown. */
function longBody(label: string): string {
  return [
    `## ${label}`,
    `This section describes ${label} in detail with enough words to chunk meaningfully`,
    `and to exercise the markdown-aware chunking and the embedding of the page body.`,
    "",
    `### More about ${label}`,
    `Additional plain-language explanation about ${label} so the page is not empty and`,
    `the related-link similarity has a real vector to work with.`,
  ].join("\n");
}

async function insertNode(
  db: Db,
  generationId: string,
  repositoryId: string,
  opts: InsertNodeOptions,
): Promise<DocNode> {
  const [node] = await db
    .insert(docNodes)
    .values({
      generationId,
      repositoryId,
      parentId: opts.parentId ?? null,
      tree: opts.tree,
      status: opts.status ?? "done",
      depth: opts.depth ?? 0,
      position: opts.position ?? 0,
      title: opts.title ?? "Node",
      slug: opts.slug ?? `slug-${Math.random().toString(36).slice(2, 8)}`,
      body: opts.body ?? "",
      sourcePaths: opts.sourcePaths ?? [],
      cost: opts.cost,
      error: opts.error,
      finishedAt: new Date(),
    })
    .returning();
  if (!node) throw new Error("insert del nodo non ha restituito la riga");
  return node;
}

/**
 * Trigger doc-job collegato alla generazione. Dopo il decoupling (C2) il trigger è già
 * `succeeded` quando la finalizzazione gira (l'orientamento lo chiude al seed del DAG):
 * la finalizzazione NON lo tocca più. Lo seminiamo `succeeded` per riflettere la realtà.
 */
async function insertTrigger(db: Db, repositoryId: string, generationId: string): Promise<string> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({
      repositoryId,
      generationId,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  if (!job) throw new Error("insert del trigger non ha restituito la riga");
  return job.id;
}

/**
 * Costruisce un DAG COMPLETO (tutti i nodi `done`) a 3 livelli su entrambi gli alberi,
 * con source_paths sovrapposti tra tecnico e funzionale (per gli implements-link).
 *
 *  technical root "Architecture"  (depth 0)
 *   └─ tech "API layer"  paths=[apps/server]  (depth 1)
 *       └─ tech "Routes" paths=[apps/server/routes]  (depth 2)
 *  functional root "Capabilities" (depth 0)
 *   └─ fn "User management"  paths=[apps/server/routes]  (depth 1)  ← implements Routes & API layer
 */
async function seedCompleteDag(
  db: Db,
  generationId: string,
  repositoryId: string,
): Promise<void> {
  const techRoot = await insertNode(db, generationId, repositoryId, {
    tree: "technical",
    depth: 0,
    title: "Architecture",
    slug: "architecture",
    body: longBody("Architecture"),
    cost: "0.10",
  });
  const apiLayer = await insertNode(db, generationId, repositoryId, {
    tree: "technical",
    parentId: techRoot.id,
    depth: 1,
    title: "API layer",
    slug: "api-layer",
    body: longBody("API layer"),
    sourcePaths: ["apps/server"],
    cost: "0.05",
  });
  await insertNode(db, generationId, repositoryId, {
    tree: "technical",
    parentId: apiLayer.id,
    depth: 2,
    title: "Routes",
    slug: "routes",
    body: longBody("Routes"),
    sourcePaths: ["apps/server/routes"],
    cost: "0.02",
  });

  const fnRoot = await insertNode(db, generationId, repositoryId, {
    tree: "functional",
    depth: 0,
    title: "Capabilities",
    slug: "capabilities",
    body: longBody("Capabilities"),
    cost: "0.08",
  });
  await insertNode(db, generationId, repositoryId, {
    tree: "functional",
    parentId: fnRoot.id,
    depth: 1,
    title: "User management",
    slug: "user-management",
    body: longBody("User management"),
    sourcePaths: ["apps/server/routes"],
    cost: "0.03",
  });
}

function deps(db: Db): FinalizeGenerationDeps {
  return { db, embeddingClient: createFakeEmbeddingClient() };
}

async function newGeneration(db: Db, repositoryId: string, cost?: string): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "running", model: "opus", cost })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  return gen.id;
}

describe("finalizeGeneration", () => {
  it("proietta il DAG in pagine annidate + chunk, risolve implements + related, fa lo swap e completa il trigger", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db);
    const generationId = await newGeneration(db, repositoryId, "0.20");
    await seedCompleteDag(db, generationId, repositoryId);
    const triggerId = await insertTrigger(db, repositoryId, generationId);

    const outcome = await finalizeGeneration(deps(db), generationId);
    expect(outcome).toBe("succeeded");

    // doc_pages: 5 nodi done → 5 pagine.
    const pages = await db.select().from(docPages).where(eq(docPages.generationId, generationId));
    expect(pages.length).toBe(5);

    // Annidamento ≥ 3 livelli: root → api-layer → routes (parentId risolti).
    const bySlug = new Map(pages.map((p) => [p.slug, p]));
    const root = bySlug.get("architecture");
    const api = bySlug.get("api-layer");
    const routes = bySlug.get("routes");
    expect(root?.parentId).toBeNull();
    expect(api?.parentId).toBe(root!.id);
    expect(routes?.parentId).toBe(api!.id);
    // kind = tree del nodo.
    expect(root?.kind).toBe("technical");
    expect(bySlug.get("capabilities")?.kind).toBe("functional");

    // doc_chunks con embedding 1024-dim.
    const chunks = await db.select().from(docChunks).where(eq(docChunks.generationId, generationId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.embedding?.length).toBe(FAKE_EMBEDDING_DIMENSION);

    // implements: "User management" (fn, paths=apps/server/routes) implementa "Routes"
    // (tech path uguale) e "API layer" (tech path antenato). Inverso implemented_by.
    const userMgmt = bySlug.get("user-management");
    const umLinks = (userMgmt?.links as Links[] | null) ?? [];
    const umImplements = umLinks.filter((l) => l.type === "implements").map((l) => l.slug);
    expect(umImplements).toContain("routes");
    expect(umImplements).toContain("api-layer");
    // Inverso sul tecnico.
    const routesLinks = (routes?.links as Links[] | null) ?? [];
    expect(routesLinks.some((l) => l.type === "implemented_by" && l.slug === "user-management")).toBe(true);

    // related: almeno una pagina con un link related (similarità tra pagine del run).
    const allLinks = pages.flatMap((p) => (p.links as Links[] | null) ?? []);
    expect(allLinks.some((l) => l.type === "related")).toBe(true);
    // related esclude self: nessun link related al proprio slug.
    for (const p of pages) {
      const links = (p.links as Links[] | null) ?? [];
      expect(links.some((l) => l.type === "related" && l.slug === p.slug)).toBe(false);
    }

    // SWAP del puntatore corrente.
    const [repoAfter] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(repoAfter?.currentDocGenerationId).toBe(generationId);

    // Generazione succeeded con stats + costo aggregato (base 0.20 + costi nodi).
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.id, generationId));
    expect(gen?.status).toBe("succeeded");
    const stats = gen?.stats as { nodes: number; doneNodes: number; failedNodes: number; maxDepth: number; pages: number; chunks: number };
    expect(stats.nodes).toBe(5);
    expect(stats.doneNodes).toBe(5);
    expect(stats.failedNodes).toBe(0);
    expect(stats.maxDepth).toBe(2);
    expect(stats.pages).toBe(5);
    expect(stats.chunks).toBe(chunks.length);
    // 0.20 (base/orient) + 0.10+0.05+0.02+0.08+0.03 = 0.48.
    expect(Number(gen?.cost)).toBeCloseTo(0.48, 6);

    // Trigger NON toccato dalla finalizzazione (decoupling C2): resta `succeeded` come
    // chiuso dall'orientamento al seed, collegato alla generazione.
    const [job] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, triggerId));
    expect(job?.status).toBe("succeeded");
    expect(job?.generationId).toBe(generationId);
  });

  it("allRootsDone è true solo quando ENTRAMBE le radici sono done", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db);
    const generationId = await newGeneration(db, repositoryId);

    const r1 = await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      status: "awaiting_children",
      title: "T",
      slug: "t-root",
    });
    await insertNode(db, generationId, repositoryId, {
      tree: "functional",
      status: "awaiting_children",
      title: "F",
      slug: "f-root",
    });
    // Una sola radice done → false.
    expect(await allRootsDone(db, generationId)).toBe(false);

    await db.update(docNodes).set({ status: "done" }).where(eq(docNodes.id, r1.id));
    expect(await allRootsDone(db, generationId)).toBe(false);

    // Entrambe done → true.
    await db
      .update(docNodes)
      .set({ status: "done" })
      .where(and(eq(docNodes.generationId, generationId), isNull(docNodes.parentId)));
    expect(await allRootsDone(db, generationId)).toBe(true);
  });

  it("un nodo failed è saltato dalle pagine ma non blocca la finalizzazione", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db);
    const generationId = await newGeneration(db, repositoryId);

    const techRoot = await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      title: "Arch",
      slug: "arch",
      body: longBody("Arch"),
    });
    // Figlio FAILED (saltato dalla proiezione).
    await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      parentId: techRoot.id,
      depth: 1,
      status: "failed",
      title: "Broken",
      slug: "broken",
      error: "boom",
    });
    await insertNode(db, generationId, repositoryId, {
      tree: "functional",
      title: "Caps",
      slug: "caps",
      body: longBody("Caps"),
    });
    const triggerId = await insertTrigger(db, repositoryId, generationId);

    const outcome = await finalizeGeneration(deps(db), generationId);
    expect(outcome).toBe("succeeded");

    const pages = await db.select().from(docPages).where(eq(docPages.generationId, generationId));
    // Solo i 2 nodi done → 2 pagine; il failed non c'è.
    expect(pages.length).toBe(2);
    expect(pages.some((p) => p.slug === "broken")).toBe(false);

    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.id, generationId));
    expect(gen?.status).toBe("succeeded");
    const stats = gen?.stats as { failedNodes: number; doneNodes: number };
    expect(stats.failedNodes).toBe(1);
    expect(stats.doneNodes).toBe(2);

    const [job] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, triggerId));
    expect(job?.status).toBe("succeeded");
  });

  it("failGenerationOnRestart: generazione running + nodi non-done + trigger → failed (C3)", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db);
    const generationId = await newGeneration(db, repositoryId);

    // Un DAG a metà: una radice awaiting_children, un figlio exploring (in volo), un
    // figlio già done. Il trigger è ancora running (caso reale: l'orientamento aveva
    // chiuso il trigger succeeded, ma testiamo che un trigger residuo running venga
    // chiuso comunque).
    const root = await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      status: "awaiting_children",
      title: "Root",
      slug: "root",
    });
    const exploring = await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      parentId: root.id,
      depth: 1,
      status: "exploring",
      title: "In volo",
      slug: "in-volo",
    });
    const doneChild = await insertNode(db, generationId, repositoryId, {
      tree: "technical",
      parentId: root.id,
      depth: 1,
      status: "done",
      title: "Fatto",
      slug: "fatto",
    });
    const [trigger] = await db
      .insert(docGenerationJobs)
      .values({ repositoryId, generationId, status: "running", startedAt: new Date() })
      .returning();

    const reason = "riavvio worker";
    const result = await failGenerationOnRestart(db, generationId, reason);
    expect(result).toBe(true);

    // Generazione failed con la ragione.
    const [gen] = await db.select().from(docGenerations).where(eq(docGenerations.id, generationId));
    expect(gen?.status).toBe("failed");
    expect(gen?.error).toBe(reason);
    expect(gen?.finishedAt).not.toBeNull();

    // I nodi non-done → failed; il done resta done.
    const nodes = await db.select().from(docNodes).where(eq(docNodes.generationId, generationId));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)?.status).toBe("failed");
    expect(byId.get(exploring.id)?.status).toBe("failed");
    expect(byId.get(doneChild.id)?.status).toBe("done");

    // Trigger running → failed.
    const [jobAfter] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, trigger!.id));
    expect(jobAfter?.status).toBe("failed");

    // Idempotente: una seconda chiamata non fa nulla (generazione già terminale).
    expect(await failGenerationOnRestart(db, generationId, reason)).toBe(false);
  });

  it("prune: tiene corrente + precedente, evince le più vecchie (cascade)", async () => {
    const { db } = testDb;
    const repositoryId = await createRepository(db);

    // Due generazioni vecchie già succeeded.
    const [oldest] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "succeeded", createdAt: new Date(Date.now() - 20_000) })
      .returning();
    const [previous] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "succeeded", createdAt: new Date(Date.now() - 10_000) })
      .returning();
    await db.insert(docPages).values({
      repositoryId,
      generationId: oldest!.id,
      kind: "technical",
      slug: "old",
      title: "Old",
    });

    // Nuova generazione finalizzata (la più recente).
    const generationId = await newGeneration(db, repositoryId);
    await insertNode(db, generationId, repositoryId, { tree: "technical", title: "A", slug: "a", body: longBody("A") });
    await insertNode(db, generationId, repositoryId, { tree: "functional", title: "B", slug: "b", body: longBody("B") });
    await insertTrigger(db, repositoryId, generationId);

    await finalizeGeneration(deps(db), generationId);

    const remaining = await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, repositoryId));
    const ids = new Set(remaining.map((g) => g.id));
    expect(ids.has(generationId)).toBe(true); // corrente
    expect(ids.has(previous!.id)).toBe(true); // precedente
    expect(ids.has(oldest!.id)).toBe(false); // prunata
    expect(remaining.length).toBe(2);
    // Cascade: la pagina della generazione prunata è sparita.
    const orphan = await db.select().from(docPages).where(eq(docPages.generationId, oldest!.id));
    expect(orphan.length).toBe(0);
  });
});
