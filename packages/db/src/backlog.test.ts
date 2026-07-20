import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { backlogItems, backlogJobs, projects } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del backlog di discovery (enum + tabelle + toggle
 * sul progetto) sia applicabile su un Postgres reale: persistenza di una voce
 * con embedding pgvector 1024-dim, round-trip dei default (status/requestCount)
 * e di un job intake, e del toggle backlogEnabled sul progetto.
 */
describe("schema: backlog di discovery", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("persiste una voce di backlog con embedding e ne applica i default", async () => {
    const { projectId } = await seedRepository(db);
    const embedding = Array.from({ length: 1024 }, (_, i) => (i % 10) / 10);

    const [inserted] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Consentire l'export CSV dei report",
        document: "Gli utenti vogliono esportare i report in CSV.",
        source: "ticket",
        embedding,
        suggested: { effort: 3, risk: "medium", urgency: "high", reason: "richiesta ricorrente" },
      })
      .returning();
    if (!inserted) throw new Error("insert della voce di backlog non ha restituito la riga");

    expect(inserted.status).toBe("new");
    expect(inserted.requestCount).toBe(1);
    expect(inserted.effort).toBeNull();
    expect(inserted.risk).toBeNull();
    expect(inserted.similarToId).toBeNull();
    expect(inserted.mergedIntoId).toBeNull();
    expect(inserted.suggested).toEqual({
      effort: 3,
      risk: "medium",
      urgency: "high",
      reason: "richiesta ricorrente",
    });

    const [readBack] = await db
      .select()
      .from(backlogItems)
      .where(eq(backlogItems.id, inserted.id));
    if (!readBack) throw new Error("read-back della voce di backlog non ha restituito la riga");
    expect(readBack.embedding).toHaveLength(1024);
    expect(readBack.embedding?.[1]).toBeCloseTo(0.1);
  });

  it("accoda un job intake con status queued di default", async () => {
    const { projectId } = await seedRepository(db);

    const [job] = await db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { ticketId: "abc-123" } })
      .returning();
    if (!job) throw new Error("insert del job di backlog non ha restituito la riga");

    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.kind).toBe("intake");
    expect(job.payload).toEqual({ ticketId: "abc-123" });
  });

  it("espone il toggle backlogEnabled sul progetto (default false)", async () => {
    const { projectId } = await seedRepository(db);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error("read del progetto non ha restituito la riga");
    expect(project.backlogEnabled).toBe(false);
  });
});
