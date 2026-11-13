import { randomUUID } from "node:crypto";
import { AI_OPERATIONS } from "@stubwise/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiModelSettings, calendarEvents, emailMessages, emailProposals, googleAccounts, googleWorkspaces, meetingNotes, projects, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0165 (13 nov 2026, area 6, F5a): le riunioni registrate. L'email
 * di Gemini (`email_messages.kind`), la riunione (`meeting_notes`, una per
 * Doc), gli allegati degli eventi, le proposte della riunione (audience
 * `meeting_invitees`) e l'operazione AI `meeting_summary`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function seedMessage() {
  const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@x.it`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [m] = await t.db.insert(emailMessages).values({ accountId: box!.id, gmailMessageId: randomUUID(), threadId: randomUUID(), fromAddress: "gemini-notes@google.com", receivedAt: new Date() }).returning();
  return { accountId: box!.id, message: m! };
}

describe("migrazione 0165", () => {
  it("`meeting_summary` passa i CHECK, e i CHECK elencano TUTTO il catalogo", async () => {
    const defs = await t.db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('agent_runs_operation_chk', 'ai_model_settings_operation_chk')`,
    );
    expect(defs).toHaveLength(2);
    for (const d of defs) for (const op of AI_OPERATIONS) expect(d.def).toContain(`'${op}'`);
    await t.db.insert(aiModelSettings).values({ operation: "meeting_summary", model: "sonnet" });
  });

  it("un'email nasce `email`; `transcript` si accetta, un altro valore no", async () => {
    const { message } = await seedMessage();
    expect(message.kind).toBe("email");
    await t.db.execute(sql`update email_messages set kind = 'transcript' where id = ${message.id}`);
    await expect(t.db.execute(sql`update email_messages set kind = 'altro' where id = ${message.id}`)).rejects.toThrow();
  });

  it("gli allegati di un evento nascono vuoti", async () => {
    const { accountId } = await seedMessage();
    const [row] = await t.db.insert(calendarEvents).values({ accountId, googleEventId: "e1", startsAt: new Date(), fingerprint: "f" }).returning();
    expect(row!.attachments).toEqual([]);
  });

  it("una riunione per Doc, lo stato nel suo CHECK; una proposta della riunione con la sua audience", async () => {
    const { message } = await seedMessage();
    const [note] = await t.db.insert(meetingNotes).values({ docFileId: "doc-1", sourceMessageId: message.id, rfcMessageId: "<a@b>" }).returning();
    expect(note).toMatchObject({ docStatus: "reading", docReason: null, summary: null, attendeeEmails: [], attempts: 0 });
    await expect(t.db.insert(meetingNotes).values({ docFileId: "doc-1", sourceMessageId: message.id })).rejects.toThrow();
    await expect(t.db.execute(sql`update meeting_notes set doc_status = 'boh' where id = ${note!.id}`)).rejects.toThrow();
    const [p] = await t.db.insert(projects).values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
    const [proposal] = await t.db
      .insert(emailProposals)
      .values({ emailMessageId: message.id, projectId: p!.id, rfcMessageId: "meeting:doc-1", audience: "meeting_invitees", meetingNoteId: note!.id, classification: {} })
      .returning();
    expect(proposal).toMatchObject({ audience: "meeting_invitees", meetingNoteId: note!.id });
  });
});
