import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { seedCommitSummary, seedRepository, startTestDb, type TestDb } from "./testing.js";
import { commitSummaries, docPagePendingCommits, docPages, nightlyItems, repositories } from "./schema.js";

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 120_000);
afterAll(async () => t.stop());

async function seedPage(repositoryId: string) {
  const [p] = await t.db
    .insert(docPages)
    .values({ repositoryId, kind: "technical", slug: `p-${Math.random()}`, title: "P" })
    .returning();
  return p!.id;
}

describe("0089 giro notturno", () => {
  it("commit_summaries: default e PK composta", async () => {
    const { repositoryId } = await seedRepository(t.db);
    const sha = await seedCommitSummary(t.db, { repositoryId });
    const [row] = await t.db.select().from(commitSummaries).where(sql`${commitSummaries.sha} = ${sha}`);
    expect(row!.files).toEqual([]);
    expect(row!.areas).toEqual([]);
    expect(row!.noise).toBe(false);
    expect(row!.onDefaultBranch).toBe(false);
    expect(row!.documentedAt).toBeNull();
    await expect(seedCommitSummary(t.db, { repositoryId, sha })).rejects.toThrow();
  });

  it("commit_summaries sparisce col repository", async () => {
    const { repositoryId } = await seedRepository(t.db);
    await seedCommitSummary(t.db, { repositoryId });
    await t.db.delete(repositories).where(sql`${repositories.id} = ${repositoryId}`);
    const r = await t.db.select().from(commitSummaries).where(sql`${commitSummaries.repositoryId} = ${repositoryId}`);
    expect(r).toHaveLength(0);
  });

  it("nightly_items: default, CHECK, unique, cascata", async () => {
    const { repositoryId, projectId } = await seedRepository(t.db);
    const base = { repositoryId, projectId, phase: "summary" as const, key: "abc", night: "2026-10-16" };
    const [row] = await t.db.insert(nightlyItems).values(base).returning();
    expect(row!.status).toBe("pending");
    expect(row!.failedNights).toBe(0);
    expect(row!.lastFailedNight).toBeNull();
    expect(row!.claimedAt).toBeNull();
    expect(row!.payload).toEqual({});
    await expect(t.db.insert(nightlyItems).values(base)).rejects.toThrow();
    await expect(
      t.db.insert(nightlyItems).values({ ...base, key: "x", phase: "boh" as never }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(nightlyItems).values({ ...base, key: "y", status: "boh" as never }),
    ).rejects.toThrow();
    // stessa chiave, altra fase: ammessa
    await t.db.insert(nightlyItems).values({ ...base, phase: "release" });
    await t.db.delete(repositories).where(sql`${repositories.id} = ${repositoryId}`);
    const left = await t.db.select().from(nightlyItems).where(sql`${nightlyItems.repositoryId} = ${repositoryId}`);
    expect(left).toHaveLength(0);
  });

  it("doc_page_pending_commits: sparisce con la pagina e con il riassunto", async () => {
    const { repositoryId } = await seedRepository(t.db);
    const sha = await seedCommitSummary(t.db, { repositoryId });
    const sha2 = await seedCommitSummary(t.db, { repositoryId });
    const pageId = await seedPage(repositoryId);
    await t.db.insert(docPagePendingCommits).values([
      { pageId, repositoryId, sha },
      { pageId, repositoryId, sha: sha2 },
    ]);
    await expect(t.db.insert(docPagePendingCommits).values({ pageId, repositoryId, sha })).rejects.toThrow();
    // FK composta: uno sha senza riassunto non si lega
    await expect(
      t.db.insert(docPagePendingCommits).values({ pageId, repositoryId, sha: "nope" }),
    ).rejects.toThrow();
    await t.db.delete(commitSummaries).where(sql`${commitSummaries.sha} = ${sha}`);
    let rows = await t.db.select().from(docPagePendingCommits).where(sql`${docPagePendingCommits.pageId} = ${pageId}`);
    expect(rows.map((r) => r.sha)).toEqual([sha2]);
    await t.db.delete(docPages).where(sql`${docPages.id} = ${pageId}`);
    rows = await t.db.select().from(docPagePendingCommits).where(sql`${docPagePendingCommits.pageId} = ${pageId}`);
    expect(rows).toHaveLength(0);
  });

  it("indici attesi", async () => {
    const r = await t.db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes where tablename in ('commit_summaries','nightly_items')`);
    const names = [...r].map((x) => x.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "commit_summaries_repo_committed_idx",
        "commit_summaries_undocumented_idx",
        "nightly_items_pending_idx",
      ]),
    );
  });
});

describe("0090 valore d'enum", () => {
  it("docs.nightly_attention esiste (e request.created, 0093, gli sta dopo)", async () => {
    const r = await t.db.execute<{ enumlabel: string }>(sql`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid
      where ty.typname = 'notification_kind' order by enumsortorder`);
    const labels = [...r].map((x) => x.enumlabel);
    const i = labels.indexOf("docs.nightly_attention");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(labels[i + 1]).toBe("request.created");
    expect(labels[labels.length - 1]).toBe("request.created");
  });
});
