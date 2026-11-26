import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailMessages, googleAccounts, googleWorkspaces, meetingNotes, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/** Migrazione 0166 (13 nov 2026, review F5a, punto 2): i Doc candidati e il motivo `not_verified`. */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("migrazione 0166", () => {
  it("i candidati nascono vuoti; `not_verified` passa il CHECK, un altro motivo no", async () => {
    const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@x.it`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
    const [m] = await t.db.insert(emailMessages).values({ accountId: box!.id, gmailMessageId: randomUUID(), threadId: randomUUID(), fromAddress: "gemini-notes@google.com", receivedAt: new Date() }).returning();
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: "d1", sourceMessageId: m!.id }).returning();
    expect(note!.docCandidates).toEqual([]);
    await t.db.execute(sql`update meeting_notes set doc_status = 'unreachable', doc_reason = 'not_verified' where id = ${note!.id}`);
    await expect(t.db.execute(sql`update meeting_notes set doc_reason = 'boh' where id = ${note!.id}`)).rejects.toThrow();
  });
});
