import { unsign } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { invites, sessions, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";

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

/**
 * Ricava l'id di sessione esatto verificando la firma del cookie: i test
 * possono così puntare la riga giusta in `sessions` senza euristiche.
 */
function sessionIdFromResponse(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === "stubwise_session");
  if (!cookie) throw new Error("cookie stubwise_session assente nella risposta");
  const unsigned = unsign(decodeURIComponent(cookie.value), SESSION_SECRET);
  if (!unsigned.valid || !unsigned.value) {
    throw new Error("firma del cookie stubwise_session non valida");
  }
  return unsigned.value;
}

async function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
}

describe("setup concorrente", () => {
  it("due POST /api/auth/setup concorrenti creano esattamente un admin (201 + 403)", async () => {
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { email: "race-a@example.com", password: "password-sicura" },
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { email: "race-b@example.com", password: "password-sicura" },
      }),
    ]);

    const rows = await testDb.db.select().from(users);
    // Pulizia prima delle assert: i test del flusso di primo setup qui sotto
    // ripartono da zero anche se questo test fallisce.
    await testDb.db.delete(users);

    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([201, 403]);
    expect(rows).toHaveLength(1);
  });
});

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
    const sessionId = sessionIdFromResponse(res);

    // Porta la scadenza nel passato direttamente sul DB, puntando la riga
    // esatta tramite l'id ricavato dal cookie firmato.
    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionId));

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);

    // La sessione scaduta è stata eliminata pigramente.
    const after = await testDb.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(after).toHaveLength(0);
  });

  it("il login elimina le sessioni scadute dell'utente", async () => {
    const first = await login("admin@example.com", "password-sicura");
    expect(first.statusCode).toBe(200);
    const firstId = sessionIdFromResponse(first);

    const second = await login("admin@example.com", "password-sicura");
    expect(second.statusCode).toBe(200);

    // Fa scadere manualmente la prima sessione: resta nel DB perché il suo
    // cookie non viene più ripresentato (la pulizia pigra non scatta).
    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, firstId));

    const third = await login("admin@example.com", "password-sicura");
    expect(third.statusCode).toBe(200);

    // Il terzo login ha spazzato via la riga scaduta.
    const leftover = await testDb.db.select().from(sessions).where(eq(sessions.id, firstId));
    expect(leftover).toHaveLength(0);
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

  it("POST /api/auth/logout senza cookie risponde comunque 204 e pulisce il cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "stubwise_session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
  });

  it("POST /api/auth/logout con cookie non valido risponde comunque 204", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: "stubwise_session=falso.firma-non-valida" },
    });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "stubwise_session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
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

describe("register concorrente", () => {
  /** Crea un invito via API (come admin) e restituisce il token. */
  async function createInvite(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: adminCookie },
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { token: string }).token;
  }

  function register(token: string, email: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email, password: "password-member" },
    });
  }

  it("due register concorrenti con lo stesso token: esattamente un 201 e un 410", async () => {
    const token = await createInvite("conteso@example.com");

    const [a, b] = await Promise.all([
      register(token, "conteso-uno@example.com"),
      register(token, "conteso-due@example.com"),
    ]);

    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([201, 410]);

    // Un solo account creato: l'invito è stato consumato esattamente una volta.
    const created = await testDb.db
      .select()
      .from(users)
      .where(inArray(users.email, ["conteso-uno@example.com", "conteso-due@example.com"]));
    expect(created).toHaveLength(1);
  });

  it("due register concorrenti con la stessa email e token diversi: un 201 e un 409", async () => {
    const [tokenA, tokenB] = await Promise.all([
      createInvite("duplicato@example.com"),
      createInvite("duplicato@example.com"),
    ]);

    const [a, b] = await Promise.all([
      register(tokenA, "duplicato@example.com"),
      register(tokenB, "duplicato@example.com"),
    ]);

    // Il pre-check sull'email non è atomico: il perdente deve comunque
    // ricevere 409 dal vincolo unique, non un 500.
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([201, 409]);
  });
});
