import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphJobs, repositories } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0194 (19 nov 2026, area 9, F6): il job `prune` della coda dei
 * grafi sopravvive al repository che pota (niente FK) e porta l'URL.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0194", () => {
  it("un job prune resta dopo l'eliminazione del repository, con il suo URL", async () => {
    const { repositoryId } = await seedRepository(t.db);
    const [job] = await t.db.insert(graphJobs).values({ repositoryId, kind: "prune", repoUrl: "https://example.com/repo.git" }).returning();
    await t.db.delete(repositories).where(eq(repositories.id, repositoryId));
    const [after] = await t.db.select().from(graphJobs).where(eq(graphJobs.id, job!.id));
    expect(after).toMatchObject({ repositoryId, kind: "prune", repoUrl: "https://example.com/repo.git", status: "queued" });
    // Un id che non esiste si scrive (nessuna FK).
    await t.db.insert(graphJobs).values({ repositoryId: randomUUID(), kind: "prune", repoUrl: "x" });
  });

  it("il migratore ha applicato 0193 e 0194 in fila, e TUTTO il journal nel suo ordine", async () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };
    const tags = journal.entries.map((e) => e.tag);
    const i = tags.indexOf("0193_project_archive");
    expect(tags.slice(i, i + 2)).toEqual(["0193_project_archive", "0194_graph_job_prune"]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens.every((w, k) => k === 0 || w > whens[k - 1]!)).toBe(true);
    const applied = (await t.db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as { rows?: { created_at: string }[] } & { created_at: string }[];
    expect(((applied.rows ?? applied) as { created_at: string }[]).map((r) => Number(r.created_at))).toEqual(whens);
  });
});
