import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { emailRejections, googleAccounts, googleWorkspaces, users } from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0080 («le mail tenute fuori», 25 set 2026): una riga per mail
 * scartata dal cancello di ammissione, senza contenuto.
 *
 * L'unique `(account_id, gmail_message_id)` è l'idempotenza del contatore: una
 * mail scartata non entra in `email_messages`, quindi a ogni rilettura della
 * casella viene rivalutata — senza l'unique conterebbe due volte. Il CHECK sul
 * motivo è l'unica difesa dei valori (un CHECK e non un pgEnum, per restare in
 * un solo batch, come `calendar_series.action`).
 */
describe("schema: email_rejections («le mail tenute fuori»)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedAccount(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    const [workspace] = await db
      .insert(googleWorkspaces)
      .values({
        name: "Acme",
        domains: ["acme.test"],
        clientId: "123.apps.googleusercontent.com",
        clientSecretEncrypted: "blob-cifrato",
      })
      .returning();
    const [account] = await db
      .insert(googleAccounts)
      .values({
        userId: user!.id,
        workspaceId: workspace!.id,
        email: `casella-${randomUUID()}@acme.test`,
        googleSub: randomUUID(),
        refreshTokenEncrypted: "blob-cifrato",
      })
      .returning();
    return account!.id;
  }

  it("una riga si scrive, con rejected_at di default", async () => {
    const accountId = await seedAccount();
    const [row] = await db
      .insert(emailRejections)
      .values({ accountId, gmailMessageId: "m1", senderDomain: "github.com", reason: "automated" })
      .returning();
    expect(row?.reason).toBe("automated");
    expect(row?.senderDomain).toBe("github.com");
    expect(row?.rejectedAt).toBeInstanceOf(Date);
  });

  it("l'unique rifiuta la stessa mail della stessa casella due volte", async () => {
    const accountId = await seedAccount();
    await db.insert(emailRejections).values({ accountId, gmailMessageId: "m1", reason: "no_match" });
    await expectSqlState(
      db.insert(emailRejections).values({ accountId, gmailMessageId: "m1", reason: "automated" }),
      "23505",
    );
  });

  it("lo stesso id Gmail su due caselle diverse sono due righe", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await db.insert(emailRejections).values({ accountId: a, gmailMessageId: "m1", reason: "no_match" });
    await db.insert(emailRejections).values({ accountId: b, gmailMessageId: "m1", reason: "no_match" });
    const rows = await db.select().from(emailRejections).where(eq(emailRejections.gmailMessageId, "m1"));
    expect(rows.filter((r) => r.accountId === a || r.accountId === b)).toHaveLength(2);
  });

  it("il CHECK rifiuta un motivo fuori elenco", async () => {
    const accountId = await seedAccount();
    await expectSqlState(
      db.execute(
        sql`insert into email_rejections (account_id, gmail_message_id, reason) values (${accountId}, 'm1', 'workspace_domain')`,
      ),
      "23514",
    );
  });

  it("accetta i tre motivi del cancello", async () => {
    const accountId = await seedAccount();
    for (const reason of ["automated", "denied_label", "no_match"] as const) {
      await db.insert(emailRejections).values({ accountId, gmailMessageId: `m-${reason}`, reason });
    }
    const rows = await db.select().from(emailRejections).where(eq(emailRejections.accountId, accountId));
    expect(rows).toHaveLength(3);
  });

  it("sender_domain accetta null (mittente non leggibile)", async () => {
    const accountId = await seedAccount();
    const [row] = await db
      .insert(emailRejections)
      .values({ accountId, gmailMessageId: "m1", senderDomain: null, reason: "no_match" })
      .returning();
    expect(row?.senderDomain).toBeNull();
  });

  it("cancellare la casella cancella i suoi scarti (CASCADE)", async () => {
    const accountId = await seedAccount();
    await db.insert(emailRejections).values({ accountId, gmailMessageId: "m1", reason: "no_match" });
    await db.delete(googleAccounts).where(eq(googleAccounts.id, accountId));
    const rows = await db.select().from(emailRejections).where(eq(emailRejections.accountId, accountId));
    expect(rows).toHaveLength(0);
  });
});
