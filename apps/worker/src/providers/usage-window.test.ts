import { aiProviders, aiUsageSnapshots, encrypt } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { latestSnapshots, MAX_SNAPSHOT_AGE_MS, parseWindow } from "./usage-window.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

describe("parseWindow", () => {
  it("oggetto valido", () => {
    expect(parseWindow({ percentUsed: 42 })).toEqual({ percentUsed: 42 });
  });
  it("numero non finito, mancante o non oggetto → null", () => {
    expect(parseWindow({ percentUsed: Number.NaN })).toBeNull();
    expect(parseWindow({ percentUsed: Infinity })).toBeNull();
    expect(parseWindow({ percentUsed: "5" })).toBeNull();
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow(7)).toBeNull();
  });
});

describe("latestSnapshots", () => {
  it("l'ultimo per provider, con gli istanti di reset", async () => {
    const key = randomBytes(32);
    const [a, b] = await testDb.db
      .insert(aiProviders)
      .values([
        { position: 1, kind: "account", label: "a", secretEncrypted: encrypt("x", key) },
        { position: 2, kind: "account", label: "b", secretEncrypted: encrypt("y", key) },
      ])
      .returning();
    const old = new Date(Date.now() - 60 * 60_000);
    const recent = new Date(Date.now() - 60_000);
    const sessionResetAt = new Date(Date.now() + 3_600_000);
    const weeklyResetAt = new Date(Date.now() + 86_400_000);
    await testDb.db.insert(aiUsageSnapshots).values([
      { providerId: a!.id, capturedAt: old, source: "deterministic", parseOk: true, weeklyRemaining: { percentUsed: 10 } },
      { providerId: a!.id, capturedAt: recent, source: "deterministic", parseOk: true, weeklyRemaining: { percentUsed: 55 }, sessionResetAt, weeklyResetAt },
      { providerId: b!.id, capturedAt: old, source: "deterministic", parseOk: false },
    ]);
    const map = await latestSnapshots(testDb.db);
    expect(map.size).toBe(2);
    const sa = map.get(a!.id)!;
    expect(sa.capturedAt).toEqual(recent);
    expect(sa.weeklyRemaining).toEqual({ percentUsed: 55 });
    expect(sa.sessionResetAt).toEqual(sessionResetAt);
    expect(sa.weeklyResetAt).toEqual(weeklyResetAt);
    const sb = map.get(b!.id)!;
    expect(sb.parseOk).toBe(false);
    expect(sb.sessionResetAt).toBeNull();
    expect(sb.weeklyResetAt).toBeNull();
  });

  it("MAX_SNAPSHOT_AGE_MS è 15 minuti", () => {
    expect(MAX_SNAPSHOT_AGE_MS).toBe(15 * 60_000);
  });
});
