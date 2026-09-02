import { unsign } from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import {
  encrypt,
  instanceSettings,
  invites,
  personalAccessTokens,
  sessions,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SlackClient } from "../slack/api.js";
import type { SlackClientFactory } from "../slack/creds.js";

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
      language: "en",
      avatarUrl: null,
      slackUserId: null,
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

// L'app mobile non ha cookie: scambia email+password con un PAT dedicato al
// device, che poi manda nell'header. Il nome del token ("Mobile · <device>")
// è ciò che rende la revoca dal web — e quindi il logout remoto — possibile.
describe("mobile-login", () => {
  async function mobileLogin(payload: Record<string, string>, target: FastifyInstance = app) {
    return target.inject({ method: "POST", url: "/api/auth/mobile-login", payload });
  }

  it("emette un PAT 'Mobile · <device>' e risponde token+user", async () => {
    const res = await mobileLogin({
      email: "admin@example.com",
      password: "password-sicura",
      deviceName: "iPhone di Ada",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: Record<string, unknown> };
    expect(body.token).toMatch(/^stw_pat_/);
    expect(body.user).toEqual({
      id: expect.any(String),
      email: "admin@example.com",
      role: "admin",
      language: "en",
      avatarUrl: null,
      slackUserId: null,
    });
    // Nessuna sessione a cookie: il mobile non ne ha bisogno e non deve
    // ritrovarsi una riga in `sessions` che nessuno chiuderà mai.
    expect(res.cookies.find((c) => c.name === "stubwise_session")).toBeUndefined();

    // Il token funziona davvero come credenziale, e il PAT è visibile (e
    // quindi revocabile) dalla lista dell'utente.
    const pats = await app.inject({
      method: "GET",
      url: "/api/pats",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(pats.statusCode).toBe(200);
    const list = pats.json() as { name: string; expiresAt: string | null }[];
    const created = list.find((p) => p.name === "Mobile · iPhone di Ada");
    expect(created).toBeDefined();
    // Senza scadenza: l'app resta loggata finché non si fa logout (che revoca).
    expect(created?.expiresAt).toBeNull();
  });

  it("con password errata → 401 e nessun PAT creato", async () => {
    const before = await testDb.db.select().from(personalAccessTokens);
    const res = await mobileLogin({
      email: "admin@example.com",
      password: "password-sbagliata",
      deviceName: "iPhone di Ada",
    });
    expect(res.statusCode).toBe(401);
    const after = await testDb.db.select().from(personalAccessTokens);
    expect(after.length).toBe(before.length);
  });

  it("password errata ed email inesistente danno risposte indistinguibili", async () => {
    const wrongPassword = await mobileLogin({
      email: "admin@example.com",
      password: "password-sbagliata",
      deviceName: "iPhone di Ada",
    });
    const unknownEmail = await mobileLogin({
      email: "nessuno-qui@example.com",
      password: "password-sicura",
      deviceName: "iPhone di Ada",
    });
    // Stesso status e stesso corpo: dal fuori non si distingue un account
    // inesistente da una password sbagliata, quindi la rotta non enumera.
    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(users.email, "nessuno-qui@example.com"));
    expect(rows).toEqual([]);
  });

  it("rifiuta un deviceName vuoto, troppo lungo o con caratteri di controllo", async () => {
    const base = { email: "admin@example.com", password: "password-sicura" };
    for (const deviceName of ["", "   ", "x".repeat(81), "iPhone\nAdmin", "iPhone‮off"]) {
      const res = await mobileLogin({ ...base, deviceName });
      expect(res.statusCode, `deviceName ${JSON.stringify(deviceName)}`).toBe(400);
    }
    const rows = await testDb.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.name, "Mobile · "));
    expect(rows).toEqual([]);
  });

  it("è rate-limited come /login", async () => {
    // App a parte: il bucket del rate limit è per rotta e per IP, e saturarlo
    // sull'app condivisa lascerebbe 429 ai test che vengono dopo.
    const limited = buildApp({
      db: testDb.db,
      sessionSecret: SESSION_SECRET,
      authRateLimit: { max: 2, timeWindow: "1 minute" },
    });
    try {
      const payload = {
        email: "admin@example.com",
        password: "password-sbagliata",
        deviceName: "iPhone di Ada",
      };
      const first = await mobileLogin(payload, limited);
      const second = await mobileLogin(payload, limited);
      const third = await mobileLogin(payload, limited);
      expect([first.statusCode, second.statusCode]).toEqual([401, 401]);
      expect(third.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("preferenza lingua utente", () => {
  it("GET /api/auth/me espone la lingua dell'utente (default 'en')", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { language: string } }).user.language).toBe("en");
  });

  it("PATCH /api/auth/me cambia la lingua e si riflette in /me", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
      payload: { language: "it" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ language: "it" });

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { language: string } }).user.language).toBe("it");

    // Ripristina la lingua di default per non interferire con altri test che
    // riusano adminCookie e si aspettano 'en'.
    await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
      payload: { language: "en" },
    });
  });

  it("PATCH /api/auth/me con lingua non valida risponde 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
      payload: { language: "fr" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /api/auth/me senza cookie risponde 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      payload: { language: "it" },
    });
    expect(res.statusCode).toBe(401);
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

describe("lista e revoca inviti", () => {
  // Cookie di un member registrato via invito, per i controlli di ruolo.
  let memberCookie: string;

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

  it("prepara un member per i controlli di ruolo", async () => {
    const token = await createInvite("ruoli-member@example.com");
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email: "ruoli-member@example.com", password: "password-member" },
    });
    expect(reg.statusCode).toBe(201);
    const loginRes = await login("ruoli-member@example.com", "password-member");
    expect(loginRes.statusCode).toBe(200);
    memberCookie = sessionCookie(loginRes);
  });

  it("GET /api/auth/invites elenca gli inviti in sospeso, non quelli già usati", async () => {
    // Un invito che resta in sospeso e uno che viene consumato dalla register.
    const pendingToken = await createInvite("in-sospeso@example.com");
    const usedToken = await createInvite("registrato@example.com");
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token: usedToken, email: "registrato@example.com", password: "password-member" },
    });
    expect(reg.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/invites",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { token: string; email: string }[];
    const emails = list.map((i) => i.email);
    expect(emails).toContain("in-sospeso@example.com");
    // L'invito consumato (utente registrato) non compare più.
    expect(emails).not.toContain("registrato@example.com");
    const pending = list.find((i) => i.token === pendingToken);
    expect(pending).toMatchObject({ email: "in-sospeso@example.com" });
    expect(pending).toHaveProperty("expiresAt");
    expect(pending).toHaveProperty("createdAt");
  });

  it("DELETE /api/auth/invites/:token revoca un invito in sospeso (204) e lo rimuove", async () => {
    const token = await createInvite("da-revocare@example.com");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/auth/invites/${token}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(204);

    const remaining = await testDb.db.select().from(invites).where(eq(invites.token, token));
    expect(remaining).toHaveLength(0);
  });

  it("DELETE /api/auth/invites/:token risponde 404 se il token non esiste", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: "/api/auth/invites/token-inesistente",
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(404);
  });

  it("requireAdmin blocca un member su lista e revoca (403)", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/auth/invites",
      headers: { cookie: memberCookie },
    });
    expect(list.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/auth/invites/qualunque",
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it("GET /api/users è accessibile a un member e include createdAt", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; email: string; role: string; createdAt: string }[];
    expect(list.length).toBeGreaterThan(0);
    for (const u of list) {
      expect(u).toHaveProperty("createdAt");
      expect(Number.isNaN(new Date(u.createdAt).getTime())).toBe(false);
    }
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

// Flusso inviti con identità Slack: l'invito originato dal picker del workspace
// porta con sé slackUserId + avatar, derivati server-side dal profilo Slack
// (mai dal client). Usa un'app dedicata con i segreti Slack configurati e un
// client fake (niente rete). DB e admin separati dal resto del file.
describe("inviti con identità Slack", () => {
  const SLACK_SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
  const ENCRYPTION_KEY = randomBytes(32);
  const SIGNING_SECRET = "slack-signing-secret-di-test-1234567890";
  const BOT_TOKEN = "xoxb-test-token";

  let slackDb: TestDb;
  let slackApp: FastifyInstance;
  let slackAdminCookie: string;

  // Profilo restituito dal client fake; mutabile per pilotare i casi (null =
  // utente Slack inesistente).
  let profileToReturn: Awaited<ReturnType<SlackClient["getUserProfile"]>> = {
    email: "slack@example.com",
    displayName: "Slack User",
    avatarUrl: "https://avatars.slack-edge.com/s.png",
  };
  const getUserProfile = vi.fn<SlackClient["getUserProfile"]>(async () => profileToReturn);
  const slackClientFactory: SlackClientFactory = () => ({
    openView: async () => true,
    getUserEmail: async () => profileToReturn?.email ?? null,
    getUserProfile,
    listWorkspaceUsers: async () => [],
      // Messaggistica: non usata da questo flusso (i DM dell'inbox sono del worker).
    postMessage: async () => {
      throw new Error("postMessage non previsto in questo test");
    },
    updateMessage: async () => {
      throw new Error("updateMessage non previsto in questo test");
    },
  });

  /** Imposta (o azzera) i segreti Slack cifrati sul singleton instance settings. */
  async function setSlackCreds(enabled: boolean): Promise<void> {
    const values = {
      slackSigningSecretEncrypted: enabled ? encrypt(SIGNING_SECRET, ENCRYPTION_KEY) : null,
      slackBotTokenEncrypted: enabled ? encrypt(BOT_TOKEN, ENCRYPTION_KEY) : null,
    };
    await slackDb.db
      .insert(instanceSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: instanceSettings.id, set: values });
  }

  async function slackLogin(email: string, password: string) {
    return slackApp.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  }

  beforeAll(async () => {
    slackDb = await startTestDb();
    slackApp = buildApp({
      db: slackDb.db,
      sessionSecret: SLACK_SESSION_SECRET,
      encryptionKey: ENCRYPTION_KEY.toString("base64"),
      slackClientFactory,
    });
    // Admin di prima istanza, poi login per il cookie admin.
    const setup = await slackApp.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { email: "slack-admin@example.com", password: "password-sicura" },
    });
    expect(setup.statusCode).toBe(201);
    const login = await slackLogin("slack-admin@example.com", "password-sicura");
    const cookie = login.cookies.find((c) => c.name === "stubwise_session");
    if (!cookie) throw new Error("cookie di sessione admin assente");
    slackAdminCookie = `stubwise_session=${cookie.value}`;
    await setSlackCreds(true);
  }, 120_000);

  afterAll(async () => {
    await slackApp.close();
    await slackDb.stop();
  });

  it("POST invito con slackUserId salva slack_user_id + avatar derivati dal profilo", async () => {
    profileToReturn = {
      email: "invitato@example.com",
      displayName: "Invitato",
      avatarUrl: "https://avatars.slack-edge.com/inv.png",
    };
    const res = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "invitato@example.com", slackUserId: "Uinvited" },
    });
    expect(res.statusCode).toBe(201);
    const { token } = res.json() as { token: string };
    expect(getUserProfile).toHaveBeenCalledWith("Uinvited");

    const [row] = await slackDb.db
      .select({ slackUserId: invites.slackUserId, slackAvatarUrl: invites.slackAvatarUrl })
      .from(invites)
      .where(eq(invites.token, token));
    expect(row!.slackUserId).toBe("Uinvited");
    expect(row!.slackAvatarUrl).toBe("https://avatars.slack-edge.com/inv.png");
  });

  it("POST invito con slackUserId ma profilo null → 400 slack_user_not_found", async () => {
    profileToReturn = null;
    const res = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "ignoto@example.com", slackUserId: "Uunknown" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("slack_user_not_found");
    profileToReturn = {
      email: "slack@example.com",
      displayName: "Slack User",
      avatarUrl: "https://avatars.slack-edge.com/s.png",
    };
  });

  it("POST invito con slackUserId ma Slack non configurato → 400 slack_not_configured", async () => {
    await setSlackCreds(false);
    const res = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "noslack@example.com", slackUserId: "Ux" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("slack_not_configured");
    await setSlackCreds(true);
  });

  it("POST invito senza slackUserId è invariato (nessun campo Slack)", async () => {
    const res = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "classico@example.com" },
    });
    expect(res.statusCode).toBe(201);
    const { token } = res.json() as { token: string };
    const [row] = await slackDb.db
      .select({ slackUserId: invites.slackUserId, slackAvatarUrl: invites.slackAvatarUrl })
      .from(invites)
      .where(eq(invites.token, token));
    expect(row!.slackUserId).toBeNull();
    expect(row!.slackAvatarUrl).toBeNull();
  });

  it("register di un invito Slack copia slackUserId + avatar sull'utente; il login funziona", async () => {
    profileToReturn = {
      email: "reg@example.com",
      displayName: "Reg",
      avatarUrl: "https://avatars.slack-edge.com/reg.png",
    };
    const inv = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "reg@example.com", slackUserId: "Ureg" },
    });
    const { token } = inv.json() as { token: string };

    const reg = await slackApp.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email: "reg@example.com", password: "password-member" },
    });
    expect(reg.statusCode).toBe(201);

    const [row] = await slackDb.db
      .select({ slackUserId: users.slackUserId, slackAvatarUrl: users.slackAvatarUrl })
      .from(users)
      .where(eq(users.email, "reg@example.com"));
    expect(row!.slackUserId).toBe("Ureg");
    expect(row!.slackAvatarUrl).toBe("https://avatars.slack-edge.com/reg.png");

    const login = await slackLogin("reg@example.com", "password-member");
    expect(login.statusCode).toBe(200);
  });

  it("register di un invito il cui slackUserId è già di un altro utente → 201 senza campi Slack", async () => {
    // Un utente che già possiede lo Slack id "Utaken".
    await slackDb.db.insert(users).values({
      email: "owner@example.com",
      passwordHash: "x",
      role: "member",
      slackUserId: "Utaken",
      slackAvatarUrl: "https://avatars.slack-edge.com/owner.png",
    });
    // Invito che fa riferimento allo stesso Slack id.
    profileToReturn = {
      email: "conteso@example.com",
      displayName: "Conteso",
      avatarUrl: "https://avatars.slack-edge.com/conteso.png",
    };
    const inv = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "conteso@example.com", slackUserId: "Utaken" },
    });
    const { token } = inv.json() as { token: string };

    const reg = await slackApp.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email: "conteso@example.com", password: "password-member" },
    });
    // La registrazione non deve fallire per il conflitto sull'identità Slack.
    expect(reg.statusCode).toBe(201);
    const [row] = await slackDb.db
      .select({ slackUserId: users.slackUserId, slackAvatarUrl: users.slackAvatarUrl })
      .from(users)
      .where(eq(users.email, "conteso@example.com"));
    expect(row!.slackUserId).toBeNull();
    expect(row!.slackAvatarUrl).toBeNull();
  });

  it("register classico (invito senza Slack) resta invariato", async () => {
    const inv = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "plain@example.com" },
    });
    const { token } = inv.json() as { token: string };
    const reg = await slackApp.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token, email: "plain@example.com", password: "password-member" },
    });
    expect(reg.statusCode).toBe(201);
    const [row] = await slackDb.db
      .select({ slackUserId: users.slackUserId })
      .from(users)
      .where(eq(users.email, "plain@example.com"));
    expect(row!.slackUserId).toBeNull();
  });

  it("GET /api/auth/invites espone slackUserId e slackAvatarUrl", async () => {
    profileToReturn = {
      email: "lista@example.com",
      displayName: "Lista",
      avatarUrl: "https://avatars.slack-edge.com/lista.png",
    };
    const inv = await slackApp.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
      payload: { email: "lista@example.com", slackUserId: "Ulista" },
    });
    const { token } = inv.json() as { token: string };

    const res = await slackApp.inject({
      method: "GET",
      url: "/api/auth/invites",
      headers: { cookie: slackAdminCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as {
      token: string;
      slackUserId: string | null;
      slackAvatarUrl: string | null;
    }[];
    const entry = list.find((i) => i.token === token);
    expect(entry?.slackUserId).toBe("Ulista");
    expect(entry?.slackAvatarUrl).toBe("https://avatars.slack-edge.com/lista.png");
  });
});
