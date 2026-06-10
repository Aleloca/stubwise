import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { invites, sessions } from "../db/schema.js";
import type { TestDb } from "../test/db.js";
import { startTestDb } from "../test/db.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

// Un container Postgres per file di test. I test di questo file sono
// deliberatamente sequenziali: il flusso setup → login → inviti → register
// rispecchia il ciclo di vita reale dell'autenticazione su un'istanza nuova.
let testDb: TestDb;
let app: FastifyInstance;

/** Cookie di sessione dell'admin creato dal setup, riusato nei test successivi. */
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Estrae il valore del cookie di sessione da una risposta di inject. */
function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === "stubwise_session");
  if (!cookie) throw new Error("cookie stubwise_session assente nella risposta");
  return `stubwise_session=${cookie.value}`;
}

async function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
}

describe("setup primo avvio", () => {
  it("GET /api/auth/setup segnala che il setup è necessario senza utenti", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needed: true });
  });

  it("POST /api/auth/setup crea l'admin quando non ci sono utenti", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { email: "admin@example.com", password: "password-sicura" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: "admin@example.com", role: "admin" },
    });
  });

  it("POST /api/auth/setup risponde 403 se esiste già un utente", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { email: "altro@example.com", password: "password-sicura" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/auth/setup segnala che il setup non serve più", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needed: false });
  });
});

describe("login e sessioni", () => {
  it("login con credenziali corrette setta un cookie di sessione httpOnly", async () => {
    const res = await login("admin@example.com", "password-sicura");
    expect(res.statusCode).toBe(200);

    const cookie = res.cookies.find((c) => c.name === "stubwise_session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");

    adminCookie = sessionCookie(res);
  });

  it("GET /api/auth/me con il cookie risponde con l'utente (senza passwordHash)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: Record<string, unknown> };
    expect(body.user).toEqual({
      id: expect.any(String),
      email: "admin@example.com",
      role: "admin",
    });
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  it("login con password errata risponde 401", async () => {
    const res = await login("admin@example.com", "password-sbagliata");
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "stubwise_session")).toBeUndefined();
  });

  it("GET /api/auth/me senza cookie risponde 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/auth/me con cookie non firmato correttamente risponde 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "stubwise_session=falso.firma-non-valida" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("una sessione scaduta viene rifiutata ed eliminata", async () => {
    const res = await login("admin@example.com", "password-sicura");
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res);

    // Porta la scadenza nel passato direttamente sul DB.
    const rows = await testDb.db.select().from(sessions);
    expect(rows.length).toBeGreaterThan(0);
    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.expiresAt, rows[rows.length - 1]!.expiresAt));

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);

    // La sessione scaduta è stata eliminata pigramente.
    const after = await testDb.db.select().from(sessions);
    expect(after.some((s) => s.expiresAt.getTime() < Date.now())).toBe(false);
  });

  it("POST /api/auth/logout elimina la sessione e pulisce il cookie", async () => {
    const res = await login("admin@example.com", "password-sicura");
    const cookie = sessionCookie(res);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = logout.cookies.find((c) => c.name === "stubwise_session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("inviti e registrazione", () => {
  let inviteToken: string;
  let memberCookie: string;

  it("l'admin crea un invito con token e scadenza", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: adminCookie },
      payload: { email: "member@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; expiresAt: string };
    expect(body.token).toEqual(expect.any(String));
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    inviteToken = body.token;
  });

  it("la creazione di inviti senza sessione risponde 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      payload: { email: "x@example.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("register con token valido crea un member", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: inviteToken,
        email: "member@example.com",
        password: "password-member",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      user: { id: expect.any(String), email: "member@example.com", role: "member" },
    });

    const loginRes = await login("member@example.com", "password-member");
    expect(loginRes.statusCode).toBe(200);
    memberCookie = sessionCookie(loginRes);
  });

  it("un token riusato risponde 410", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: inviteToken,
        email: "altro-member@example.com",
        password: "password-member",
      },
    });
    expect(res.statusCode).toBe(410);
  });

  it("un invito scaduto risponde 410", async () => {
    await testDb.db.insert(invites).values({
      token: "invito-scaduto-token",
      email: "tardi@example.com",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        token: "invito-scaduto-token",
        email: "tardi@example.com",
        password: "password-member",
      },
    });
    expect(res.statusCode).toBe(410);
  });

  it("requireAdmin blocca un member sulla creazione di inviti", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: memberCookie },
      payload: { email: "y@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });
});
