import { docGenerations, projects, type Db } from "@stubwise/db";
import { seedGitAccount, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pruneOldGenerations } from "./pipeline.js";

// Test del solo helper sopravvissuto alla rimozione del motore piatto (M7.2):
// pruneOldGenerations. Copre l'invariante "la corrente non è MAI prunata", anche
// quando è più vecchia di run più recenti (caso che la vecchia logica per createdAt
// DESC + top-2 evinceva erroneamente). Il flusso end-to-end della generazione è
// coperto dai test del motore a DAG (recursive/*).

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let uniq = 0;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

async function createProject(db: Db): Promise<string> {
  uniq++;
  const gitAccountId = await seedGitAccount(db);
  const [project] = await db
    .insert(projects)
    .values({
      name: `Prune ${uniq}`,
      slug: `prune-${uniq}`,
      provider: "github",
      gitAccountId,
      repoUrl: "https://github.com/acme/prune",
      defaultBranch: "main",
      ingestionKey: `ingestion-prune-${uniq}`,
    })
    .returning();
  if (!project) throw new Error("insert del progetto non ha restituito la riga");
  return project.id;
}

describe("pruneOldGenerations", () => {
  it("non evince MAI la corrente succeeded anche se esistono due generazioni più recenti failed", async () => {
    const { db } = testDb;
    const projectId = await createProject(db);

    // Corrente: succeeded, ma più VECCHIA delle due failed (il caso che la vecchia
    // logica per createdAt DESC + top-2 evinceva erroneamente).
    const [current] = await db
      .insert(docGenerations)
      .values({ projectId, status: "succeeded", createdAt: new Date(Date.now() - 30_000) })
      .returning();
    await db
      .update(projects)
      .set({ currentDocGenerationId: current!.id })
      .where(eq(projects.id, projectId));
    // Due generazioni NEWER e failed.
    const [failedOld] = await db
      .insert(docGenerations)
      .values({ projectId, status: "failed", createdAt: new Date(Date.now() - 20_000) })
      .returning();
    const [failedNew] = await db
      .insert(docGenerations)
      .values({ projectId, status: "failed", createdAt: new Date(Date.now() - 10_000) })
      .returning();

    await pruneOldGenerations(db, projectId, current!.id);

    const remaining = await db.select().from(docGenerations).where(eq(docGenerations.projectId, projectId));
    const ids = new Set(remaining.map((g) => g.id));
    // La corrente succeeded NON è prunata (guard autoritativo su currentGenerationId).
    expect(ids.has(current!.id)).toBe(true);
    // Si tiene anche la singola altra più recente (la failed più nuova); la failed
    // più vecchia è prunata → resta "corrente + 1".
    expect(ids.has(failedNew!.id)).toBe(true);
    expect(ids.has(failedOld!.id)).toBe(false);
    expect(remaining.length).toBe(2);
  });
});
