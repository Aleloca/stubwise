import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatChannels, chatMessageCitations, chatMessages, driveFiles, driveOpens, users } from "./schema.js";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0143 (11 nov 2026, area 5, fetta 2): il Drive dei file caricati.
 * `drive_files` con la lapide (il numero F non si riusa), il nome unico fra i
 * vivi del progetto, la sorgente chiusa; `drive_opens`; il `kind` `drive` delle
 * citazioni della Chat.
 */

let t: TestDb;
let projectId: string;
let userId: string;
beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
  const [u] = await t.db.insert(users).values({ email: "drive-0143@x.test", passwordHash: "x", role: "member" }).returning({ id: users.id });
  userId = u!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const file = (number: number, name: string, extra: Partial<typeof driveFiles.$inferInsert> = {}) => ({
  projectId,
  number,
  source: "upload" as const,
  name,
  mime: "application/pdf",
  type: "pdf" as const,
  sizeBytes: 3,
  storageKey: `drive/${projectId}/${crypto.randomUUID()}/${name}`,
  addedBy: userId,
  ...extra,
});

describe("0143 il Drive", () => {
  it("numero unico per progetto, anche fra le lapidi; nome unico solo fra i vivi (senza maiuscole)", async () => {
    await t.db.insert(driveFiles).values(file(1, "Contratto.pdf"));
    await expect(t.db.insert(driveFiles).values(file(1, "Altro.pdf"))).rejects.toThrow();
    await expect(t.db.insert(driveFiles).values(file(2, "contratto.PDF"))).rejects.toThrow();
    // Eliminato (lapide): il nome si libera, il numero no.
    await t.db.update(driveFiles).set({ deletedAt: new Date(), deletedBy: userId }).where(and(eq(driveFiles.projectId, projectId), eq(driveFiles.number, 1)));
    await t.db.insert(driveFiles).values(file(2, "Contratto.pdf"));
    await expect(t.db.insert(driveFiles).values(file(1, "Nuovo.pdf"))).rejects.toThrow();
  });

  it("la sorgente è chiusa e il tipo pure", async () => {
    await expect(t.db.insert(driveFiles).values(file(10, "g.pdf", { source: "google" as never }))).rejects.toThrow();
    await expect(t.db.insert(driveFiles).values(file(11, "x.pdf", { type: "boh" as never }))).rejects.toThrow();
  });

  it("le aperture vanno via col file", async () => {
    const [f] = await t.db.insert(driveFiles).values(file(20, "aperture.pdf")).returning({ id: driveFiles.id });
    await t.db.insert(driveOpens).values({ fileId: f!.id, personId: userId, via: "preview" });
    await t.db.delete(driveFiles).where(eq(driveFiles.id, f!.id));
    expect(await t.db.select().from(driveOpens).where(eq(driveOpens.fileId, f!.id))).toHaveLength(0);
    await expect(t.db.insert(driveOpens).values({ fileId: crypto.randomUUID(), personId: userId, via: "boh" as never })).rejects.toThrow();
  });

  it("le citazioni della Chat accolgono il kind drive", async () => {
    const [g] = await t.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.projectId, projectId), eq(chatChannels.isGeneral, true)));
    const [m] = await t.db.insert(chatMessages).values({ channelId: g!.id, body: "AUD-F2" }).returning({ id: chatMessages.id });
    await t.db.insert(chatMessageCitations).values({ messageId: m!.id, kind: "drive", refId: crypto.randomUUID() });
    await expect(t.db.execute(sql`insert into chat_message_citations (message_id, kind, ref_id) values (${m!.id}, 'boh', gen_random_uuid())`)).rejects.toThrow();
  });
});
