import { randomUUID } from "node:crypto";
import { googleAccounts, googleWorkspaces, users } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRecipientUserIds } from "./mail-recipients.js";

/**
 * Area 6, F2 (D4): i destinatari di un'email che sono persone di Stubwise.
 * Due strade per riconoscerle: l'email dell'utente e quella delle sue caselle
 * Google collegate, normalizzate («Nome <A@B>» → a@b).
 */

let t: TestDb;
let ada: string;
let bruno: string;
let claudeEmail: string;
beforeAll(async () => {
  t = await startTestDb();
  const insert = async (email: string) =>
    (await t.db.insert(users).values({ email, passwordHash: "x", role: "member" } as typeof users.$inferInsert).returning())[0]!.id;
  ada = await insert("ada@acme.com");
  bruno = await insert("bruno@altro.it");
  // L'utente di sistema di Claude esiste già (unico, dalla migrazione).
  claudeEmail = (await t.db.select({ email: users.email }).from(users).where(eq(users.isAgent, true)))[0]!.email;
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  await t.db.insert(googleAccounts).values({ userId: bruno, workspaceId: ws!.id, email: "bruno@acme.com", googleSub: randomUUID(), refreshTokenEncrypted: "r" });
  // Una casella collegata di qualcuno che l'email NON nomina: non è destinataria.
  const carla = await insert("carla@altro.it");
  await t.db.insert(googleAccounts).values({ userId: carla, workspaceId: ws!.id, email: "carla@acme.com", googleSub: randomUUID(), refreshTokenEncrypted: "r" });
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("resolveRecipientUserIds", () => {
  it("riconosce per email dell'utente e della casella, senza maiuscole e coi nomi", async () => {
    const ids = await resolveRecipientUserIds(t.db, ["Ada <ADA@acme.com>", "bruno@acme.com", "sconosciuto@x.it", ""]);
    expect([...ids].sort()).toEqual([ada, bruno].sort());
  });

  it("una persona sola anche se compare con due indirizzi; mai l'utente di sistema di Claude", async () => {
    const ids = await resolveRecipientUserIds(t.db, ["bruno@altro.it", "bruno@acme.com", claudeEmail]);
    expect(ids).toEqual([bruno]);
  });

  it("nessun indirizzo: nessuna query, elenco vuoto", async () => {
    expect(await resolveRecipientUserIds(t.db, [])).toEqual([]);
  });
});
