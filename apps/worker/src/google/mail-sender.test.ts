import { randomUUID } from "node:crypto";
import { googleAccounts, googleWorkspaces, mailDrafts, mailOutgoing, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { GoogleApiError } from "@stubwise/google";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recoverInterruptedSends, sendDueMail, type MailSenderClient } from "./mail-sender.js";

/**
 * L'INVIO ALLO SCADERE DEI 10 SECONDI (area 6, F3, task 4, D6): manda solo
 * le righe dovute, una volta sola, e non ritenta mai da solo.
 */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterEach(async () => {
  await db.delete(mailOutgoing);
  await db.delete(mailDrafts);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
});
afterAll(async () => {
  await testDb.stop();
});

function client(sendImpl?: () => Promise<{ messageId: string; threadId: string }>) {
  const sent: string[] = [];
  const c: MailSenderClient = {
    refreshAccessToken: async () => ({ accessToken: "at", expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
    sendDraft: async (input) => {
      sent.push(input.id);
      return sendImpl ? sendImpl() : { messageId: `m-${input.id}`, threadId: "t1" };
    },
  };
  return { c, sent };
}

async function queued(sendAtOffsetMs: number) {
  const [user] = await db.insert(users).values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning();
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [account] = await db.insert(googleAccounts).values({ userId: user!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [draft] = await db.insert(mailDrafts).values({ userId: user!.id, accountId: account!.id, gmailDraftId: `gd-${randomUUID()}`, threadId: "t1", mode: "reply", state: "sending" }).returning();
  const [row] = await db
    .insert(mailOutgoing)
    .values({ userId: user!.id, accountId: account!.id, draftId: draft!.id, gmailDraftId: draft!.gmailDraftId, threadId: "t1", sendAt: sql`now() + make_interval(secs => ${sendAtOffsetMs / 1000})` })
    .returning();
  return { row: row!, draft: draft!, account: account! };
}
const deps = (c: MailSenderClient) => ({
  db,
  encryptionKey: Buffer.alloc(32),
  client: c,
  loadCredentials: async () => ({ clientId: "c", clientSecret: "s", refreshToken: "r", email: "x", accountId: "a" }) as never,
});
const reload = async (id: string) => (await db.select().from(mailOutgoing).where(eq(mailOutgoing.id, id)))[0]!;

describe("sendDueMail", () => {
  it("manda le righe DOVUTE: la bozza di Gmail parte, la riga è sent, la bozza se ne va", async () => {
    const { row, draft } = await queued(-1000);
    const { c, sent } = client();
    expect(await sendDueMail(deps(c))).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([draft.gmailDraftId]);
    expect(await reload(row.id)).toMatchObject({ state: "sent", gmailMessageId: `m-${draft.gmailDraftId}`, gmailThreadId: "t1" });
    expect(await db.select().from(mailDrafts).where(eq(mailDrafts.id, draft.id))).toEqual([]);
  });

  it("NIENTE prima dei 10 secondi, e niente di annullato", async () => {
    const early = await queued(60_000);
    const gone = await queued(-1000);
    await db.update(mailOutgoing).set({ state: "cancelled" }).where(eq(mailOutgoing.id, gone.row.id));
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
    expect((await reload(early.row.id)).state).toBe("queued");
  });

  it("un fallimento resta failed col suo codice, e il giro dopo NON ritenta", async () => {
    const { row } = await queued(-1000);
    const { c, sent } = client(async () => {
      throw new GoogleApiError({ api: "gmail.drafts.send", status: 429, code: "rate_limited", reason: "rateLimitExceeded" });
    });
    await sendDueMail(deps(c));
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "quota" });
    await sendDueMail(deps(c));
    expect(sent).toHaveLength(1);
  });

  it("due giri insieme: UNA email sola", async () => {
    const { row } = await queued(-1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { c, sent } = client(async () => {
      await gate;
      return { messageId: "m", threadId: "t1" };
    });
    const a = sendDueMail(deps(c));
    const b = sendDueMail(deps(c));
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(1);
    expect((await reload(row.id)).state).toBe("sent");
  });

  it("una casella disabilitata: failed account_disabled, nessuna chiamata", async () => {
    const { row, account } = await queued(-1000);
    await db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "revoked" }).where(eq(googleAccounts.id, account.id));
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "account_disabled" });
  });
});

describe("recoverInterruptedSends", () => {
  it("un invio rimasto `sending` (worker morto a metà) diventa failed interrupted, e NON si rimanda", async () => {
    const { row } = await queued(-1000);
    await db.update(mailOutgoing).set({ state: "sending" }).where(eq(mailOutgoing.id, row.id));
    expect(await recoverInterruptedSends(db)).toBe(1);
    expect(await reload(row.id)).toMatchObject({ state: "failed", error: "interrupted" });
    const { c, sent } = client();
    await sendDueMail(deps(c));
    expect(sent).toEqual([]);
  });
});
