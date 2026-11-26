import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailMessages, emailProposalRecipients, emailProposals, googleAccounts, googleWorkspaces, users } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0151 (area 6, F2): la classificazione per email (importanza,
 * scadenza, progetti incerti, Message-ID) e la proposta CONDIVISA per email e
 * progetto (D4), coi suoi destinatari.
 */

let t: TestDb;
let projectId: string;
let accountId: string;
let userId: string;
beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
  const [user] = await t.db.insert(users).values({ email: "m@acme.com", passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning();
  userId = user!.id;
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [account] = await t.db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email: "m@acme.com", googleSub: "1", refreshTokenEncrypted: "r" }).returning();
  accountId = account!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function message(overrides: Partial<typeof emailMessages.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(emailMessages)
    .values({ accountId, gmailMessageId: `g-${randomUUID()}`, threadId: "t", fromAddress: "a@x.it", receivedAt: new Date(), ...overrides })
    .returning();
  return row!;
}

describe("0151 classificazione per email e proposta condivisa", () => {
  it("i campi nuovi del messaggio: null/[] di default, e i valori ammessi", async () => {
    const row = await message();
    expect(row).toMatchObject({ rfcMessageId: null, classificationState: null, importance: null, dueDate: null, uncertainProjectIds: [] });
    const done = await message({ rfcMessageId: "<a@x>", classificationState: "done", importance: "high", dueDate: "2026-11-20" });
    expect(done.dueDate).toBe("2026-11-20");
    await expectSqlState(t.db.execute(sql`update email_messages set importance = 'boh' where id = ${row.id}`), "23514");
    await expectSqlState(t.db.execute(sql`update email_messages set classification_state = 'boh' where id = ${row.id}`), "23514");
  });

  it("una proposta condivisa: unica per Message-ID e progetto; le vecchie (senza Message-ID) restano libere", async () => {
    const a = await message({ rfcMessageId: "<shared@x>" });
    const b = await message({ rfcMessageId: "<shared@x>" });
    const [p] = await t.db
      .insert(emailProposals)
      .values({ emailMessageId: a.id, projectId, classification: {}, rfcMessageId: "<shared@x>", audience: "mail_recipients" })
      .returning();
    expect(p).toMatchObject({ audience: "mail_recipients", decidedByUserId: null, confirmedIndices: null, results: null });
    await expectSqlState(
      t.db.insert(emailProposals).values({ emailMessageId: b.id, projectId, classification: {}, rfcMessageId: "<shared@x>" }),
      "23505",
    );
    const [legacy] = await t.db.insert(emailProposals).values({ emailMessageId: b.id, projectId, classification: {} }).returning();
    expect(legacy!.audience).toBe("mailbox_owner");
    expect(legacy!.rfcMessageId).toBeNull();
    await expectSqlState(t.db.execute(sql`update email_proposals set audience = 'boh' where id = ${legacy!.id}`), "23514");
  });

  it("i destinatari di una proposta: uno per persona, e se ne vanno con la proposta", async () => {
    const m = await message({ rfcMessageId: "<r@x>" });
    const [p] = await t.db.insert(emailProposals).values({ emailMessageId: m.id, projectId, classification: {}, rfcMessageId: "<r@x>", audience: "mail_recipients" }).returning();
    await t.db.insert(emailProposalRecipients).values({ proposalId: p!.id, userId });
    await expectSqlState(t.db.insert(emailProposalRecipients).values({ proposalId: p!.id, userId }), "23505");
    await t.db.delete(emailProposals).where(eq(emailProposals.id, p!.id));
    expect(await t.db.select().from(emailProposalRecipients)).toEqual([]);
  });
});
