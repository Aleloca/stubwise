import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleAccounts, googleWorkspaces, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0149 (area 6, fetta 1): la richiesta di «Aggiorna ora» di una
 * casella (in attesa, e l'ultima fatta, per il tetto dei 60 s) e lo stato
 * letto/non letto di un messaggio (null = non ancora saputo).
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("0149 «Aggiorna ora» e letto/non letto", () => {
  it("una casella nasce senza richieste; le colonne si scrivono", async () => {
    const [user] = await t.db.insert(users).values({ email: "m@acme.com", name: "M", passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning();
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "Acme", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" } as typeof googleWorkspaces.$inferInsert).returning();
    const [account] = await t.db.insert(googleAccounts).values({ userId: user!.id, workspaceId: ws!.id, email: "m@acme.com", googleSub: "1", refreshTokenEncrypted: "r" }).returning();
    expect(account!.syncRequestedAt).toBeNull();
    expect(account!.syncLastRequestedAt).toBeNull();
    const now = new Date();
    const [updated] = await t.db.update(googleAccounts).set({ syncRequestedAt: now, syncLastRequestedAt: now }).where(eq(googleAccounts.id, account!.id)).returning();
    expect(updated!.syncRequestedAt?.getTime()).toBe(now.getTime());
  });

  it("email_messages.unread è null di default (non ancora saputo)", async () => {
    const [col] = await t.db.execute<{ is_nullable: string; column_default: string | null }>(
      sql`select is_nullable, column_default from information_schema.columns where table_name = 'email_messages' and column_name = 'unread'`,
    );
    expect(col).toEqual({ is_nullable: "YES", column_default: null });
  });
});
