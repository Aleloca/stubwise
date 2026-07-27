import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { graphJobs, repoGraphs, repositories } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione dell'integrazione graphify (toggle sul repository +
 * `repo_graphs` + coda `graph_jobs`) sia applicabile su un Postgres reale:
 * default del toggle, round-trip dei metadati del grafo, indice unico parziale
 * che tiene un solo job attivo per (repository, kind) e cascata sul delete.
 */
describe("schema: integrazione graphify", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("espone il toggle graphEnabled sul repository (default false)", async () => {
    const { repositoryId } = await seedRepository(db);
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    if (!repository) throw new Error("read del repository non ha restituito la riga");
    expect(repository.graphEnabled).toBe(false);
  });

  it("persiste i metadati del grafo di un repository e ne applica i default", async () => {
    const { repositoryId } = await seedRepository(db);

    const [inserted] = await db.insert(repoGraphs).values({ repositoryId }).returning();
    if (!inserted) throw new Error("insert dei metadati del grafo non ha restituito la riga");

    expect(inserted.status).toBe("none");
    expect(inserted.labeled).toBe(false);
    expect(inserted.commitSha).toBeNull();
    expect(inserted.nodeCount).toBeNull();
    expect(inserted.edgeCount).toBeNull();
    expect(inserted.communityCount).toBeNull();
    expect(inserted.setupPrUrl).toBeNull();
    expect(inserted.error).toBeNull();
    expect(inserted.generatedAt).toBeNull();
    expect(inserted.createdAt).toBeInstanceOf(Date);

    await db
      .update(repoGraphs)
      .set({
        status: "done",
        commitSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
        nodeCount: 1200,
        edgeCount: 4300,
        communityCount: 17,
        labeled: true,
        generatedAt: new Date(),
      })
      .where(eq(repoGraphs.repositoryId, repositoryId));

    const [readBack] = await db
      .select()
      .from(repoGraphs)
      .where(eq(repoGraphs.repositoryId, repositoryId));
    if (!readBack) throw new Error("read-back dei metadati del grafo non ha restituito la riga");
    expect(readBack.status).toBe("done");
    expect(readBack.commitSha).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6");
    expect(readBack.nodeCount).toBe(1200);
    expect(readBack.edgeCount).toBe(4300);
    expect(readBack.communityCount).toBe(17);
    expect(readBack.labeled).toBe(true);
    expect(readBack.generatedAt).toBeInstanceOf(Date);
  });

  it("una sola riga di metadati per repository (repository_id è la primary key)", async () => {
    const { repositoryId } = await seedRepository(db);
    await db.insert(repoGraphs).values({ repositoryId });
    await expect(db.insert(repoGraphs).values({ repositoryId })).rejects.toThrow();
  });

  it("accoda un job build con i default (queued, attempts 0, force false)", async () => {
    const { repositoryId } = await seedRepository(db);

    const [job] = await db.insert(graphJobs).values({ repositoryId, kind: "build" }).returning();
    if (!job) throw new Error("insert del job di grafo non ha restituito la riga");

    expect(job.kind).toBe("build");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.force).toBe(false);
    expect(job.notBefore).toBeNull();
    expect(job.error).toBeNull();
    expect(job.claimedAt).toBeNull();
    expect(job.createdAt).toBeInstanceOf(Date);
  });

  it("indice unico parziale: due job build attivi sullo stesso repository → errore", async () => {
    const { repositoryId } = await seedRepository(db);
    await db.insert(graphJobs).values({ repositoryId, kind: "build" });

    // Secondo queued: rifiutato (il debounce del webhook AGGIORNA il queued
    // esistente invece di accodarne un altro).
    await expect(db.insert(graphJobs).values({ repositoryId, kind: "build" })).rejects.toThrow();
    // Anche running collide con queued: entrambi sono stati "attivi".
    await expect(
      db.insert(graphJobs).values({ repositoryId, kind: "build", status: "running" }),
    ).rejects.toThrow();
  });

  it("indice unico parziale: kind diversi e job conclusi non collidono", async () => {
    const { repositoryId } = await seedRepository(db);

    // Un build attivo e un setup_pr attivo convivono: l'indice è per (repo, kind).
    await db.insert(graphJobs).values({ repositoryId, kind: "build" });
    const [setupPr] = await db
      .insert(graphJobs)
      .values({ repositoryId, kind: "setup_pr" })
      .returning();
    expect(setupPr!.kind).toBe("setup_pr");

    // Uno storico di job conclusi non partecipa all'indice parziale.
    await db.insert(graphJobs).values({ repositoryId, kind: "build", status: "done" });
    await db.insert(graphJobs).values({ repositoryId, kind: "build", status: "failed" });

    const rows = await db.select().from(graphJobs).where(eq(graphJobs.repositoryId, repositoryId));
    expect(rows).toHaveLength(4);
  });

  it("kind e status sono text senza CHECK: la validazione è applicativa (tipi drizzle)", async () => {
    const { repositoryId } = await seedRepository(db);

    // A livello DB le colonne sono `text` (nessun enum Postgres, nessun CHECK):
    // il vincolo su build|setup_pr e queued|running|done|failed è compile-time
    // (`text(..., { enum: [...] })` in schema.ts) più la validazione del worker
    // al dequeue. Qui verifichiamo solo il round-trip dei valori ammessi.
    for (const kind of ["build", "setup_pr"] as const) {
      const [job] = await db
        .insert(graphJobs)
        .values({ repositoryId, kind, status: "done" })
        .returning();
      expect(job!.kind).toBe(kind);
    }
  });

  it("il delete del repository cascata su metadati del grafo e job", async () => {
    const { repositoryId } = await seedRepository(db);
    await db.insert(repoGraphs).values({ repositoryId });
    await db.insert(graphJobs).values({ repositoryId, kind: "build" });

    await db.delete(repositories).where(eq(repositories.id, repositoryId));

    const graphs = await db
      .select()
      .from(repoGraphs)
      .where(eq(repoGraphs.repositoryId, repositoryId));
    expect(graphs).toHaveLength(0);
    const jobs = await db.select().from(graphJobs).where(eq(graphJobs.repositoryId, repositoryId));
    expect(jobs).toHaveLength(0);
  });
});
