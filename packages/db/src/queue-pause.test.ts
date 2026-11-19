import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectQueueRunnable, repositoryQueueRunnable } from "./queue-pause.js";
import { projects } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Il frammento che OGNI claim di una coda di Claude mette nella sua WHERE:
 * la pausa di F4 e, da F6 (D-8), l'archivio. Un progetto archiviato non
 * riceve lavoro nuovo; il lavoro già partito finisce e nulla si cancella.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function runnable(projectId: string, repositoryId: string) {
  const res = (await t.db.execute(sql`select ${projectQueueRunnable(sql`${projectId}::uuid`)} as p, ${repositoryQueueRunnable(sql`${repositoryId}::uuid`)} as r`)) as unknown as { rows?: { p: boolean; r: boolean }[] } & { p: boolean; r: boolean }[];
  return (res.rows ?? res)[0]!;
}

describe("projectQueueRunnable / repositoryQueueRunnable", () => {
  it("aperto: sì; in pausa: no; archiviato: no; riaperto: di nuovo sì", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    expect(await runnable(projectId, repositoryId)).toEqual({ p: true, r: true });
    await t.db.update(projects).set({ queuePausedAt: new Date() }).where(eq(projects.id, projectId));
    expect(await runnable(projectId, repositoryId)).toEqual({ p: false, r: false });
    await t.db.update(projects).set({ queuePausedAt: null, archivedAt: new Date() }).where(eq(projects.id, projectId));
    expect(await runnable(projectId, repositoryId)).toEqual({ p: false, r: false });
    await t.db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId));
    expect(await runnable(projectId, repositoryId)).toEqual({ p: true, r: true });
  });
});
