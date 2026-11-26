import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createFakeEmbeddingClient, type EmbeddingClient } from "@stubwise/embeddings";
import { docChunks, docPages } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { backfillManualPageEmbeddings } from "./doc-embed.js";

// Area 5, fetta 1 (review): le pagine manuali scritte PRIMA della 0142 non hanno
// embedding. Il backfill li dà: idempotente (solo le pagine senza chunk), a
// lotti, fail-open (al primo errore dell'embedder si ferma e riprova al giro dopo).

let t: TestDb;
let repositoryId: string;
const fake = createFakeEmbeddingClient();
let calls = 0;
let failAfter = Infinity;
const embeddingClient: EmbeddingClient = {
  ...fake,
  embed: async (texts) => {
    calls += 1;
    if (calls > failAfter) throw new Error("embedder giù");
    return fake.embed(texts);
  },
};
const log = { warn: () => undefined, info: () => undefined };

beforeAll(async () => {
  t = await startTestDb();
  ({ repositoryId } = await seedRepository(t.db));
}, 120_000);
afterAll(async () => {
  await t.stop();
});
beforeEach(async () => {
  calls = 0;
  failAfter = Infinity;
  await t.db.delete(docPages).where(eq(docPages.repositoryId, repositoryId));
});

async function manual(n: number): Promise<string[]> {
  const rows = await t.db
    .insert(docPages)
    .values(Array.from({ length: n }, (_, i) => ({ repositoryId, kind: "manual" as const, slug: `m-${i}`, title: `M ${i}`, body: `Pagina scritta a mano numero ${i}`, isManual: true })))
    .returning({ id: docPages.id });
  return rows.map((r) => r.id);
}
const withChunks = async (ids: string[]) =>
  new Set((await t.db.selectDistinct({ id: docChunks.pageId }).from(docChunks).where(inArray(docChunks.pageId, ids))).map((r) => r.id));

describe("backfillManualPageEmbeddings", () => {
  it("dà i chunk alle manuali che non li hanno, a lotti, e non rifà quelle che li hanno già", async () => {
    const ids = await manual(5);
    expect(await backfillManualPageEmbeddings(t.db, embeddingClient, log, { batchSize: 2 })).toBe(5);
    expect((await withChunks(ids)).size).toBe(5);
    calls = 0;
    expect(await backfillManualPageEmbeddings(t.db, embeddingClient, log, { batchSize: 2 })).toBe(0);
    expect(calls).toBe(0);
  });

  it("le pagine generate e le manuali vuote non c'entrano", async () => {
    const [empty] = await t.db.insert(docPages).values({ repositoryId, kind: "manual", slug: "vuota", title: "Vuota", body: "  ", isManual: true }).returning({ id: docPages.id });
    await t.db.insert(docPages).values({ repositoryId, kind: "technical", slug: "generata", title: "Generata", body: "Il corpo di una pagina generata" });
    expect(await backfillManualPageEmbeddings(t.db, embeddingClient, log, { batchSize: 10 })).toBe(0);
    expect(calls).toBe(0);
    expect((await withChunks([empty!.id])).size).toBe(0);
  });

  it("con l'embedder giù si ferma al primo errore, e il giro dopo riprende da dove mancano", async () => {
    const ids = await manual(4);
    failAfter = 1;
    expect(await backfillManualPageEmbeddings(t.db, embeddingClient, log, { batchSize: 10 })).toBe(1);
    expect(calls).toBe(2);
    failAfter = Infinity;
    expect(await backfillManualPageEmbeddings(t.db, embeddingClient, log, { batchSize: 10 })).toBe(3);
    expect((await withChunks(ids)).size).toBe(4);
  });
});
