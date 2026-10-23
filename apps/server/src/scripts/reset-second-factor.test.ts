import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  notifications,
  personalAccessTokens,
  sessions,
  userBackupCodes,
  userPasskeys,
  users,
  userTotp,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { listSecurityEvents } from "../auth/second-factor/security-events.js";
import { createSession } from "../auth/session.js";
import { parseArgs, resetSecondFactorByEmail, run } from "./reset-second-factor.js";

/**
 * Lo script di recupero dell'ultimo admin chiuso fuori: stessa cancellazione
 * del reset da chi gestisce gli utenti, ma senza un utente che agisce.
 */

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function lockedOutAdmin() {
  const email = `last-admin-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: "x", role: "admin" })
    .returning({ id: users.id });
  const id = row!.id;
  await testDb.db.insert(userTotp).values({ userId: id, secretEncrypted: "s", confirmedAt: new Date() });
  await testDb.db
    .insert(userPasskeys)
    .values({ userId: id, credentialId: `cred-${email}`, publicKey: "pk", name: "Chiave" });
  await regenerateBackupCodes(testDb.db, id);
  await createSession(testDb.db, id, { stage: "full", secondFactorAt: new Date() });
  await testDb.db
    .insert(personalAccessTokens)
    .values({ userId: id, name: "cli", tokenHash: `hash-${email}` });
  return { id, email };
}

describe("resetSecondFactorByEmail", () => {
  it("azzera per email: app, passkey, codici e sessioni; i token restano; evento «server script» e avviso", async () => {
    const admin = await lockedOutAdmin();

    expect(await resetSecondFactorByEmail(testDb.db, admin.email)).toBe(true);

    for (const table of [userTotp, userPasskeys, userBackupCodes, sessions]) {
      expect(await testDb.db.select().from(table).where(eq(table.userId, admin.id))).toEqual([]);
    }
    expect(
      await testDb.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, admin.id)),
    ).toHaveLength(1);
    const [event] = await listSecurityEvents(testDb.db, admin.id);
    expect(event).toMatchObject({
      kind: "second_factor_reset",
      userEmail: admin.email,
      actorUserId: null,
      actorEmail: "server script",
    });
    const alerts = await testDb.db
      .select({ event: notifications.event })
      .from(notifications)
      .where(and(eq(notifications.userId, admin.id), eq(notifications.kind, "security.alert")));
    expect(alerts.map((a) => a.event)).toEqual([
      expect.objectContaining({ subject: "second_factor_reset", actorEmail: "server script" }),
    ]);
  });

  it("email inesistente → false, nulla di scritto", async () => {
    const before = await testDb.db.select().from(notifications);
    expect(await resetSecondFactorByEmail(testDb.db, "nessuno@example.com")).toBe(false);
    expect(await testDb.db.select().from(notifications)).toEqual(before);
  });
});

describe("parseArgs", () => {
  it("prende --email <email>, e nient'altro", () => {
    expect(parseArgs(["--email", "admin@example.com"])).toEqual({ email: "admin@example.com" });
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["--email"])).toBeNull();
    expect(parseArgs(["--email", "--dry-run"])).toBeNull();
  });
});

describe("run (il comando)", () => {
  const quiet = { info: () => {}, error: () => {} };

  it("email inesistente → exit 1; senza --email → exit 1", async () => {
    expect(await run(testDb.db, ["--email", "nessuno@example.com"], quiet)).toBe(1);
    expect(await run(testDb.db, [], quiet)).toBe(1);
  });

  it("email esistente → exit 0, e il 2FA è azzerato", async () => {
    const admin = await lockedOutAdmin();
    expect(await run(testDb.db, ["--email", admin.email], quiet)).toBe(0);
    expect(await testDb.db.select().from(userTotp).where(eq(userTotp.userId, admin.id))).toEqual([]);
  });
});
