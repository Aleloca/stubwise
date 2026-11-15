import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { instanceSettings } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Area 8, F4b, S11: i tetti dell'analisi dei server in Impostazioni (F4b-2 = b).
 * Istanza, `settings.manage`; senza riga valgono i default del codice.
 */

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  users = await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const get = (cookie?: string) => app.inject({ method: "GET", url: "/api/settings/server-analysis", headers: cookie ? { cookie } : {} });
const put = (payload: object, cookie?: string) =>
  app.inject({ method: "PUT", url: "/api/settings/server-analysis", headers: cookie ? { cookie } : {}, payload });

const DEFAULTS = { enabled: true, maxMinutes: 10, maxCostUsd: 1, maxAgentReads: 30, maxSshReads: 30 };

describe("/api/settings/server-analysis", () => {
  it("senza sessione 401, senza settings.manage 403 (lettura e scrittura)", async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await get(users.memberCookie)).statusCode).toBe(403);
    expect((await put(DEFAULTS, users.memberCookie)).statusCode).toBe(403);
  });

  it("senza riga: i default", async () => {
    await testDb.db.update(instanceSettings).set({ serverAnalysisLimits: null }).where(eq(instanceSettings.id, 1));
    const res = await get(users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULTS);
  });

  it("si scrivono e si rileggono; fuori dai limiti 400 e niente cambia", async () => {
    const next = { enabled: false, maxMinutes: 25, maxCostUsd: 2.5, maxAgentReads: 0, maxSshReads: 200 };
    const ok = await put(next, users.adminCookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(next);
    expect((await get(users.adminCookie)).json()).toEqual(next);
    for (const bad of [{ maxMinutes: 0 }, { maxMinutes: 61 }, { maxCostUsd: 0.05 }, { maxCostUsd: 21 }, { maxAgentReads: 201 }, { maxSshReads: -1 }, { maxMinutes: 2.5 }]) {
      expect((await put({ ...next, ...bad }, users.adminCookie)).statusCode).toBe(400);
    }
    expect((await get(users.adminCookie)).json()).toEqual(next);
  });

  it("una riga corrotta nel DB non rompe la lettura: i default", async () => {
    await testDb.db.update(instanceSettings).set({ serverAnalysisLimits: { maxMinutes: "tanti" } }).where(eq(instanceSettings.id, 1));
    expect((await get(users.adminCookie)).json()).toEqual(DEFAULTS);
  });
});
