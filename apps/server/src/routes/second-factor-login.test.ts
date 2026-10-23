import { unsign } from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { listSecurityEvents } from "../auth/second-factor/security-events.js";
import { confirmTotp, startTotpEnrollment } from "../auth/second-factor/totp.js";
import { PARTIAL_SESSION_TTL_MS, SESSION_TTL_MS } from "../auth/session.js";
import { listInbox } from "../services/inbox.js";
import { fullSessionCookie, sessionCookie } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PASSWORD = "password-sicura";

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `sf-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" })
    .returning({ id: users.id });
  return { id: row!.id, email };
}

/**
 * Utente con l'app già configurata. La conferma è nel passato: il passo
 * corrente resta libero per il codice del login (anti-replay).
 */
async function createUserWithTotp() {
  const user = await createUser();
  const { secret } = await startTotpEnrollment(testDb.db, ENCRYPTION_KEY, user);
  const past = Date.now() - 5 * 60_000;
  const confirmed = await confirmTotp(
    testDb.db,
    ENCRYPTION_KEY,
    user.id,
    generateSync({ secret, epoch: Math.floor(past / 1000) }),
    past,
  );
  if (!confirmed) throw new Error("conferma TOTP di preparazione fallita");
  const backupCodes = await regenerateBackupCodes(testDb.db, user.id);
  return { ...user, secret, backupCodes };
}

async function login(email: string, remoteAddress?: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

function sessionIdOf(cookie: string): string {
  const raw = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const unsigned = unsign(raw, SESSION_SECRET);
  if (!unsigned.valid || !unsigned.value) throw new Error("cookie non firmato");
  return unsigned.value;
}

function maxAgeOf(res: { cookies: { name: string; maxAge?: number }[] }): number | undefined {
  return res.cookies.find((c) => c.name === "stubwise_session")?.maxAge;
}

async function me(cookie: string) {
  return app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
}

async function post(url: string, cookie: string, payload?: object, remoteAddress?: string) {
  return app.inject({
    method: "POST",
    url: `/api/auth/second-factor${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

describe("POST /api/auth/login: la password apre solo una sessione parziale", () => {
  it("password giusta: nessuna sessione completa, /me è 401 second_factor_required", async () => {
    const user = await createUserWithTotp();
    const res = await login(user.email);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: user.id, email: user.email, role: "member" },
      stage: "second_factor",
    });
    // Il cookie vive quanto la sessione parziale, non 30 giorni.
    expect(maxAgeOf(res)).toBe(PARTIAL_SESSION_TTL_MS / 1000);
    const cookie = sessionCookie(res);
    const [row] = await testDb.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionIdOf(cookie)));
    expect(row).toMatchObject({ stage: "second_factor", secondFactorAt: null });

    const meRes = await me(cookie);
    expect(meRes.statusCode).toBe(401);
    expect(meRes.json()).toMatchObject({ code: "second_factor_required" });
  });

  it("password sbagliata: la 401 di sempre, nessun cookie", async () => {
    const user = await createUserWithTotp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "password-sbagliata" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: "invalid_credentials", message: "Invalid credentials" });
    expect(res.cookies.find((c) => c.name === "stubwise_session")).toBeUndefined();
  });
});

describe("utente senza secondo fattore: configurazione obbligatoria", () => {
  it("stage enrollment, /verify è 409, /enroll + /enroll/confirm danno 10 codici e una sessione completa", async () => {
    const user = await createUser();
    const res = await login(user.email);
    expect(res.json()).toMatchObject({ stage: "enrollment" });
    const cookie = sessionCookie(res);
    const sessionId = sessionIdOf(cookie);

    const status = await app.inject({
      method: "GET",
      url: "/api/auth/second-factor",
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      stage: "enrollment",
      passkeys: false,
      backupCodesRemaining: 0,
      lockedUntil: null,
    });

    const verify = await post("/verify", cookie, { code: "123456" });
    expect(verify.statusCode).toBe(409);
    expect(verify.json()).toMatchObject({ code: "second_factor_stage_mismatch" });

    const enroll = await post("/enroll", cookie);
    expect(enroll.statusCode).toBe(200);
    const { secret, otpauthUrl } = enroll.json() as { secret: string; otpauthUrl: string };
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUrl).toContain(`secret=${secret}`);

    // Un codice sbagliato non apre niente e conta per il tetto.
    const wrong = await post("/enroll/confirm", cookie, { code: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "invalid_second_factor" });
    const [afterWrong] = await testDb.db
      .select({ failures: users.secondFactorFailures })
      .from(users)
      .where(eq(users.id, user.id));
    expect(afterWrong?.failures).toBe(1);

    const confirm = await post("/enroll/confirm", cookie, { code: generateSync({ secret }) });
    expect(confirm.statusCode).toBe(200);
    const body = confirm.json() as { user: { id: string }; backupCodes: string[] };
    expect(body.user.id).toBe(user.id);
    expect(body.backupCodes).toHaveLength(10);
    expect(new Set(body.backupCodes).size).toBe(10);
    // Cookie rinnovato con la durata piena, sulla STESSA sessione.
    expect(maxAgeOf(confirm)).toBe(SESSION_TTL_MS / 1000);
    expect(sessionIdOf(sessionCookie(confirm))).toBe(sessionId);

    const rows = await testDb.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: sessionId, stage: "full" });
    expect(rows[0]!.secondFactorAt).toBeInstanceOf(Date);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);

    expect((await me(cookie)).statusCode).toBe(200);
    const [afterOk] = await testDb.db
      .select({ failures: users.secondFactorFailures })
      .from(users)
      .where(eq(users.id, user.id));
    expect(afterOk?.failures).toBe(0);
    const events = await listSecurityEvents(testDb.db, user.id);
    expect(events.map((e) => e.kind)).toContain("enrolled");
  });

  it("chi ha l'app configurata non riconfigura dal login: /enroll è 409", async () => {
    const user = await createUserWithTotp();
    const cookie = sessionCookie(await login(user.email));
    const res = await post("/enroll", cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "second_factor_stage_mismatch" });
  });
});

describe("utente con l'app configurata", () => {
  it("codice giusto: sessione completa, /me 200, evento login", async () => {
    const user = await createUserWithTotp();
    const cookie = sessionCookie(await login(user.email));

    const status = await app.inject({
      method: "GET",
      url: "/api/auth/second-factor",
      headers: { cookie },
    });
    expect(status.json()).toEqual({
      stage: "second_factor",
      passkeys: false,
      backupCodesRemaining: 10,
      lockedUntil: null,
    });

    const res = await post("/verify", cookie, { code: generateSync({ secret: user.secret }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: user.id, email: user.email, role: "member" },
      backupCodesRemaining: 10,
    });
    expect(maxAgeOf(res)).toBe(SESSION_TTL_MS / 1000);
    expect((await me(cookie)).statusCode).toBe(200);
    const events = await listSecurityEvents(testDb.db, user.id);
    expect(events.map((e) => e.kind)).toEqual(["login"]);

    // Lo stesso passo non vale due volte: un secondo login con lo stesso
    // codice è rifiutato (anti-replay).
    const again = sessionCookie(await login(user.email));
    const replay = await post("/verify", again, { code: generateSync({ secret: user.secret }) });
    expect(replay.statusCode).toBe(401);
  });

  it("codice di riserva: 200 e backupCodesRemaining 9", async () => {
    const user = await createUserWithTotp();
    const cookie = sessionCookie(await login(user.email));
    const res = await post("/verify", cookie, { code: user.backupCodes[0] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ backupCodesRemaining: 9 });
    expect((await me(cookie)).statusCode).toBe(200);
    const kinds = (await listSecurityEvents(testDb.db, user.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["backup_code_used", "login"]));
  });

  it("codice sbagliato: 401 invalid_second_factor, la sessione resta parziale", async () => {
    const user = await createUserWithTotp();
    const cookie = sessionCookie(await login(user.email));
    const res = await post("/verify", cookie, { code: "non-un-codice" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_second_factor" });
    expect((await me(cookie)).json()).toMatchObject({ code: "second_factor_required" });
  });
});

describe("tetto per account (Review Focus 4)", () => {
  it("5 codici sbagliati da IP diversi → 423, e una sessione completa aperta PRIMA resta valida", async () => {
    const user = await createUserWithTotp();
    const before = await fullSessionCookie(app, user.id);

    // Ogni tentativo da un IP diverso, con una sessione parziale nuova: il
    // tetto è dell'ACCOUNT, non dell'IP né della sessione.
    for (let i = 1; i <= 4; i++) {
      const ip = `10.0.0.${i}`;
      const cookie = sessionCookie(await login(user.email, ip));
      const res = await post("/verify", cookie, { code: "000000" }, ip);
      expect(res.statusCode, `tentativo ${i}`).toBe(401);
    }
    const lastCookie = sessionCookie(await login(user.email, "10.0.0.5"));
    const fifth = await post("/verify", lastCookie, { code: "000000" }, "10.0.0.5");
    expect(fifth.statusCode).toBe(423);
    const fifthBody = fifth.json() as { code: string; lockedUntil: string };
    expect(fifthBody.code).toBe("second_factor_locked");
    expect(new Date(fifthBody.lockedUntil).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    // Anche il codice giusto, da un altro IP ancora, non passa finché dura.
    const cookie = sessionCookie(await login(user.email, "10.0.0.6"));
    const right = await post(
      "/verify",
      cookie,
      { code: generateSync({ secret: user.secret }) },
      "10.0.0.6",
    );
    expect(right.statusCode).toBe(423);
    expect(right.json()).toMatchObject({ code: "second_factor_locked" });
    const status = await app.inject({
      method: "GET",
      url: "/api/auth/second-factor",
      headers: { cookie },
    });
    expect((status.json() as { lockedUntil: string | null }).lockedUntil).not.toBeNull();

    // Il blocco tocca solo i login nuovi.
    expect((await me(before)).statusCode).toBe(200);

    const kinds = (await listSecurityEvents(testDb.db, user.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "locked")).toHaveLength(1);
    const inbox = await listInbox(testDb.db, { userId: user.id, lang: "it" });
    expect(inbox.items.filter((i) => i.kind === "security.alert")).toHaveLength(1);
  });
});
