import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleAccounts, googleWorkspaces, mailDraftAttachments, mailDrafts, mailOutgoing, users } from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0153 (area 6, F3, scrivere): le bozze (di Gmail, con accanto ciò
 * che Gmail non sa), i loro allegati e gli invii trattenuti 10 s (D6).
 */

let t: TestDb;
let userId: string;
let accountId: string;
beforeAll(async () => {
  t = await startTestDb();
  userId = (await t.db.insert(users).values({ email: "m@acme.com", passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning())[0]!.id;
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  accountId = (await t.db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email: "m@acme.com", googleSub: "1", refreshTokenEncrypted: "r" }).returning())[0]!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0153 bozze e invii", () => {
  it("una bozza ATTIVA per persona, casella, conversazione e modalità (lo slot della nuova compreso)", async () => {
    const base = { userId, accountId, gmailDraftId: `d-${randomUUID()}` };
    const [reply] = await t.db.insert(mailDrafts).values({ ...base, threadId: "t1", mode: "reply" }).returning();
    expect(reply).toMatchObject({ quote: true, state: "active", replyToMessageId: null });
    await expectSqlState(t.db.insert(mailDrafts).values({ ...base, gmailDraftId: "d2", threadId: "t1", mode: "reply" }), "23505");
    await t.db.insert(mailDrafts).values({ ...base, gmailDraftId: "d3", threadId: "t1", mode: "forward" });
    await t.db.insert(mailDrafts).values({ ...base, gmailDraftId: "d4", threadId: null, mode: "new" });
    await expectSqlState(t.db.insert(mailDrafts).values({ ...base, gmailDraftId: "d5", threadId: null, mode: "new" }), "23505");
    // Una bozza IN INVIO non occupa lo slot: se ne può scrivere un'altra.
    await t.db.update(mailDrafts).set({ state: "sending" }).where(eq(mailDrafts.id, reply!.id));
    await t.db.insert(mailDrafts).values({ ...base, gmailDraftId: "d6", threadId: "t1", mode: "reply" });
    await expectSqlState(t.db.execute(sql`update mail_drafts set mode = 'boh' where id = ${reply!.id}`), "23514");
  });

  it("gli allegati: copia o link, e se ne vanno con la bozza", async () => {
    const [draft] = await t.db.insert(mailDrafts).values({ userId, accountId, gmailDraftId: `d-${randomUUID()}`, threadId: "t9", mode: "reply" }).returning();
    const [a] = await t.db.insert(mailDraftAttachments).values({ draftId: draft!.id, name: "a.pdf", sizeBytes: 10, mimeType: "application/pdf", storageKey: "mail/x" }).returning();
    expect(a!.as).toBe("copy");
    await t.db.delete(mailDrafts).where(eq(mailDrafts.id, draft!.id));
    expect(await t.db.select().from(mailDraftAttachments).where(eq(mailDraftAttachments.id, a!.id))).toEqual([]);
  });

  it("un invio nasce in coda, con chi l'ha chiesto e quando parte", async () => {
    const [row] = await t.db.insert(mailOutgoing).values({ userId, accountId, gmailDraftId: "dx", sendAt: new Date(Date.now() + 10_000) }).returning();
    expect(row).toMatchObject({ state: "queued", error: null, gmailMessageId: null });
    await expectSqlState(t.db.execute(sql`update mail_outgoing set state = 'boh' where id = ${row!.id}`), "23514");
  });
});
