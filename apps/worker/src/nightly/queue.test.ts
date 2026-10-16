import {
  commitSummaries,
  docPagePendingCommits,
  docPages,
  nightlyItems,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  claimNext,
  completeItem,
  enqueueItems,
  failItem,
  NIGHTLY_ITEM_LEASE_MS,
  pendingCount,
  releaseItem,
  upsertTargetItems,
  type NightlyItem,
} from "./queue.js";

let testDb: TestDb;
let repositoryId: string;
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  ({ repositoryId, projectId } = await seedRepository(testDb.db));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(docPagePendingCommits);
  await testDb.db.delete(nightlyItems);
  await testDb.db.delete(docPages);
  await testDb.db.delete(commitSummaries);
});

afterAll(async () => {
  await testDb.stop();
});

async function getItem(db: Db, id: string): Promise<NightlyItem> {
  const [row] = await db.select().from(nightlyItems).where(eq(nightlyItems.id, id));
  if (!row) throw new Error(`elemento ${id} non trovato`);
  return row;
}

async function seedSummary(db: Db, sha: string): Promise<void> {
  await db.insert(commitSummaries).values({
    repositoryId,
    sha,
    committedAt: new Date(),
    authorName: "Dev",
    authorEmail: "dev@x.it",
    subject: `commit ${sha}`,
    summary: "riassunto",
  });
}

async function seedPage(db: Db): Promise<string> {
  const [page] = await db
    .insert(docPages)
    .values({ repositoryId, kind: "technical", slug: `p-${Math.random()}`, title: "Pagina" })
    .returning();
  return page!.id;
}

async function enqueueOne(
  db: Db,
  phase: NightlyItem["phase"],
  key: string,
  payload: Record<string, unknown> = {},
  night = "2026-10-15"
): Promise<NightlyItem> {
  await enqueueItems(db, [{ repositoryId, projectId, phase, key, payload }], night);
  const [row] = await db
    .select()
    .from(nightlyItems)
    .where(and(eq(nightlyItems.phase, phase), eq(nightlyItems.key, key)));
  return row!;
}

describe("enqueueItems", () => {
  it("inserisce e restituisce le righe NUOVE; rieseguire non duplica", async () => {
    const { db } = testDb;
    const items = [
      { repositoryId, projectId, phase: "summary" as const, key: "aaa1111" },
      { repositoryId, projectId, phase: "summary" as const, key: "bbb2222", payload: { x: 1 } },
    ];
    expect(await enqueueItems(db, items, "2026-10-15")).toBe(2);
    expect(await enqueueItems(db, items, "2026-10-16")).toBe(0);
    expect(await enqueueItems(db, [], "2026-10-16")).toBe(0);
    const rows = await db.select().from(nightlyItems);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending" && r.night === "2026-10-15")).toBe(true);
    expect(rows.find((r) => r.key === "bbb2222")!.payload).toEqual({ x: 1 });
    expect(await pendingCount(db, repositoryId)).toBe(2);
    expect(await pendingCount(db, repositoryId, "summary")).toBe(2);
    expect(await pendingCount(db, repositoryId, "release")).toBe(0);
  });
});

describe("claimNext (lease)", () => {
  it("due claim di seguito non restituiscono lo stesso elemento; il più vecchio per primo", async () => {
    const { db } = testDb;
    await enqueueOne(db, "summary", "first");
    await enqueueOne(db, "summary", "second");
    await enqueueOne(db, "release", "other-phase");

    const a = await claimNext(db, repositoryId, "summary");
    const b = await claimNext(db, repositoryId, "summary");
    const c = await claimNext(db, repositoryId, "summary");
    expect(a?.key).toBe("first");
    expect(b?.key).toBe("second");
    expect(c).toBeNull();
    // Lo stato resta pending: un riavvio non perde niente.
    expect((await getItem(db, a!.id)).status).toBe("pending");
    expect(a!.claimedAt).not.toBeNull();
  });

  it("claim CONCORRENTI: nessun elemento consegnato due volte", async () => {
    const { db } = testDb;
    for (let i = 0; i < 5; i++) await enqueueOne(db, "summary", `k${i}`);
    const results = await Promise.all(Array.from({ length: 8 }, () => claimNext(db, repositoryId, "summary")));
    const keys = results.filter((r): r is NightlyItem => r !== null).map((r) => r.key);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
  });

  it("dopo la lease l'elemento è di nuovo reclamabile; releaseItem lo libera subito", async () => {
    const { db } = testDb;
    const item = await enqueueOne(db, "summary", "leased");
    expect((await claimNext(db, repositoryId, "summary"))?.id).toBe(item.id);
    expect(await claimNext(db, repositoryId, "summary")).toBeNull();

    // Lease scaduta (orologio del DB): claimed_at più vecchio della lease.
    await db
      .update(nightlyItems)
      .set({ claimedAt: sql`now() - ${NIGHTLY_ITEM_LEASE_MS + 1000} * interval '1 millisecond'` })
      .where(eq(nightlyItems.id, item.id));
    expect((await claimNext(db, repositoryId, "summary"))?.id).toBe(item.id);

    await releaseItem(db, item.id);
    const released = await getItem(db, item.id);
    expect(released.claimedAt).toBeNull();
    expect(released.status).toBe("pending");
    expect(released.failedNights).toBe(0);
    expect((await claimNext(db, repositoryId, "summary"))?.id).toBe(item.id);
  });

  it("completeItem chiude l'elemento: done, mai più reclamato", async () => {
    const { db } = testDb;
    const item = await enqueueOne(db, "summary", "done-me");
    await claimNext(db, repositoryId, "summary");
    await completeItem(db, item.id);
    const row = await getItem(db, item.id);
    expect(row.status).toBe("done");
    expect(row.claimedAt).toBeNull();
    expect(await pendingCount(db, repositoryId)).toBe(0);
    expect(await claimNext(db, repositoryId, "summary")).toBeNull();
  });
});

describe("failItem", () => {
  it("3 notti DIVERSE → escalated; resta pending e liberato prima", async () => {
    const { db } = testDb;
    const item = await enqueueOne(db, "release", "a..b");
    await claimNext(db, repositoryId, "release");
    expect(await failItem(db, item.id, "e1", "2026-10-15")).toBe("retry");
    let row = await getItem(db, item.id);
    expect(row).toMatchObject({ status: "pending", failedNights: 1, lastFailedNight: "2026-10-15", lastError: "e1" });
    expect(row.claimedAt).toBeNull();

    expect(await failItem(db, item.id, "e2", "2026-10-16")).toBe("retry");
    row = await getItem(db, item.id);
    expect(row).toMatchObject({ status: "pending", failedNights: 2, lastFailedNight: "2026-10-16" });

    expect(await failItem(db, item.id, "e3", "2026-10-17")).toBe("escalated");
    row = await getItem(db, item.id);
    expect(row).toMatchObject({ status: "escalated", failedNights: 3, lastError: "e3" });
    expect(await claimNext(db, repositoryId, "release")).toBeNull();
    // Un release escalato non scrive righe di pagine.
    expect(await db.select().from(docPagePendingCommits)).toHaveLength(0);
  });

  it("due volte la STESSA notte → failed_nights 1", async () => {
    const { db } = testDb;
    const item = await enqueueOne(db, "summary", "same-night");
    expect(await failItem(db, item.id, "e1", "2026-10-15")).toBe("retry");
    expect(await failItem(db, item.id, "e2", "2026-10-15")).toBe("retry");
    expect(await failItem(db, item.id, "e3", "2026-10-15")).toBe("retry");
    const row = await getItem(db, item.id);
    expect(row).toMatchObject({ status: "pending", failedNights: 1, lastError: "e3" });
  });

  it("page_update escalated → righe doc_page_pending_commits per i commit del payload (solo quelli riassunti)", async () => {
    const { db } = testDb;
    const pageId = await seedPage(db);
    await seedSummary(db, "c1");
    await seedSummary(db, "c2");
    const item = await enqueueOne(db, "page_update", `${pageId}@head1`, {
      pageId,
      commits: ["c1", "c2", "senza-riassunto"],
    });
    for (const night of ["2026-10-15", "2026-10-16"]) await failItem(db, item.id, "x", night);
    expect(await db.select().from(docPagePendingCommits)).toHaveLength(0);
    expect(await failItem(db, item.id, "x", "2026-10-17")).toBe("escalated");

    const rows = await db.select().from(docPagePendingCommits);
    expect(rows.map((r) => r.sha).sort()).toEqual(["c1", "c2"]);
    expect(rows.every((r) => r.pageId === pageId && r.repositoryId === repositoryId)).toBe(true);
  });

  it("seconda escalation della stessa pagina con commit in parte uguali → unione senza duplicati", async () => {
    const { db } = testDb;
    const pageId = await seedPage(db);
    for (const sha of ["c1", "c2", "c3"]) await seedSummary(db, sha);
    const first = await enqueueOne(db, "page_update", `${pageId}@head1`, { pageId, commits: ["c1", "c2"] });
    const second = await enqueueOne(db, "page_update", `${pageId}@head2`, { pageId, commits: ["c2", "c3"] });
    for (const night of ["2026-10-15", "2026-10-16", "2026-10-17"]) {
      await failItem(db, first.id, "x", night);
      await failItem(db, second.id, "x", night);
    }
    const rows = await db.select().from(docPagePendingCommits);
    expect(rows.map((r) => r.sha).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("payload.pageId di una pagina cancellata (o malformato) → escalation riuscita, nessuna riga", async () => {
    const { db } = testDb;
    await seedSummary(db, "c1");
    const pageId = await seedPage(db);
    await db.delete(docPages).where(eq(docPages.id, pageId));
    const gone = await enqueueOne(db, "page_update", `${pageId}@h`, { pageId, commits: ["c1"] });
    const bad = await enqueueOne(db, "page_update", "bad@h", { pageId: "non-un-uuid", commits: "c1" });
    for (const night of ["2026-10-15", "2026-10-16"]) {
      await failItem(db, gone.id, "x", night);
      await failItem(db, bad.id, "x", night);
    }
    expect(await failItem(db, gone.id, "x", "2026-10-17")).toBe("escalated");
    expect(await failItem(db, bad.id, "x", "2026-10-17")).toBe("escalated");
    expect(await db.select().from(docPagePendingCommits)).toHaveLength(0);
  });

  it("su un elemento già chiuso non conta nulla", async () => {
    const { db } = testDb;
    const item = await enqueueOne(db, "summary", "closed");
    await completeItem(db, item.id);
    expect(await failItem(db, item.id, "tardi", "2026-10-15")).toBe("retry");
    expect(await getItem(db, item.id)).toMatchObject({ status: "done", failedNights: 0, lastError: null });
  });
});

describe("upsertTargetItems", () => {
  it("riallinea il pending della stessa pagina al bersaglio nuovo conservando failed_nights; non tocca un done", async () => {
    const { db } = testDb;
    const pageId = await seedPage(db);
    // Storia: un bersaglio vecchio già chiuso.
    const done = await enqueueOne(db, "page_update", `${pageId}@sha0`, { v: 0 });
    await completeItem(db, done.id);

    expect(
      await upsertTargetItems(
        db,
        [{ repositoryId, projectId, phase: "page_update", target: pageId, toSha: "sha1", payload: { v: 1 } }],
        "2026-10-15"
      )
    ).toBe(1);
    const [pending] = await db
      .select()
      .from(nightlyItems)
      .where(and(eq(nightlyItems.status, "pending"), eq(nightlyItems.phase, "page_update")));
    expect(pending!.key).toBe(`${pageId}@sha1`);
    await failItem(db, pending!.id, "x", "2026-10-15");

    // Notte dopo: il bersaglio avanza. Stessa riga, failed_nights conservato.
    expect(
      await upsertTargetItems(
        db,
        [{ repositoryId, projectId, phase: "page_update", target: pageId, toSha: "sha2", payload: { v: 2 } }],
        "2026-10-16"
      )
    ).toBe(1);
    const realigned = await getItem(db, pending!.id);
    expect(realigned).toMatchObject({
      key: `${pageId}@sha2`,
      payload: { v: 2 },
      night: "2026-10-16",
      status: "pending",
      failedNights: 1,
      lastFailedNight: "2026-10-15",
    });
    expect(await getItem(db, done.id)).toMatchObject({ key: `${pageId}@sha0`, status: "done", payload: { v: 0 } });
    expect(await pendingCount(db, repositoryId, "page_update")).toBe(1);

    // Stesso bersaglio rieseguito: idempotente.
    expect(
      await upsertTargetItems(
        db,
        [{ repositoryId, projectId, phase: "page_update", target: pageId, toSha: "sha2", payload: { v: 2 } }],
        "2026-10-16"
      )
    ).toBe(0);
    expect(await db.select().from(nightlyItems)).toHaveLength(2);
  });

  it("il prefisso non è un pattern: un target con % o _ non tocca altri bersagli", async () => {
    const { db } = testDb;
    await upsertTargetItems(
      db,
      [{ repositoryId, projectId, phase: "page_create", target: "area_x", toSha: "s1", payload: {} }],
      "2026-10-15"
    );
    await upsertTargetItems(
      db,
      [{ repositoryId, projectId, phase: "page_create", target: "area%", toSha: "s2", payload: {} }],
      "2026-10-15"
    );
    await upsertTargetItems(
      db,
      [{ repositoryId, projectId, phase: "page_create", target: "area_", toSha: "s2", payload: {} }],
      "2026-10-15"
    );
    const keys = (await db.select().from(nightlyItems)).map((r) => r.key).sort();
    expect(keys).toEqual(["area%@s2", "area_@s2", "area_x@s1"]);
  });
});
