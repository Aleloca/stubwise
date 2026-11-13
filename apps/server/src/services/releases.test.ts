import { randomUUID } from "node:crypto";
import { prReleaseNotes, releases, repositories, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordRelease, type RecordReleaseInput } from "./releases.js";

/**
 * Area 8, F1, S3: il rilascio nasce dal merge, da Stubwise o dal webhook, in
 * qualunque ordine, e una PR mergiata è UN rilascio (anche con il commit di
 * merge abbreviato da una strada e intero dall'altra). Solo un merge sul ramo
 * di rilascio è un rilascio. I fatti delle due strade si uniscono.
 */

let t: TestDb;
let db: Db;
beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function repo() {
  const { repositoryId } = await seedRepository(db);
  const [r] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
  return r!;
}
const input = (repositoryId: string, defaultBranch: string, over: Partial<RecordReleaseInput> = {}): RecordReleaseInput => ({
  repositoryId,
  targetBranch: defaultBranch,
  prNumber: 7,
  prUrl: "https://x/pr/7",
  title: "Checkout nuovo",
  mergeSha: "a".repeat(40),
  mergedAt: new Date(),
  mergedBy: null,
  mergedGitName: null,
  viaStubwise: false,
  ...over,
});
const releasesOf = (repositoryId: string) => db.select().from(releases).where(eq(releases.repositoryId, repositoryId));

describe("recordRelease", () => {
  it("il merge da Stubwise crea il rilascio <PRJ>-V1; il webhook dopo (sha abbreviato) non ne crea un secondo e aggiunge il nome git", async () => {
    const r = await repo();
    const [user] = await db.insert(users).values({ email: `m-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const userId = user!.id;
    const first = await recordRelease(db, input(r.id, r.defaultBranch, { viaStubwise: true, mergedBy: userId }));
    expect(first).toMatchObject({ recorded: true, created: true });
    const second = await recordRelease(db, input(r.id, r.defaultBranch, { mergeSha: "a".repeat(12), mergedGitName: "marta" }));
    expect(second).toMatchObject({ recorded: true, created: false });
    const rows = await releasesOf(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ viaStubwise: true, mergedGitName: "marta", mergedBy: userId, seq: 1 });
    expect(rows[0]!.code).toMatch(/-V1$/);
  });

  it("il webhook prima e il merge da Stubwise dopo: via_stubwise diventa vero, mai il contrario", async () => {
    const r = await repo();
    await recordRelease(db, input(r.id, r.defaultBranch, { mergedGitName: "marta" }));
    await recordRelease(db, input(r.id, r.defaultBranch, { viaStubwise: true }));
    await recordRelease(db, input(r.id, r.defaultBranch, { viaStubwise: false }));
    expect((await releasesOf(r.id))[0]).toMatchObject({ viaStubwise: true, mergedGitName: "marta" });
  });

  it("un merge su un ramo che non è quello di rilascio non è un rilascio; con release_branch impostato vale quello", async () => {
    const r = await repo();
    expect(await recordRelease(db, input(r.id, r.defaultBranch, { targetBranch: "develop" }))).toEqual({ recorded: false, reason: "not_release_branch" });
    await db.update(repositories).set({ releaseBranch: "release" }).where(eq(repositories.id, r.id));
    expect(await recordRelease(db, input(r.id, r.defaultBranch))).toEqual({ recorded: false, reason: "not_release_branch" });
    expect(await recordRelease(db, input(r.id, r.defaultBranch, { targetBranch: "release" }))).toMatchObject({ recorded: true });
  });

  it("i codici crescono per progetto e le note della PR si fermano nel rilascio", async () => {
    const r = await repo();
    await db.insert(prReleaseNotes).values({ repositoryId: r.id, prNumber: 8, body: "- AUD-3 Checkout" });
    await recordRelease(db, input(r.id, r.defaultBranch, { prNumber: 7, mergeSha: randomUUID() }));
    await recordRelease(db, input(r.id, r.defaultBranch, { prNumber: 8, mergeSha: randomUUID() }));
    const rows = (await releasesOf(r.id)).sort((a, b) => a.seq - b.seq);
    expect(rows.map((x) => x.seq)).toEqual([1, 2]);
    expect(rows[1]!.releaseNotes).toBe("- AUD-3 Checkout");
    expect(rows[0]!.releaseNotes).toBeNull();
  });

  it("due strade INSIEME: un rilascio solo", async () => {
    const r = await repo();
    await Promise.all([
      recordRelease(db, input(r.id, r.defaultBranch, { viaStubwise: true })),
      recordRelease(db, input(r.id, r.defaultBranch, { mergedGitName: "marta" })),
    ]);
    const rows = await releasesOf(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ viaStubwise: true, mergedGitName: "marta" });
  });
});
