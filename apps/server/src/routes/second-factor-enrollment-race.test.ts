import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessions, userBackupCodes, users } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { hasConfirmedTotp } from "../auth/second-factor/totp.js";
import { createSession } from "../auth/session.js";
import { sessionCookie } from "../test/fixtures.js";

/**
 * La corsa persa col blocco, resa deterministica: `settleSuccess` risponde
 * «il blocco è scattato mentre verificavi» quando `loseRace` è acceso. È il
 * caso in cui il codice di configurazione è GIUSTO ma il tentativo non va a
 * buon fine: niente deve restare a metà.
 */
let loseRace = false;
vi.mock("../auth/second-factor/lockout.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../auth/second-factor/lockout.js")>();
  return {
    ...original,
    settleSuccess: async (db: Parameters<typeof original.settleSuccess>[0], userId: string) =>
      loseRace ? false : original.settleSuccess(db, userId),
  };
});

const PASSWORD = "password-sicura";
let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    authRateLimit: { max: 1000, timeWindow: "1 minute" },
    publicUrl: "https://stubwise.example.com",
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function post(url: string, cookie: string, payload?: object) {
  return app.inject({
    method: "POST",
    url: `/api/auth/second-factor${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

describe("configurazione dal login: il codice giusto che perde la corsa col blocco", () => {
  it("non conferma l'app, non scrive codici di riserva e non promuove la sessione", async () => {
    const email = `race-${randomBytes(4).toString("hex")}@example.com`;
    const [row] = await testDb.db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" })
      .returning({ id: users.id });
    const userId = row!.id;
    const cookie = sessionCookie(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: PASSWORD },
      }),
    );
    const { secret } = (await post("/enroll", cookie)).json() as { secret: string };

    loseRace = true;
    try {
      const res = await post("/enroll/confirm", cookie, { code: generateSync({ secret }) });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: "second_factor_busy" });
    } finally {
      loseRace = false;
    }

    // Nulla a metà: un'app confermata senza codici di riserva lascerebbe
    // l'utente senza riserva, e la sessione `enrollment` non potrebbe più
    // configurarla (l'app ormai c'è).
    expect(await hasConfirmedTotp(testDb.db, userId)).toBe(false);
    const codes = await testDb.db
      .select()
      .from(userBackupCodes)
      .where(eq(userBackupCodes.userId, userId));
    expect(codes).toHaveLength(0);
    const [session] = await testDb.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(session?.stage).toBe("enrollment");

    // Riprovando (corsa vinta) la configurazione va fino in fondo, codici compresi.
    const retry = await post("/enroll/confirm", cookie, {
      code: generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }),
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { backupCodes: string[] }).backupCodes).toHaveLength(10);
    expect(await hasConfirmedTotp(testDb.db, userId)).toBe(true);
  });
});

describe("prima app da Sicurezza (sessione di prima del rilascio): stessa corsa persa", () => {
  it("non conferma l'app, non scrive codici di riserva e non conta come riconferma", async () => {
    const email = `race-setup-${randomBytes(4).toString("hex")}@example.com`;
    const [row] = await testDb.db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" })
      .returning({ id: users.id });
    const userId = row!.id;
    const session = await createSession(testDb.db, userId, { stage: "full", secondFactorAt: null });
    await app.ready();
    const cookie = `stubwise_session=${encodeURIComponent(app.signCookie(session.id))}`;
    const setup = await app.inject({
      method: "POST",
      url: "/api/me/security/totp/setup",
      headers: { cookie },
    });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string };

    loseRace = true;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/me/security/totp/setup/confirm",
        headers: { cookie },
        payload: { code: generateSync({ secret }) },
      });
      expect(res.statusCode).toBe(429);
    } finally {
      loseRace = false;
    }

    expect(await hasConfirmedTotp(testDb.db, userId)).toBe(false);
    const codes = await testDb.db
      .select()
      .from(userBackupCodes)
      .where(eq(userBackupCodes.userId, userId));
    expect(codes).toHaveLength(0);
    const [after] = await testDb.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(after?.secondFactorAt).toBeNull();
  });
});
