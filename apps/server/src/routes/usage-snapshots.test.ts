import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { aiProviders, aiUsageSnapshots } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

// Provider seedati nel beforeAll: due account (uno con parse ok, uno fallito)
// e una api_key (deve essere esclusa dall'endpoint).
let accountOkId: string;
let accountFailId: string;
let apiKeyId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);

  [accountOkId, accountFailId, apiKeyId] = (
    await testDb.db
      .insert(aiProviders)
      .values([
        { position: 0, kind: "account", label: "Account OK", secretEncrypted: "enc-ok" },
        { position: 1, kind: "account", label: "Account Fail", secretEncrypted: "enc-fail" },
        { position: 2, kind: "api_key", label: "Console", secretEncrypted: "enc-key" },
      ])
      .returning()
  ).map((p) => p.id) as [string, string, string];

  // Account OK: due snapshot, l'ULTIMO (per capturedAt) deve vincere.
  await testDb.db.insert(aiUsageSnapshots).values([
    {
      providerId: accountOkId,
      capturedAt: new Date("2026-06-10T09:00:00Z"),
      sessionRemaining: { percentUsed: 90, percentRemaining: 10 },
      weeklyRemaining: { percentUsed: 50, percentRemaining: 50 },
      sessionResetAt: new Date("2026-06-10T13:00:00Z"),
      weeklyResetAt: new Date("2026-06-15T00:00:00Z"),
      source: "deterministic",
      parseOk: true,
      rawText: null,
    },
    {
      providerId: accountOkId,
      capturedAt: new Date("2026-06-10T14:00:00Z"),
      sessionRemaining: { percentUsed: 62, percentRemaining: 38 },
      weeklyRemaining: { percentUsed: 28, percentRemaining: 72 },
      sessionResetAt: new Date("2026-06-10T19:00:00Z"),
      weeklyResetAt: new Date("2026-06-16T00:00:00Z"),
      source: "deterministic",
      parseOk: true,
      rawText: null,
    },
  ]);

  // Account Fail: ultimo snapshot con parse fallito (rawText valorizzato,
  // source llm_fallback). Uno precedente parse ok per verificare che vinca
  // comunque l'ultimo (quello fallito).
  await testDb.db.insert(aiUsageSnapshots).values([
    {
      providerId: accountFailId,
      capturedAt: new Date("2026-06-09T08:00:00Z"),
      sessionRemaining: { percentUsed: 10, percentRemaining: 90 },
      weeklyRemaining: { percentUsed: 5, percentRemaining: 95 },
      source: "deterministic",
      parseOk: true,
      rawText: null,
    },
    {
      providerId: accountFailId,
      capturedAt: new Date("2026-06-10T16:00:00Z"),
      sessionRemaining: { percentUsed: 40, percentRemaining: 60 },
      weeklyRemaining: { percentUsed: 20, percentRemaining: 80 },
      source: "llm_fallback",
      parseOk: false,
      rawText: "Some unparseable /usage output\nwindows: ???",
    },
  ]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function getSnapshots(cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/api/ai-usage/snapshots",
    headers: cookie ? { cookie } : {},
  });
}

interface SnapshotItem {
  providerId: string;
  providerLabel: string;
  capturedAt: string;
  sessionRemaining: { percentUsed: number; percentRemaining: number } | null;
  weeklyRemaining: { percentUsed: number; percentRemaining: number } | null;
  sessionResetAt: string | null;
  weeklyResetAt: string | null;
  source: "deterministic" | "llm_fallback";
  parseOk: boolean;
  rawText?: string | null;
}

describe("GET /api/ai-usage/snapshots — auth", () => {
  it("senza sessione: 401", async () => {
    expect((await getSnapshots()).statusCode).toBe(401);
  });

  it("un member non può accedere: 403", async () => {
    expect((await getSnapshots(users.memberCookie)).statusCode).toBe(403);
  });
});

describe("GET /api/ai-usage/snapshots — ultimo per account", () => {
  it("ritorna solo l'ultimo snapshot per ciascun account, escludendo le api_key", async () => {
    const res = await getSnapshots(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as SnapshotItem[];

    // Solo i due account compaiono; l'api_key è esclusa.
    const ids = body.map((s) => s.providerId).sort();
    expect(ids).toEqual([accountOkId, accountFailId].sort());
    expect(body.find((s) => s.providerId === apiKeyId)).toBeUndefined();
  });

  it("per l'account OK vince l'ULTIMO snapshot (capturedAt desc) con label e reset", async () => {
    const res = await getSnapshots(users.adminCookie);
    const body = res.json() as SnapshotItem[];
    const ok = body.find((s) => s.providerId === accountOkId)!;

    expect(ok.providerLabel).toBe("Account OK");
    expect(ok.capturedAt).toBe("2026-06-10T14:00:00.000Z");
    expect(ok.sessionRemaining).toEqual({ percentUsed: 62, percentRemaining: 38 });
    expect(ok.weeklyRemaining).toEqual({ percentUsed: 28, percentRemaining: 72 });
    expect(ok.sessionResetAt).toBe("2026-06-10T19:00:00.000Z");
    expect(ok.weeklyResetAt).toBe("2026-06-16T00:00:00.000Z");
    expect(ok.source).toBe("deterministic");
    expect(ok.parseOk).toBe(true);
  });

  it("con parseOk=true rawText è assente o null", async () => {
    const res = await getSnapshots(users.adminCookie);
    const body = res.json() as SnapshotItem[];
    const ok = body.find((s) => s.providerId === accountOkId)!;
    expect(ok.rawText ?? null).toBeNull();
  });

  it("con parseOk=false vince l'ultimo (fallito) ed espone rawText e source llm_fallback", async () => {
    const res = await getSnapshots(users.adminCookie);
    const body = res.json() as SnapshotItem[];
    const fail = body.find((s) => s.providerId === accountFailId)!;

    expect(fail.providerLabel).toBe("Account Fail");
    expect(fail.capturedAt).toBe("2026-06-10T16:00:00.000Z");
    expect(fail.parseOk).toBe(false);
    expect(fail.source).toBe("llm_fallback");
    expect(fail.rawText).toBe("Some unparseable /usage output\nwindows: ???");
  });
});
