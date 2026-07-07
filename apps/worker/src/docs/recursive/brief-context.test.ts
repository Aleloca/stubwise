import { docGenerations, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { ProjectBrief } from "@stubwise/docs-engine";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearBriefContextCache, loadBriefContext } from "./brief-context.js";

// Test della cache per-processo del contesto brief. Copre l'invariante della nota A3: un
// errore DB TRANSITORIO non deve cacheare `null` in modo permanente (altrimenti il brief
// resterebbe invisibile a explore/synthesize per tutta la vita del processo anche dopo che
// il DB torna raggiungibile).

let testDb: TestDb;
let repositoryId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  clearBriefContextCache();
  await testDb.db.delete(docGenerations);
});

afterAll(async () => {
  await testDb.stop();
});

function briefFixture(): ProjectBrief {
  return {
    identity: "A product.",
    actors: [{ name: "Customer", description: "buys", internal: false }],
    surfaces: [],
    glossary: [{ term: "Ticket", definition: "a unit of work" }],
    invariants: ["A ticket has an owner"],
    confidentialFacts: [],
    journeys: [],
    existingSources: [],
  };
}

async function newGeneration(db: Db, brief: ProjectBrief | null): Promise<string> {
  const [gen] = await db
    .insert(docGenerations)
    .values({ repositoryId, status: "running", model: "opus", brief })
    .returning();
  if (!gen) throw new Error("insert della generazione non ha restituito la riga");
  return gen.id;
}

describe("loadBriefContext", () => {
  it("carica il contesto del brief e lo cachea (una sola query al DB)", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, briefFixture());

    const first = await loadBriefContext(db, generationId);
    expect(first).toBeDefined();
    expect(first).toContain("Ticket");

    // Spia sul DB per assicurarsi che il secondo caricamento NON interroghi più il DB.
    const spy = vi.spyOn(db, "select");
    const second = await loadBriefContext(db, generationId);
    expect(second).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("generazione senza brief → undefined, cacheato (no ri-query)", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, null);

    expect(await loadBriefContext(db, generationId)).toBeUndefined();

    const spy = vi.spyOn(db, "select");
    expect(await loadBriefContext(db, generationId)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("errore DB transitorio NON cachea null: un retry dopo il ripristino ricarica il brief", async () => {
    const { db } = testDb;
    const generationId = await newGeneration(db, briefFixture());

    // Primo tentativo: il DB lancia (errore transitorio) → undefined, NIENTE cache set.
    const failing = vi
      .spyOn(db, "select")
      .mockImplementationOnce(() => {
        throw new Error("transient DB error");
      });
    expect(await loadBriefContext(db, generationId)).toBeUndefined();
    failing.mockRestore();

    // Secondo tentativo (DB ripristinato): DEVE ri-interrogare e restituire il brief, NON
    // il null cacheato dall'errore.
    const ok = await loadBriefContext(db, generationId);
    expect(ok).toBeDefined();
    expect(ok).toContain("Ticket");
  });
});
