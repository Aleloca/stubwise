import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveContentJobs, driveFileChunks, driveFiles, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0145 (11 nov 2026, area 5, fetta 3): il contenuto dei file del
 * Drive. Lo stato, il motivo e l'OCR, il testo con la sua tsvector, il
 * riassunto, i chunk con gli embedding, la coda dei job, e l'operazione AI
 * `drive_summary`.
 */

let t: TestDb;
let projectId: string;
let userId: string;
let n = 0;
beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
  const [u] = await t.db.insert(users).values({ email: "drive-0145@x.test", passwordHash: "x", role: "member" }).returning({ id: users.id });
  userId = u!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function file(name = `f${++n}.pdf`, extra: Partial<typeof driveFiles.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(driveFiles)
    .values({
      projectId,
      number: ++n,
      name,
      mime: "application/pdf",
      type: "pdf",
      sizeBytes: 3,
      storageKey: `drive/${projectId}/${crypto.randomUUID()}/${name}`,
      addedBy: userId,
      ...extra,
    })
    .returning();
  return row!;
}

describe("0145 il contenuto dei file del Drive", () => {
  it("un file nasce `pending`, senza motivo, OCR, testo né riassunto", async () => {
    const f = await file();
    expect(f).toMatchObject({ contentStatus: "pending", contentReason: null, contentOcr: null, contentText: null, contentTruncated: false, summary: null, contentUpdatedAt: null });
  });

  it("stato, motivo e OCR sono chiusi; `no_text` vuole il motivo e solo lui lo porta; il riassunto sta in 600", async () => {
    await expect(file(undefined, { contentStatus: "boh" as never })).rejects.toThrow();
    await expect(file(undefined, { contentStatus: "no_text" })).rejects.toThrow();
    await expect(file(undefined, { contentStatus: "ready", contentReason: "limits" })).rejects.toThrow();
    await expect(file(undefined, { contentStatus: "no_text", contentReason: "boh" as never })).rejects.toThrow();
    await expect(file(undefined, { contentOcr: "boh" as never })).rejects.toThrow();
    await expect(file(undefined, { summary: "x".repeat(601) })).rejects.toThrow();
    expect(await file(undefined, { contentStatus: "no_text", contentReason: "ocr_timeout", contentOcr: "none", summary: "x".repeat(600) })).toMatchObject({ contentReason: "ocr_timeout" });
  });

  it("la tsvector si genera da nome e testo, e il testo non la fa esplodere oltre il tetto", async () => {
    const f = await file("Contratto fornitura.pdf", { contentText: "la clausola penale scatta dopo trenta giorni" });
    const hit = async (q: string) =>
      (await t.db.execute<{ id: string }>(sql`select id from drive_files where content_tsv @@ plainto_tsquery('simple', ${q}) and id = ${f.id}`)).length;
    expect(await hit("penale")).toBe(1);
    expect(await hit("fornitura")).toBe(1);
    expect(await hit("assente")).toBe(0);
    // Un testo da un milione di caratteri (il tetto) di parole diverse: niente «string is too long for tsvector».
    const huge = Array.from({ length: 125_000 }, (_, i) => `w${i.toString(36)}`).join(" ").slice(0, 1_000_000);
    await t.db.update(driveFiles).set({ contentText: huge }).where(eq(driveFiles.id, f.id));
  });

  it("i chunk vanno via col file; l'embedding è a 1024 dimensioni", async () => {
    const f = await file();
    await t.db.insert(driveFileChunks).values({ fileId: f.id, position: 0, content: "uno", embedding: Array.from({ length: 1024 }, () => 0.1) });
    await expect(t.db.insert(driveFileChunks).values({ fileId: f.id, position: 1, content: "due", embedding: [0.1, 0.2] })).rejects.toThrow();
    await t.db.delete(driveFiles).where(eq(driveFiles.id, f.id));
    expect(await t.db.select().from(driveFileChunks).where(eq(driveFileChunks.fileId, f.id))).toHaveLength(0);
  });

  it("la coda: al più un job VIVO per file, lo stato chiuso, e i job vanno via col file", async () => {
    const f = await file();
    await t.db.insert(driveContentJobs).values({ fileId: f.id });
    await expect(t.db.insert(driveContentJobs).values({ fileId: f.id })).rejects.toThrow();
    await t.db.update(driveContentJobs).set({ status: "done" }).where(eq(driveContentJobs.fileId, f.id));
    await t.db.insert(driveContentJobs).values({ fileId: f.id });
    await expect(t.db.insert(driveContentJobs).values({ fileId: f.id, status: "boh" as never })).rejects.toThrow();
    await t.db.delete(driveFiles).where(eq(driveFiles.id, f.id));
    expect(await t.db.select().from(driveContentJobs).where(eq(driveContentJobs.fileId, f.id))).toHaveLength(0);
  });

  it("l'operazione AI `drive_summary` passa i CHECK di agent_runs e ai_model_settings", async () => {
    const defs = await t.db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('agent_runs_operation_chk', 'ai_model_settings_operation_chk')`,
    );
    expect(defs).toHaveLength(2);
    for (const d of defs) expect(d.def).toContain("drive_summary");
  });
});
