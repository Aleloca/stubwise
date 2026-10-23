import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { generateSync } from "otplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, roles, sessions, userPasskeys, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import {
  addMember,
  createUserWithPat,
  fullSessionCookie,
  presetRoleId,
  seedUsers,
  sessionCookie,
} from "../test/fixtures.js";
import { SoftAuthenticator } from "../test/webauthn.js";
import { REAUTH_WINDOW_MS } from "./access.js";
import { hashPassword } from "./password.js";
import { regenerateBackupCodes } from "./second-factor/backup-codes.js";
import { passkeyRp } from "./second-factor/passkeys.js";
import { listSecurityEvents } from "./second-factor/security-events.js";
import { confirmTotp, startTotpEnrollment, TOTP_PERIOD } from "./second-factor/totp.js";
import { createSession } from "./session.js";

/**
 * Riconferma recente (`config.reauth`, design «Riconferma recente»): per ogni
 * rotta sensibile, scaduta → 403 `reauth_required` senza effetti, fresca →
 * il gate passa, via PAT → 403 `session_required`. Poi le rotte di
 * `/api/me/security` che la soddisfano, e la sessione di prima del rilascio
 * (Review Focus 2).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PASSWORD = "password-sicura";
const PUBLIC_URL = "https://stubwise.example.com";
const RP = passkeyRp(PUBLIC_URL);

let testDb: TestDb;
let app: FastifyInstance;
let adminId: string;
let memberId: string;
let projectId: string;
/** Ruolo di progetto creato per i test di modifica/duplicazione. */
let customRoleId: string;
/** Ruolo da eliminare con la sessione fresca. */
let disposableRoleId: string;
let userPresetId: string;
let legacyMemberPresetId: string;
let pat: { authorization: string };

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
    publicUrl: PUBLIC_URL,
  });
  ({ adminId, memberId } = await seedUsers(app));
  const [project] = await testDb.db
    .insert(projects)
    .values({ name: "Riconferma", slug: "riconferma", ingestionKey: "riconferma-key" })
    .returning({ id: projects.id });
  projectId = project!.id;
  await addMember(app, projectId, memberId);
  const [custom, disposable] = await testDb.db
    .insert(roles)
    .values([
      { name: "Revisore", scope: "project", permissions: [] },
      { name: "Usa e getta", scope: "project", permissions: [] },
    ])
    .returning({ id: roles.id });
  customRoleId = custom!.id;
  disposableRoleId = disposable!.id;
  userPresetId = await presetRoleId(app, "user");
  legacyMemberPresetId = await presetRoleId(app, "legacy_member");
  pat = (await createUserWithPat(app, "pat-reauth@example.com")).headers;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Cookie firmato di una sessione completa creata a mano. */
async function cookieFor(sessionId: string): Promise<string> {
  await app.ready();
  return `stubwise_session=${encodeURIComponent(app.signCookie(sessionId))}`;
}

/** Sessione completa con l'ultimo secondo fattore `ageMs` fa (o mai: `null`). */
async function sessionAged(userId: string, ageMs: number | null): Promise<string> {
  const session = await createSession(app.db, userId, {
    stage: "full",
    secondFactorAt: ageMs === null ? null : new Date(Date.now() - ageMs),
  });
  return cookieFor(session.id);
}

/**
 * Impronta delle tabelle che le rotte sensibili toccano: «nessun effetto».
 * Dei token si guarda l'insieme degli id (crearne uno è l'effetto), non
 * `last_used_at`, che l'autenticazione via PAT aggiorna da sé.
 */
async function fingerprint(): Promise<string> {
  const sources = [
    sql`select t::text as r from users t`,
    sql`select t::text as r from roles t`,
    sql`select t::text as r from project_members t`,
    sql`select t::text as r from git_identities t`,
    sql`select t::text as r from password_reset_tokens t`,
    sql`select id::text as r from personal_access_tokens`,
  ];
  const parts: string[] = [];
  for (const source of sources) {
    const [row] = await testDb.db.execute<{ h: string }>(
      sql`select coalesce(md5(string_agg(s.r, ',' order by s.r)), '') as h from (${source}) s`,
    );
    parts.push(row!.h);
  }
  return parts.join("|");
}

interface SensitiveRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: () => string;
  payload?: () => Record<string, unknown>;
}

/** OGNI rotta con `reauth: true`, con un corpo valido (la validazione viene prima del gate). */
const ROUTES: [string, SensitiveRoute][] = [
  ["POST /api/pats", { method: "POST", url: () => "/api/pats", payload: () => ({ name: "cli" }) }],
  [
    "POST /api/auth/me/password",
    {
      method: "POST",
      url: () => "/api/auth/me/password",
      // Password attuale sbagliata: fresca → 400 di dominio, senza chiudere
      // le altre sessioni del test.
      payload: () => ({ currentPassword: "non-questa", newPassword: "nuova-password-sicura" }),
    },
  ],
  [
    "PATCH /api/users/:id/role",
    {
      method: "PATCH",
      url: () => `/api/users/${memberId}/role`,
      payload: () => ({ role: "member" }),
    },
  ],
  [
    "PATCH /api/users/:id/instance-role",
    {
      method: "PATCH",
      url: () => `/api/users/${memberId}/instance-role`,
      payload: () => ({ roleId: userPresetId }),
    },
  ],
  [
    "POST /api/users/:id/password-reset",
    { method: "POST", url: () => `/api/users/${memberId}/password-reset` },
  ],
  [
    "PUT /api/users/:id/slack",
    {
      method: "PUT",
      url: () => `/api/users/${memberId}/slack`,
      payload: () => ({ slackUserId: "U1" }),
    },
  ],
  ["DELETE /api/users/:id/slack", { method: "DELETE", url: () => `/api/users/${memberId}/slack` }],
  [
    "POST /api/users/:id/git-identities",
    {
      method: "POST",
      url: () => `/api/users/${memberId}/git-identities`,
      payload: () => ({ email: "member@git.example.com" }),
    },
  ],
  [
    "DELETE /api/users/:id/git-identities/:email",
    {
      method: "DELETE",
      url: () =>
        `/api/users/${memberId}/git-identities/${encodeURIComponent("member@git.example.com")}`,
    },
  ],
  [
    "POST /api/roles",
    {
      method: "POST",
      url: () => "/api/roles",
      payload: () => ({ name: "Nuovo", scope: "project", permissions: [] }),
    },
  ],
  [
    "POST /api/roles/:id/duplicate",
    {
      method: "POST",
      url: () => `/api/roles/${customRoleId}/duplicate`,
      payload: () => ({ name: "Copia" }),
    },
  ],
  [
    "PATCH /api/roles/:id",
    {
      method: "PATCH",
      url: () => `/api/roles/${customRoleId}`,
      payload: () => ({ name: "Revisore 2" }),
    },
  ],
  ["DELETE /api/roles/:id", { method: "DELETE", url: () => `/api/roles/${disposableRoleId}` }],
  [
    "PUT /api/projects/:projectId/members/:userId",
    {
      method: "PUT",
      url: () => `/api/projects/${projectId}/members/${memberId}`,
      payload: () => ({ roleId: legacyMemberPresetId }),
    },
  ],
  [
    "DELETE /api/projects/:projectId/members/:userId",
    { method: "DELETE", url: () => `/api/projects/${projectId}/members/${memberId}` },
  ],
];

function call(route: SensitiveRoute, headers: Record<string, string>) {
  const payload = route.payload?.();
  return app.inject({
    method: route.method,
    url: route.url(),
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

describe("rotte sensibili: il gate della riconferma", () => {
  it.each(ROUTES)("%s — scaduta → 403 reauth_required, e nessun effetto", async (_name, route) => {
    const cookie = await sessionAged(adminId, REAUTH_WINDOW_MS + 60_000);
    const before = await fingerprint();
    const res = await call(route, { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "reauth_required" });
    expect(await fingerprint()).toBe(before);
  });

  it.each(ROUTES)(
    "%s — mai riconfermata in questa sessione → 403 reauth_required",
    async (_name, route) => {
      const cookie = await sessionAged(adminId, null);
      const res = await call(route, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "reauth_required" });
    },
  );

  it.each(ROUTES)("%s — via PAT → 403 session_required", async (_name, route) => {
    const before = await fingerprint();
    const res = await call(route, pat);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
    expect(await fingerprint()).toBe(before);
  });

  it.each(ROUTES)("%s — fresca → passa il gate", async (_name, route) => {
    const cookie = await sessionAged(adminId, REAUTH_WINDOW_MS - 60_000);
    const res = await call(route, { cookie });
    expect(res.statusCode, res.body).toBeLessThan(500);
    const code = res.body ? (res.json() as { code?: string }).code : undefined;
    expect(code).not.toBe("reauth_required");
    expect(code).not.toBe("session_required");
    expect(code).not.toBe("second_factor_setup_required");
  });
});

// --- /api/me/security ---------------------------------------------------

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `rc-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" })
    .returning({ id: users.id });
  return { id: row!.id, email };
}

/** Codice TOTP di `secret` al passo `offset` rispetto a quello corrente. */
function codeAt(secret: string, offset = 0): string {
  const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD) + offset;
  return generateSync({ secret, epoch: step * TOTP_PERIOD });
}

/**
 * Utente con l'app configurata nel passato: il passo corrente resta libero
 * per il prossimo codice (anti-replay).
 */
async function createUserWithTotp() {
  const user = await createUser();
  const { secret } = await startTotpEnrollment(testDb.db, ENCRYPTION_KEY, user);
  const past = Date.now() - 5 * 60_000;
  const ok = await confirmTotp(
    testDb.db,
    ENCRYPTION_KEY,
    user.id,
    generateSync({ secret, epoch: Math.floor(past / 1000) }),
    past,
  );
  if (!ok) throw new Error("conferma TOTP di preparazione fallita");
  await regenerateBackupCodes(testDb.db, user.id);
  return { ...user, secret };
}

function post(url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function secondFactorAtOf(cookie: string): Promise<Date | null> {
  const signed = decodeURIComponent(cookie.slice("stubwise_session=".length));
  const sessionId = app.unsignCookie(signed).value!;
  const [row] = await testDb.db
    .select({ at: sessions.secondFactorAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row!.at;
}

describe("POST /api/me/security/reauth", () => {
  it("codice giusto da una sessione scaduta → 204, e l'azione sensibile passa", async () => {
    const user = await createUserWithTotp();
    const cookie = await sessionAged(user.id, REAUTH_WINDOW_MS + 60_000);
    expect((await post("/api/pats", { cookie }, { name: "x" })).json()).toMatchObject({
      code: "reauth_required",
    });

    const res = await post("/api/me/security/reauth", { cookie }, { code: codeAt(user.secret) });
    expect(res.statusCode).toBe(204);
    const at = await secondFactorAtOf(cookie);
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000);
    expect((await post("/api/pats", { cookie }, { name: "x" })).statusCode).toBe(201);
  });

  it("un codice usato al login non vale per la riconferma nello stesso passo (anti-replay)", async () => {
    const user = await createUserWithTotp();
    const login = await post("/api/auth/login", {}, { email: user.email, password: PASSWORD });
    const cookie = sessionCookie(login);
    const code = codeAt(user.secret);
    const verify = await post("/api/auth/second-factor/verify", { cookie }, { code });
    expect(verify.statusCode).toBe(200);

    const res = await post("/api/me/security/reauth", { cookie }, { code });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_second_factor" });
  });

  it("codici sbagliati: contano nel tetto e il blocco ferma la riconferma, ma la sessione resta valida", async () => {
    const user = await createUserWithTotp();
    const cookie = await sessionAged(user.id, REAUTH_WINDOW_MS + 60_000);
    for (let i = 1; i <= 4; i++) {
      const res = await post("/api/me/security/reauth", { cookie }, { code: "000000" });
      expect(res.statusCode, `tentativo ${i}`).toBe(401);
    }
    const fifth = await post("/api/me/security/reauth", { cookie }, { code: "000000" });
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toMatchObject({ code: "second_factor_locked" });

    const right = await post("/api/me/security/reauth", { cookie }, { code: codeAt(user.secret) });
    expect(right.statusCode).toBe(423);
    expect(await secondFactorAtOf(cookie)).not.toBeNull();
    expect(Date.now() - (await secondFactorAtOf(cookie))!.getTime()).toBeGreaterThan(
      REAUTH_WINDOW_MS,
    );
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it("via PAT → 403 session_required", async () => {
    const res = await post("/api/me/security/reauth", pat, { code: "123456" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
  });

  it("senza un'app configurata → 403 second_factor_setup_required, nessun tentativo contato", async () => {
    const user = await createUser();
    const cookie = await sessionAged(user.id, null);
    const res = await post("/api/me/security/reauth", { cookie }, { code: "123456" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "second_factor_setup_required" });
    const [row] = await testDb.db
      .select({ failures: users.secondFactorFailures })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row!.failures).toBe(0);
  });
});

describe("riconferma con passkey", () => {
  it("options + verify da una sessione scaduta → 204, e l'azione sensibile passa", async () => {
    const user = await createUserWithTotp();
    const authenticator = new SoftAuthenticator(RP);
    await testDb.db.insert(userPasskeys).values({
      userId: user.id,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.publicKey,
      name: "Portatile",
    });
    const cookie = await sessionAged(user.id, REAUTH_WINDOW_MS + 60_000);

    const options = await post("/api/me/security/reauth/passkey/options", { cookie });
    expect(options.statusCode).toBe(200);
    const res = await post(
      "/api/me/security/reauth/passkey/verify",
      { cookie },
      { response: authenticator.assert(options.json() as { challenge: string }) },
    );
    expect(res.statusCode).toBe(204);
    expect((await post("/api/pats", { cookie }, { name: "x" })).statusCode).toBe(201);
  });

  it("senza passkey → 409 no_passkeys; via PAT → 403 session_required", async () => {
    const user = await createUserWithTotp();
    const cookie = await sessionAged(user.id, null);
    const res = await post("/api/me/security/reauth/passkey/options", { cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "no_passkeys" });
    const viaPat = await post("/api/me/security/reauth/passkey/options", pat);
    expect(viaPat.json()).toMatchObject({ code: "session_required" });
  });
});

describe("sessione di prima del rilascio (Review Focus 2)", () => {
  it("POST /api/pats → 403 second_factor_setup_required; configurazione dalla STESSA sessione; poi 201", async () => {
    const user = await createUser();
    const cookie = await sessionAged(user.id, null);

    const blocked = await post("/api/pats", { cookie }, { name: "x" });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "second_factor_setup_required" });

    const setup = await post("/api/me/security/totp/setup", { cookie });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string };

    const confirm = await post(
      "/api/me/security/totp/setup/confirm",
      { cookie },
      { code: codeAt(secret) },
    );
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { backupCodes: string[] }).backupCodes).toHaveLength(10);
    expect((await listSecurityEvents(testDb.db, user.id)).map((e) => e.kind)).toEqual(["enrolled"]);

    expect((await post("/api/pats", { cookie }, { name: "x" })).statusCode).toBe(201);
  });
});

describe("riconfigura app", () => {
  it("con l'app già configurata, /totp/setup chiede la riconferma recente", async () => {
    const user = await createUserWithTotp();
    const cookie = await sessionAged(user.id, REAUTH_WINDOW_MS + 60_000);
    const res = await post("/api/me/security/totp/setup", { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "reauth_required" });
  });

  it("la vecchia app vale fino alla conferma della nuova, poi solo la nuova; codici invariati", async () => {
    const user = await createUserWithTotp();
    const cookie = await fullSessionCookie(app, user.id);

    const setup = await post("/api/me/security/totp/setup", { cookie });
    expect(setup.statusCode).toBe(200);
    const { secret: newSecret } = setup.json() as { secret: string };

    // Configurazione in corso: la vecchia app riconferma ancora.
    const old = await post("/api/me/security/reauth", { cookie }, { code: codeAt(user.secret) });
    expect(old.statusCode).toBe(204);

    const confirm = await post(
      "/api/me/security/totp/setup/confirm",
      { cookie },
      { code: codeAt(newSecret) },
    );
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ backupCodes: null });
    expect((await listSecurityEvents(testDb.db, user.id)).map((e) => e.kind)).toContain(
      "totp_reconfigured",
    );

    const stale = await post(
      "/api/me/security/reauth",
      { cookie },
      { code: codeAt(user.secret, 1) },
    );
    expect(stale.statusCode).toBe(401);
    const fresh = await post("/api/me/security/reauth", { cookie }, { code: codeAt(newSecret, 1) });
    expect(fresh.statusCode).toBe(204);
  });

  it("codice sbagliato alla conferma → 401 invalid_second_factor, l'app resta quella di prima", async () => {
    const user = await createUserWithTotp();
    const cookie = await fullSessionCookie(app, user.id);
    await post("/api/me/security/totp/setup", { cookie });
    const res = await post("/api/me/security/totp/setup/confirm", { cookie }, { code: "000000" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "invalid_second_factor" });
    const ok = await post("/api/me/security/reauth", { cookie }, { code: codeAt(user.secret) });
    expect(ok.statusCode).toBe(204);
  });
});
