import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifications, userBackupCodes, userPasskeys, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { passkeyRp } from "../auth/second-factor/passkeys.js";
import { listSecurityEvents } from "../auth/second-factor/security-events.js";
import { createSession } from "../auth/session.js";
import { createUserWithPat, fullSessionCookie } from "../test/fixtures.js";
import { SoftAuthenticator } from "../test/webauthn.js";

/**
 * Impostazioni → Sicurezza (`/api/me/security`): lo stato del proprio secondo
 * fattore, i codici di riserva e le passkey. La riconferma recente (gate di
 * `config.reauth`) è provata in `auth/reauth.test.ts`; qui le sessioni sono
 * sempre fresche.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);
const PUBLIC_URL = "https://stubwise.example.com";
const RP = passkeyRp(PUBLIC_URL);

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: PUBLIC_URL,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Un utente con l'app configurata, i codici di riserva e una sessione completa fresca. */
async function newUser(): Promise<{ id: string; email: string; cookie: string }> {
  const email = `ms-${randomBytes(4).toString("hex")}@example.com`;
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  await regenerateBackupCodes(testDb.db, row!.id);
  return { id: row!.id, email, cookie: await fullSessionCookie(app, row!.id) };
}

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Soggetti degli avvisi di sicurezza nell'inbox di `userId`. */
async function alertSubjects(userId: string): Promise<string[]> {
  const rows = await testDb.db
    .select({ event: notifications.event })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, "security.alert")));
  return rows.map((r) => (r.event as { subject: string }).subject);
}

async function eventKinds(userId: string): Promise<string[]> {
  return (await listSecurityEvents(testDb.db, userId)).map((e) => e.kind);
}

/** Registra una passkey dalla rotta: options + risposta del software authenticator. */
async function registerPasskey(cookie: string, name = "Portatile") {
  const options = await call("POST", "/api/me/security/passkeys/options", cookie);
  expect(options.statusCode, options.body).toBe(200);
  const authenticator = new SoftAuthenticator(RP);
  const res = await call("POST", "/api/me/security/passkeys", cookie, {
    name,
    response: authenticator.register(options.json() as { challenge: string }),
  });
  return { res, authenticator };
}

describe("GET /api/me/security", () => {
  it("stato del secondo fattore, senza segreto né codici", async () => {
    const user = await newUser();
    await registerPasskey(user.cookie);

    const res = await call("GET", "/api/me/security", user.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totp: { configured: boolean; confirmedAt: string | null };
      passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
      backupCodesRemaining: number;
      events: { kind: string; actorEmail: string | null }[];
    };
    expect(body.totp.configured).toBe(true);
    expect(body.totp.confirmedAt).not.toBeNull();
    expect(body.passkeys).toEqual([
      { id: expect.any(String), name: "Portatile", createdAt: expect.any(String), lastUsedAt: null },
    ]);
    expect(body.backupCodesRemaining).toBe(10);
    expect(body.events.map((e) => e.kind)).toEqual(["passkey_added"]);

    // Niente segreto TOTP, chiave della passkey o hash dei codici, in nessuna forma.
    expect(res.body).not.toMatch(/secret|publicKey|credentialId|codeHash|hash/i);
    const hashes = await testDb.db
      .select({ h: userBackupCodes.codeHash })
      .from(userBackupCodes)
      .where(eq(userBackupCodes.userId, user.id));
    for (const { h } of hashes) expect(res.body).not.toContain(h);
  });

  it("senza app configurata: configured false", async () => {
    const [row] = await testDb.db
      .insert(users)
      .values({ email: `ms-none-${randomBytes(4).toString("hex")}@example.com`, passwordHash: "x", role: "member" })
      .returning({ id: users.id });
    // Sessione di prima del rilascio: nessuna app (fullSessionCookie ne conferma una).
    const session = await createSession(testDb.db, row!.id, { stage: "full" });
    await app.ready();
    const cookie = `stubwise_session=${encodeURIComponent(app.signCookie(session.id))}`;
    const res = await call("GET", "/api/me/security", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      totp: { configured: false, confirmedAt: null },
      passkeys: [],
      backupCodesRemaining: 0,
    });
  });
});

describe("POST /api/me/security/backup-codes", () => {
  it("rigenera i codici, scrive l'evento e manda l'avviso", async () => {
    const user = await newUser();
    const res = await call("POST", "/api/me/security/backup-codes", user.cookie);
    expect(res.statusCode).toBe(200);
    const { codes } = res.json() as { codes: string[] };
    expect(codes).toHaveLength(10);
    expect(await eventKinds(user.id)).toEqual(["backup_codes_regenerated"]);
    expect(await alertSubjects(user.id)).toEqual(["backup_codes_regenerated"]);
  });

  it("via PAT → 403 session_required, codici invariati", async () => {
    const { id, headers } = await createUserWithPat(app, `ms-pat-${randomBytes(4).toString("hex")}@example.com`);
    await regenerateBackupCodes(testDb.db, id);
    const before = await testDb.db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, id));
    const res = await app.inject({ method: "POST", url: "/api/me/security/backup-codes", headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "session_required" });
    const after = await testDb.db.select().from(userBackupCodes).where(eq(userBackupCodes.userId, id));
    expect(after).toEqual(before);
  });
});

describe("passkey", () => {
  it("aggiunta: 201, evento e avviso passkey_added", async () => {
    const user = await newUser();
    const { res } = await registerPasskey(user.cookie, "  YubiKey  ");
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ name: "YubiKey", lastUsedAt: null });
    expect(await eventKinds(user.id)).toEqual(["passkey_added"]);
    expect(await alertSubjects(user.id)).toEqual(["passkey_added"]);
  });

  it("le opzioni arrivano intere al browser ed escludono le passkey già registrate", async () => {
    const user = await newUser();
    const { authenticator } = await registerPasskey(user.cookie);
    const res = await call("POST", "/api/me/security/passkeys/options", user.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rp: { id: RP.rpID, name: "Stubwise" },
      user: { name: user.email },
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation: "none",
      extensions: { credProps: true },
      excludeCredentials: [{ id: authenticator.credentialId, type: "public-key" }],
    });
  });

  it("risposta che non torna (origin sbagliata) → 400, nessuna passkey, nessun avviso", async () => {
    const user = await newUser();
    const options = await call("POST", "/api/me/security/passkeys/options", user.cookie);
    const res = await call("POST", "/api/me/security/passkeys", user.cookie, {
      name: "Falsa",
      response: new SoftAuthenticator(RP).register(options.json() as { challenge: string }, {
        origin: "https://evil.example.com",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "passkey_registration_failed" });
    expect(await testDb.db.select().from(userPasskeys).where(eq(userPasskeys.userId, user.id))).toEqual([]);
    expect(await alertSubjects(user.id)).toEqual([]);
  });

  it("rinomina e rimozione della propria: 200, poi 204 con evento passkey_removed", async () => {
    const user = await newUser();
    const { res } = await registerPasskey(user.cookie);
    const { id } = res.json() as { id: string };

    const renamed = await call("PATCH", `/api/me/security/passkeys/${id}`, user.cookie, { name: "Telefono" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id, name: "Telefono" });

    const removed = await call("DELETE", `/api/me/security/passkeys/${id}`, user.cookie);
    expect(removed.statusCode).toBe(204);
    expect(await testDb.db.select().from(userPasskeys).where(eq(userPasskeys.userId, user.id))).toEqual([]);
    expect(await eventKinds(user.id)).toEqual(["passkey_removed", "passkey_added"]);
  });

  it("passkey di un altro → 404, intatta", async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const { res } = await registerPasskey(owner.cookie);
    const { id } = res.json() as { id: string };

    const rename = await call("PATCH", `/api/me/security/passkeys/${id}`, intruder.cookie, { name: "Mia" });
    expect(rename.statusCode).toBe(404);
    expect(rename.json()).toMatchObject({ code: "passkey_not_found" });
    const remove = await call("DELETE", `/api/me/security/passkeys/${id}`, intruder.cookie);
    expect(remove.statusCode).toBe(404);

    const [row] = await testDb.db.select().from(userPasskeys).where(eq(userPasskeys.id, id));
    expect(row).toMatchObject({ userId: owner.id, name: "Portatile" });
    expect(await eventKinds(intruder.id)).toEqual([]);
  });
});
