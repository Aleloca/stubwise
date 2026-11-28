import { randomBytes, randomUUID } from "node:crypto";
import { PRESET_ROLES } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  gitIdentities,
  notifications,
  passwordResetTokens,
  roles,
  sessions,
  userBackupCodes,
  userPasskeys,
  users,
  userTotp,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { listSecurityEvents } from "../auth/second-factor/security-events.js";
import { createUserWithPat, fullSessionCookie, seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let adminId: string;
let memberId: string;
// Ids degli utenti creati ad-hoc dai singoli test, ripuliti in afterEach.
const extraUserIds = new Set<string>();

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, adminId, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  // Riporta lo stato noto: adminId admin, memberId member; rimuove gli extra.
  await testDb.db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  await testDb.db.update(users).set({ role: "member" }).where(eq(users.id, memberId));
  // Azzera eventuali link git/bitbucket creati dai singoli test.
  await testDb.db.delete(gitIdentities);
  await testDb.db.update(users).set({ bitbucketUsername: null }).where(eq(users.id, memberId));
  for (const id of extraUserIds) {
    await testDb.db.delete(users).where(eq(users.id, id));
  }
  extraUserIds.clear();
});

describe("GET /api/users", () => {
  it("non autenticato → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });

  it("espone bitbucketUsername e gitIdentities per ogni utente", async () => {
    // memberId: 2 git identities + un bitbucketUsername; adminId: nessuno.
    await testDb.db.insert(gitIdentities).values([
      { userId: memberId, email: "bea@work.example", authorName: "Bea Work" },
      { userId: memberId, email: "bea@home.example", authorName: null },
    ]);
    await testDb.db
      .update(users)
      .set({ bitbucketUsername: "bea-bb" })
      .where(eq(users.id, memberId));

    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      bitbucketUsername: string | null;
      gitIdentities: { id: string; email: string; authorName: string | null }[];
    }[];

    const member = body.find((u) => u.id === memberId)!;
    expect(member.bitbucketUsername).toBe("bea-bb");
    expect(member.gitIdentities).toHaveLength(2);
    expect(new Set(member.gitIdentities.map((g) => g.email))).toEqual(
      new Set(["bea@work.example", "bea@home.example"]),
    );
    for (const identity of member.gitIdentities) {
      expect(typeof identity.id).toBe("string");
    }
    expect(member.gitIdentities.find((g) => g.email === "bea@home.example")!.authorName).toBeNull();

    const admin = body.find((u) => u.id === adminId)!;
    expect(admin.bitbucketUsername).toBeNull();
    expect(admin.gitIdentities).toEqual([]);
  });
});

/** Soggetti e frasi degli avvisi di sicurezza arrivati a `userId`. */
async function alertsOf(userId: string): Promise<{ subject: string; actorEmail: string | null }[]> {
  const rows = await testDb.db
    .select({ event: notifications.event })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, "security.alert")));
  return rows.map((r) => r.event as { subject: string; actorEmail: string | null });
}

/**
 * Un utente con tutto il secondo fattore (app, una passkey, i codici), una
 * sessione completa e un PAT: il bersaglio dei reset.
 */
async function targetWithSecondFactor() {
  const email = `target-${randomUUID()}@example.com`;
  const { id, headers } = await createUserWithPat(app, email);
  extraUserIds.add(id);
  const cookie = await fullSessionCookie(app, id);
  await regenerateBackupCodes(testDb.db, ENCRYPTION_KEY, id);
  await testDb.db.insert(userPasskeys).values({
    userId: id,
    credentialId: `cred-${randomUUID()}`,
    publicKey: "pk",
    name: "Portatile",
  });
  return { id, email, cookie, patHeaders: headers };
}

/**
 * Un utente con `users.manage` d'istanza (e una sessione fresca), più i
 * permessi del preset `User`: sta sopra un utente normale, sotto un full admin.
 */
async function usersManager(): Promise<{ id: string; cookie: string }> {
  const email = `manager-${randomUUID()}@example.com`;
  const { id } = await createUserWithPat(app, email);
  extraUserIds.add(id);
  const [role] = await testDb.db
    .insert(roles)
    // Il preset User di ADESSO più `users.manage`: chi sta sopra un User (un
    // ruolo fatto oggi contiene i permessi nuovi del preset; quelli di prima
    // li riceve dalla migrazione, `docs/invariants/permissions.md`).
    .values({ name: `Gestore ${email}`, scope: "instance", permissions: [
        "users.manage",
        ...PRESET_ROLES.find((r) => r.key === "user")!.permissions,
      ],
    })
    .returning({ id: roles.id });
  await testDb.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, id));
  return { id, cookie: await fullSessionCookie(app, id) };
}

async function secondFactorRows(userId: string) {
  const [totp, passkeys, codes, userSessions] = await Promise.all([
    testDb.db.select().from(userTotp).where(eq(userTotp.userId, userId)),
    testDb.db.select().from(userPasskeys).where(eq(userPasskeys.userId, userId)),
    testDb.db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, userId)),
    testDb.db.select().from(sessions).where(eq(sessions.userId, userId)),
  ]);
  return { totp, passkeys, codes, sessions: userSessions };
}

describe("DELETE /api/users/:id/second-factor", () => {
  it("azzera app, passkey, codici e sessioni del bersaglio; il suo PAT resta; evento con l'attore e avviso", async () => {
    const target = await targetWithSecondFactor();
    // Una sessione dell'admin, per vedere che non la si tocca.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${target.id}/second-factor`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode, res.body).toBe(204);

    expect(await secondFactorRows(target.id)).toEqual({
      totp: [],
      passkeys: [],
      codes: [],
      sessions: [],
    });
    const viaCookie = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: target.cookie },
    });
    expect(viaCookie.statusCode).toBe(401);
    const viaPat = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: target.patHeaders,
    });
    expect(viaPat.statusCode).toBe(200);
    // L'admin che ha agito resta dentro.
    const admin = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } });
    expect(admin.statusCode).toBe(200);

    const [event] = await listSecurityEvents(testDb.db, target.id);
    expect(event).toMatchObject({
      kind: "second_factor_reset",
      userEmail: target.email,
      actorUserId: adminId,
      actorEmail: "admin@example.com",
    });
    expect(await alertsOf(target.id)).toEqual([
      expect.objectContaining({ subject: "second_factor_reset", actorEmail: "admin@example.com" }),
    ]);
  });

  it("su sé stesso → 400, niente toccato (Review Focus 5)", async () => {
    const before = await secondFactorRows(adminId);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${adminId}/second-factor`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "cannot_reset_own_second_factor" });
    expect(await secondFactorRows(adminId)).toEqual(before);
  });

  it("area 9 (D-2): niente più bersaglio protetto, users.manage azzera anche un full admin → 204, e l'avviso arriva (il rischio accettato)", async () => {
    const manager = await usersManager();
    // Un SECONDO full admin, non quello del file: l'azzeramento chiude le sue sessioni.
    const target = await targetWithSecondFactor();
    const [adminRole] = await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    await testDb.db.update(users).set({ instanceRoleId: adminRole!.id }).where(eq(users.id, target.id));
    const before = await secondFactorRows(target.id);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${target.id}/second-factor`,
      headers: { cookie: manager.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await secondFactorRows(target.id)).not.toEqual(before);
    // La difesa è la traccia: l'interessato riceve `security.alert`.
    expect((await alertsOf(target.id)).length).toBeGreaterThan(0);
  });

  it("chi ha users.manage azzera chi non gli sta sopra → 204", async () => {
    const manager = await usersManager();
    const target = await targetWithSecondFactor();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/users/${target.id}/second-factor`,
      headers: { cookie: manager.cookie },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect((await secondFactorRows(target.id)).totp).toEqual([]);
  });

  it("senza users.manage → 403; utente inesistente → 404", async () => {
    const target = await targetWithSecondFactor();
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/users/${target.id}/second-factor`,
      headers: { cookie: memberCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect((await secondFactorRows(target.id)).totp).toHaveLength(1);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/users/${randomUUID()}/second-factor`,
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "user_not_found" });
  });
});

describe("GET /api/users/:id/security-events", () => {
  it("le righe del bersaglio, con chi ha agito; senza users.manage → 403", async () => {
    const target = await targetWithSecondFactor();
    await app.inject({
      method: "DELETE",
      url: `/api/users/${target.id}/second-factor`,
      headers: { cookie: adminCookie },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/users/${target.id}/security-events`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      events: [
        {
          id: expect.any(String),
          kind: "second_factor_reset",
          actorEmail: "admin@example.com",
          // Solo `reauth_desktop` lo valorizza (10 nov 2026, additivo).
          detail: null,
          createdAt: expect.any(String),
        },
      ],
    });

    const denied = await app.inject({
      method: "GET",
      url: `/api/users/${target.id}/security-events`,
      headers: { cookie: memberCookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("POST /api/users/:id/password-reset", () => {
  it("il link di reset scrive l'evento e l'avviso al bersaglio", async () => {
    const target = await targetWithSecondFactor();
    const res = await app.inject({
      method: "POST",
      url: `/api/users/${target.id}/password-reset`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(201);
    expect(
      await testDb.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, target.id)),
    ).toHaveLength(1);
    const [event] = await listSecurityEvents(testDb.db, target.id);
    expect(event).toMatchObject({
      kind: "password_reset_link",
      userEmail: target.email,
      actorUserId: adminId,
      actorEmail: "admin@example.com",
    });
    expect(await alertsOf(target.id)).toEqual([
      expect.objectContaining({ subject: "password_reset_link", actorEmail: "admin@example.com" }),
    ]);
  });

  it("area 9, F1: la risposta porta anche il `token`, lo stesso dell'url, e funziona sulla rotta di reset", async () => {
    const target = await targetWithSecondFactor();
    const res = await app.inject({ method: "POST", url: `/api/users/${target.id}/password-reset`, headers: { cookie: adminCookie } });
    const body = res.json() as { url: string; token: string };
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.url.endsWith(`/reset-password/${body.token}`)).toBe(true);
    const reset = await app.inject({ method: "POST", url: `/api/auth/password-reset/${body.token}`, payload: { password: "una-password-nuova-lunga" } });
    expect(reset.statusCode).toBe(204);
  });
});
