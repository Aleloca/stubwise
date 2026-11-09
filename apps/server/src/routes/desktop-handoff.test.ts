import { createHash, randomBytes } from "node:crypto";
import { desktopHandoffs, personalAccessTokens, securityEvents, sessions } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createPatForUser } from "./pat.js";
import { createUserWithSession, partialSessionCookie, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const b64url = (buf: Buffer) => buf.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const handoff = (headers: Record<string, string>, challenge: string, deviceName = "MacBook di Ale") =>
  app.inject({
    method: "POST",
    url: "/api/auth/desktop-handoff",
    headers,
    payload: { codeChallenge: challenge, deviceName },
  });

const exchange = (code: string, codeVerifier: string, deviceName = "MacBook di Ale") =>
  app.inject({
    method: "POST",
    url: "/api/auth/desktop-exchange",
    payload: { code, codeVerifier, deviceName },
  });

async function codeFor(challenge: string): Promise<string> {
  const res = await handoff({ cookie: users.memberCookie }, challenge);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { code: string }).code;
}

describe("POST /api/auth/desktop-handoff", () => {
  it("senza sessione completa 401", async () => {
    expect((await handoff({}, pkce().challenge)).statusCode).toBe(401);
  });

  it("una sessione parziale 401 second_factor_required", async () => {
    const cookie = await partialSessionCookie(app, users.memberId, "second_factor");
    const res = await handoff({ cookie }, pkce().challenge);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "second_factor_required" });
  });

  it("un PAT non può chiedere un codice", async () => {
    const pat = await createPatForUser(testDb.db, users.memberId, "script", null);
    const res = await handoff({ authorization: `Bearer ${pat.token}` }, pkce().challenge);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
  });

  it("sessione completa ma second_factor_at più vecchio di 10 minuti → reauth_required", async () => {
    const person = await createUserWithSession(app, "riconferma@example.com");
    await testDb.db
      .update(sessions)
      .set({ secondFactorAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(sessions.userId, person.id));
    const res = await handoff(person.headers, pkce().challenge);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "reauth_required" });
    expect(await testDb.db.select().from(desktopHandoffs).where(eq(desktopHandoffs.userId, person.id))).toHaveLength(0);
  });

  it("il codice si conserva solo come hash, vale 2 minuti", async () => {
    const { challenge } = pkce();
    const code = await codeFor(challenge);
    const rows = await testDb.db.select().from(desktopHandoffs).where(eq(desktopHandoffs.codeChallenge, challenge));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toContain(code);
    expect(rows[0]!.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
    const ttl = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(ttl).toBeGreaterThan(110_000);
    expect(ttl).toBeLessThanOrEqual(121_000);
  });

  it("un challenge fuori formato → 400", async () => {
    expect((await handoff({ cookie: users.memberCookie }, "corto")).statusCode).toBe(400);
  });
});

describe("POST /api/auth/desktop-exchange", () => {
  it("il token rilasciato ha kind desktop e si autentica; il login finisce nel registro", async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    const res = await exchange(code, verifier);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { token: string; patId: string; user: { id: string } };
    expect(body.user.id).toBe(users.memberId);
    const [pat] = await testDb.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, body.patId));
    expect(pat).toMatchObject({ kind: "desktop", name: "Desktop · MacBook di Ale", userId: users.memberId });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    const logins = await testDb.db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.userId, users.memberId), eq(securityEvents.kind, "login")));
    expect(logins.length).toBeGreaterThanOrEqual(1);
  });

  it("lo scambio riuscito cancella la riga, e pota quelle scadute da più di un giorno", async () => {
    const old = pkce();
    await codeFor(old.challenge);
    await testDb.db
      .update(desktopHandoffs)
      .set({ expiresAt: sql`now() - interval '2 days'` })
      .where(eq(desktopHandoffs.codeChallenge, old.challenge));
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    expect((await exchange(code, verifier)).statusCode).toBe(200);
    expect(await testDb.db.select().from(desktopHandoffs).where(eq(desktopHandoffs.codeChallenge, challenge))).toHaveLength(0);
    expect(await testDb.db.select().from(desktopHandoffs).where(eq(desktopHandoffs.codeChallenge, old.challenge))).toHaveLength(0);
  });

  it("codice scambiato due volte: la seconda 400", async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    expect((await exchange(code, verifier)).statusCode).toBe(200);
    const again = await exchange(code, verifier);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: "invalid_grant" });
  });

  it("codice scaduto 400", async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    await testDb.db
      .update(desktopHandoffs)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(desktopHandoffs.codeChallenge, challenge));
    const res = await exchange(code, verifier);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_grant" });
  });

  it("verifier sbagliato 400 e il codice non si riusa", async () => {
    const { verifier, challenge } = pkce();
    const code = await codeFor(challenge);
    const wrong = await exchange(code, pkce().verifier);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "invalid_grant" });
    expect((await exchange(code, verifier)).statusCode).toBe(400);
  });

  it("un codice inventato 400, senza dire se esiste", async () => {
    const res = await exchange(b64url(randomBytes(32)), pkce().verifier);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_grant" });
  });
});

describe("cambio e reset della password", () => {
  it("handoff emesso prima del reset: lo scambio dopo il reset fallisce", async () => {
    const person = await createUserWithSession(app, "reset-desktop@example.com");
    const { verifier, challenge } = pkce();
    const issued = await handoff(person.headers, challenge);
    expect(issued.statusCode).toBe(200);
    const code = (issued.json() as { code: string }).code;
    // Un admin genera il link di reset, la persona sceglie una password nuova.
    const link = await app.inject({
      method: "POST",
      url: `/api/users/${person.id}/password-reset`,
      headers: { cookie: users.adminCookie },
    });
    expect(link.statusCode).toBe(201);
    const token = (link.json() as { url: string }).url.split("/").pop()!;
    const reset = await app.inject({
      method: "POST",
      url: `/api/auth/password-reset/${token}`,
      payload: { password: "password-nuova-desktop" },
    });
    expect(reset.statusCode).toBe(204);
    const res = await exchange(code, verifier);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_grant" });
  });
});
