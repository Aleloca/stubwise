import { unsign } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { deviceTokens, passwordResetTokens, personalAccessTokens, sessions, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { hashPassword } from "../auth/password.js";
import { randomBytes } from "node:crypto";
import { generateSync } from "otplib";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { confirmTotp, startTotpEnrollment } from "../auth/second-factor/totp.js";
import { fullSessionCookie } from "../test/fixtures.js";
import { createPatForUser } from "./pat.js";
import { hashServerKey } from "./shared.js";

/**
 * Reset della password da parte dell'admin (link monouso) e cambio della
 * password dal profilo (21 ott 2026).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const PUBLIC_URL = "https://stubwise.example.com";
const OLD_PASSWORD = "password-vecchia";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: PUBLIC_URL,
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function sessionIdOf(cookie: string): string {
  const raw = decodeURIComponent(cookie.slice("stubwise_session=".length));
  const unsigned = unsign(raw, SESSION_SECRET);
  if (!unsigned.valid || !unsigned.value) throw new Error("cookie non valido");
  return unsigned.value;
}

async function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
}

async function createUser(role: "admin" | "member", password = OLD_PASSWORD) {
  const email = `${role}-${crypto.randomUUID()}@example.com`;
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(password), role })
    .returning({ id: users.id });
  return { id: row!.id, email };
}

/** Admin con la sua sessione, rifatto per ogni test: stato isolato. */
let admin: { id: string; email: string; cookie: string };

beforeEach(async () => {
  const created = await createUser("admin");
  admin = { ...created, cookie: await fullSessionCookie(app, created.id) };
});

/**
 * /mobile-login chiede il secondo fattore: all'utente si dà l'app configurata
 * (alla prima chiamata) e ogni login spende un codice di riserva, monouso.
 */
const backupCodesByEmail = new Map<string, string[]>();
async function nextCodeFor(email: string): Promise<string> {
  let codes = backupCodesByEmail.get(email);
  if (!codes) {
    const [user] = await testDb.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email));
    const { secret } = await startTotpEnrollment(testDb.db, ENCRYPTION_KEY, user!);
    const past = Date.now() - 5 * 60_000;
    await confirmTotp(
      testDb.db,
      ENCRYPTION_KEY,
      user!.id,
      generateSync({ secret, epoch: Math.floor(past / 1000) }),
      past,
    );
    codes = await regenerateBackupCodes(testDb.db, ENCRYPTION_KEY, user!.id);
    backupCodesByEmail.set(email, codes);
  }
  return codes.shift()!;
}

/** Login dell'app come lo fa l'app: PAT `mobile` emesso da /mobile-login. */
async function mobileLogin(email: string, password = OLD_PASSWORD) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/mobile-login",
    payload: { email, password, deviceName: "iPhone", code: await nextCodeFor(email) },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; patId: string };
}

async function meWithPat(token: string) {
  return app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function issueReset(userId: string, cookie = admin.cookie) {
  return app.inject({
    method: "POST",
    url: `/api/users/${userId}/password-reset`,
    headers: { cookie },
  });
}

/** Emette un reset e ne estrae il token dall'URL restituito. */
async function issueToken(userId: string): Promise<string> {
  const res = await issueReset(userId);
  expect(res.statusCode).toBe(201);
  const url = (res.json() as { url: string }).url;
  return url.slice(url.lastIndexOf("/") + 1);
}

describe("POST /api/users/:id/password-reset (admin)", () => {
  it("l'admin crea un link: URL pubblico + scadenza a 24 ore, nel DB solo l'hash", async () => {
    const member = await createUser("member");
    const before = Date.now();
    const res = await issueReset(member.id);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { url: string; expiresAt: string };
    expect(body.url).toMatch(new RegExp(`^${PUBLIC_URL}/reset-password/[A-Za-z0-9_-]{43}$`));
    const expiresIn = new Date(body.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(24 * 60 * 60 * 1000 - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);

    const token = body.url.slice(body.url.lastIndexOf("/") + 1);
    const rows = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, member.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashServerKey(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.createdByUserId).toBe(admin.id);
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("un member riceve 403 e nessun link nasce", async () => {
    const member = await createUser("member");
    const target = await createUser("member");
    const memberCookie = await fullSessionCookie(app, member.id);
    const res = await issueReset(target.id, memberCookie);
    expect(res.statusCode).toBe(403);
    const rows = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, target.id));
    expect(rows).toHaveLength(0);
  });

  it("un admin con un PAT (manuale o dell'app) → 403 session_required e nessun link", async () => {
    const target = await createUser("member");
    const manual = await createPatForUser(testDb.db, admin.id, "mcp", null);
    const phone = await mobileLogin(admin.email);
    for (const token of [manual.token, phone.token]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/users/${target.id}/password-reset`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "session_required" });
    }
    const rows = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, target.id));
    expect(rows).toHaveLength(0);
  });

  it("senza sessione → 401", async () => {
    const member = await createUser("member");
    const res = await app.inject({ method: "POST", url: `/api/users/${member.id}/password-reset` });
    expect(res.statusCode).toBe(401);
  });

  it("utente inesistente → 404", async () => {
    const res = await issueReset(crypto.randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it("l'admin non reimposta la PROPRIA password con un link (400): per sé c'è il cambio", async () => {
    const res = await issueReset(admin.id);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "cannot_reset_own_password" });
  });

  it("un secondo reset annulla il primo link non usato", async () => {
    const member = await createUser("member");
    const first = await issueToken(member.id);
    const second = await issueToken(member.id);

    const oldGet = await app.inject({ method: "GET", url: `/api/auth/password-reset/${first}` });
    expect(oldGet.statusCode).toBe(410);
    const newGet = await app.inject({ method: "GET", url: `/api/auth/password-reset/${second}` });
    expect(newGet.statusCode).toBe(200);
  });
});

describe("GET/POST /api/auth/password-reset/:token (pubbliche)", () => {
  it("GET con token valido dice per quale account è il link", async () => {
    const member = await createUser("member");
    const token = await issueToken(member.id);
    const res = await app.inject({ method: "GET", url: `/api/auth/password-reset/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: member.email, expiresAt: expect.any(String) });
  });

  it("token inesistente, scaduto e usato danno la STESSA risposta (niente oracolo)", async () => {
    const member = await createUser("member");

    const expired = await issueToken(member.id);
    await testDb.db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.tokenHash, hashServerKey(expired)));

    const other = await createUser("member");
    const used = await issueToken(other.id);
    const consume = await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${used}`,
      payload: { password: "password-nuova-1" },
    });
    expect(consume.statusCode).toBe(204);

    const bodies: unknown[] = [];
    for (const token of ["non-esiste-affatto", expired, used]) {
      const get = await app.inject({ method: "GET", url: `/api/auth/password-reset/${token}` });
      const post = await app.inject({
        method: "POST",
        url: `/api/auth/password-reset/${token}`,
        payload: { password: "password-nuova-2" },
      });
      expect(get.statusCode).toBe(410);
      expect(post.statusCode).toBe(410);
      bodies.push(get.json(), post.json());
    }
    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }
    expect(bodies[0]).toMatchObject({ code: "password_reset_invalid" });
  });

  it("password troppo corta → 400 e il link resta valido", async () => {
    const member = await createUser("member");
    const token = await issueToken(member.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "corta" },
    });
    expect(res.statusCode).toBe(400);
    const get = await app.inject({ method: "GET", url: `/api/auth/password-reset/${token}` });
    expect(get.statusCode).toBe(200);
  });

  it("il reset cambia la password, chiude le sessioni dell'utente e lascia vivo il PAT manuale", async () => {
    const member = await createUser("member");
    const memberCookie = await fullSessionCookie(app, member.id);
    const otherSession = await fullSessionCookie(app, member.id);
    // Un PAT manuale con un nome «da app»: conta il kind, non il nome.
    const pat = await createPatForUser(testDb.db, member.id, "Mobile · iPhone", null);
    const token = await issueToken(member.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "password-nuova-1" },
    });
    expect(res.statusCode).toBe(204);
    // Il reset non è un login: nessun cookie, e nessuna sessione dell'utente
    // (quelle di prima sono chiuse, una nuova non nasce).
    expect(res.cookies.find((c) => c.name === "stubwise_session")).toBeUndefined();
    expect(
      await testDb.db.select().from(sessions).where(eq(sessions.userId, member.id)),
    ).toEqual([]);

    // Il link è consumato: used_at valorizzato.
    const [row] = await testDb.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashServerKey(token)));
    expect(row!.usedAt).not.toBeNull();

    // Login: la nuova funziona, la vecchia no.
    expect((await login(member.email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(member.email, "password-nuova-1")).statusCode).toBe(200);

    // Le sessioni aperte prima del reset sono chiuse.
    for (const cookie of [memberCookie, otherSession]) {
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.statusCode).toBe(401);
      const rows = await testDb.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionIdOf(cookie)));
      expect(rows).toHaveLength(0);
    }

    // Il PAT manuale non si tocca.
    const viaPat = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${pat.token}` },
    });
    expect(viaPat.statusCode).toBe(200);
  });

  it("il reset revoca i token dell'app mobile (e spegne i loro device), non quelli manuali", async () => {
    const member = await createUser("member");
    const mobile = await mobileLogin(member.email);
    const manual = await createPatForUser(testDb.db, member.id, "Claude Code", null);
    await testDb.db.insert(deviceTokens).values({
      userId: member.id,
      platform: "ios",
      token: `apns-${crypto.randomUUID()}`,
      patId: mobile.patId,
    });
    const token = await issueToken(member.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "password-nuova-1" },
    });
    expect(res.statusCode).toBe(204);

    expect((await meWithPat(mobile.token)).statusCode).toBe(401);
    const left = await testDb.db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, member.id));
    expect(left.map((r) => r.id)).toEqual([manual.id]);
    expect((await meWithPat(manual.token)).statusCode).toBe(200);

    const devices = await testDb.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, member.id));
    expect(devices).toHaveLength(1);
    expect(devices[0]!.disabledAt).not.toBeNull();
    expect(devices[0]!.disabledReason).toBe("pat_revoked");

    // L'app rientra con la password nuova.
    const relogin = await app.inject({
      method: "POST",
      url: "/api/auth/mobile-login",
      payload: {
        email: member.email,
        password: "password-nuova-1",
        deviceName: "iPhone",
        code: await nextCodeFor(member.email),
      },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it("il reset non tocca i token mobile di ALTRI utenti", async () => {
    const member = await createUser("member");
    const other = await createUser("member");
    const otherMobile = await mobileLogin(other.email);
    const token = await issueToken(member.id);
    await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "password-nuova-1" },
    });
    expect((await meWithPat(otherMobile.token)).statusCode).toBe(200);
  });

  it("le sessioni di ALTRI utenti restano aperte", async () => {
    const member = await createUser("member");
    const token = await issueToken(member.id);
    await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "password-nuova-1" },
    });
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: admin.cookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it("due POST concorrenti sullo stesso link: uno solo riesce", async () => {
    const member = await createUser("member");
    const token = await issueToken(member.id);
    const [a, b] = await Promise.all(
      ["password-nuova-a", "password-nuova-b"].map((password) =>
        app.inject({
          method: "POST",
          url: `/api/auth/password-reset/${token}`,
          payload: { password },
        }),
      ),
    );
    expect([a!.statusCode, b!.statusCode].sort((x, y) => x - y)).toEqual([204, 410]);
  });
});

describe("POST /api/auth/me/password (cambio dal profilo)", () => {
  async function changePassword(
    headers: Record<string, string>,
    payload: { currentPassword: string; newPassword: string },
  ) {
    return app.inject({ method: "POST", url: "/api/auth/me/password", headers, payload });
  }

  it("password attuale sbagliata → 400 e la password non cambia", async () => {
    const member = await createUser("member");
    const cookie = await fullSessionCookie(app, member.id);
    const res = await changePassword(
      { cookie },
      { currentPassword: "non-e-questa", newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_current_password" });
    expect((await login(member.email, OLD_PASSWORD)).statusCode).toBe(200);
  });

  it("con un PAT → 403: un token personale non cambia la password", async () => {
    const member = await createUser("member");
    const pat = await createPatForUser(testDb.db, member.id, "mcp", null);
    const res = await changePassword(
      { authorization: `Bearer ${pat.token}` },
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
    expect((await login(member.email, OLD_PASSWORD)).statusCode).toBe(200);
  });

  it("senza sessione → 401", async () => {
    const res = await changePassword(
      {},
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(401);
  });

  it("nuova password troppo corta → 400", async () => {
    const member = await createUser("member");
    const cookie = await fullSessionCookie(app, member.id);
    const res = await changePassword({ cookie }, { currentPassword: OLD_PASSWORD, newPassword: "corta" });
    expect(res.statusCode).toBe(400);
    expect((await login(member.email, OLD_PASSWORD)).statusCode).toBe(200);
  });

  it("ok → 204: la nuova password vale, le ALTRE sessioni sono chiuse, la corrente no", async () => {
    const member = await createUser("member");
    const current = await fullSessionCookie(app, member.id);
    const other = await fullSessionCookie(app, member.id);
    const pat = await createPatForUser(testDb.db, member.id, "mcp", null);

    const res = await changePassword(
      { cookie: current },
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(204);

    expect((await login(member.email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(member.email, "password-nuova-1")).statusCode).toBe(200);

    const meCurrent = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: current } });
    expect(meCurrent.statusCode).toBe(200);
    const meOther = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: other } });
    expect(meOther.statusCode).toBe(401);

    const viaPat = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${pat.token}` },
    });
    expect(viaPat.statusCode).toBe(200);
  });

  it("ok → i token dell'app mobile sono revocati, quelli manuali no", async () => {
    const member = await createUser("member");
    const cookie = await fullSessionCookie(app, member.id);
    const phone = await mobileLogin(member.email);
    const tablet = await mobileLogin(member.email);
    const manual = await createPatForUser(testDb.db, member.id, "mcp", null);

    const res = await changePassword(
      { cookie },
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(204);

    expect((await meWithPat(phone.token)).statusCode).toBe(401);
    expect((await meWithPat(tablet.token)).statusCode).toBe(401);
    expect((await meWithPat(manual.token)).statusCode).toBe(200);
  });

  it("con un token MOBILE → 403 e il token resta valido (il cambio è solo dal browser)", async () => {
    const member = await createUser("member");
    const phone = await mobileLogin(member.email);
    const res = await changePassword(
      { authorization: `Bearer ${phone.token}` },
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(403);
    expect((await meWithPat(phone.token)).statusCode).toBe(200);
  });

  it("cambiare la password annulla un link di reset ancora aperto", async () => {
    const member = await createUser("member");
    const token = await issueToken(member.id);
    const cookie = await fullSessionCookie(app, member.id);
    const res = await changePassword(
      { cookie },
      { currentPassword: OLD_PASSWORD, newPassword: "password-nuova-1" },
    );
    expect(res.statusCode).toBe(204);
    const get = await app.inject({ method: "GET", url: `/api/auth/password-reset/${token}` });
    expect(get.statusCode).toBe(410);
  });
});
