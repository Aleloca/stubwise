import { aiProviders, aiUsageSnapshots, encrypt } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RateLimitInfo } from "../agent/rate-limit-event.js";
import {
  clearProviderLimit,
  effectiveUsedPercent,
  latestSnapshots,
  MAX_SNAPSHOT_AGE_MS,
  parseWindow,
  rateLimitAllowsUnlock,
  writeRateLimitSnapshot,
} from "./usage-window.js";

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

  it("MAX_SNAPSHOT_AGE_MS è 45 minuti", () => {
    expect(MAX_SNAPSHOT_AGE_MS).toBe(45 * 60_000);
  });
});

const info = (status: string, windows: RateLimitInfo["windows"]): RateLimitInfo => ({
  status,
  rateLimitType: null,
  windows,
});

async function newAccount(label: string): Promise<string> {
  const [row] = await testDb.db
    .insert(aiProviders)
    .values({ position: 1, kind: "account", label, secretEncrypted: encrypt("x", randomBytes(32)) })
    .returning();
  return row!.id;
}

describe("writeRateLimitSnapshot", () => {
  it("la sola settimanale: riga deterministica, sessione null, capturedAt esplicito", async () => {
    const id = await newAccount("w1");
    const at = new Date("2026-11-19T09:00:00.000Z");
    const ok = await writeRateLimitSnapshot(
      testDb.db,
      id,
      info("allowed", { seven_day: { usedPercent: 28, resetsAt: new Date("2026-11-23T10:00:00.000Z") } }),
      at,
    );
    expect(ok).toBe(true);
    const [row] = await testDb.db.select().from(aiUsageSnapshots).where(eq(aiUsageSnapshots.providerId, id));
    expect(row!.weeklyRemaining).toEqual({ percentUsed: 28, percentRemaining: 72, resetsLabel: null });
    expect(row!.sessionRemaining).toBeNull();
    expect(row!.weeklyResetAt).toEqual(new Date("2026-11-23T10:00:00.000Z"));
    expect(row!.sessionResetAt).toBeNull();
    expect(row!.source).toBe("deterministic");
    expect(row!.parseOk).toBe(true);
    expect(row!.rawText).toBeNull();
    expect(row!.capturedAt).toEqual(at);
  });

  it("sessione e settimana: five_hour → session, seven_day → weekly", async () => {
    const id = await newAccount("w2");
    await writeRateLimitSnapshot(
      testDb.db,
      id,
      info("allowed", {
        five_hour: { usedPercent: 10, resetsAt: new Date("2026-11-19T12:00:00.000Z") },
        seven_day: { usedPercent: 50, resetsAt: null },
      }),
      new Date(),
    );
    const [row] = await testDb.db.select().from(aiUsageSnapshots).where(eq(aiUsageSnapshots.providerId, id));
    expect(row!.sessionRemaining).toEqual({ percentUsed: 10, percentRemaining: 90, resetsLabel: null });
    expect(row!.sessionResetAt).toEqual(new Date("2026-11-19T12:00:00.000Z"));
    expect(row!.weeklyResetAt).toBeNull();
  });

  it("solo seven_day_opus: non scrive e ritorna false", async () => {
    const id = await newAccount("w3");
    const ok = await writeRateLimitSnapshot(
      testDb.db,
      id,
      info("allowed", { seven_day_opus: { usedPercent: 5, resetsAt: null } }),
      new Date(),
    );
    expect(ok).toBe(false);
    const rows = await testDb.db.select().from(aiUsageSnapshots).where(eq(aiUsageSnapshots.providerId, id));
    expect(rows).toHaveLength(0);
  });
});

describe("rateLimitAllowsUnlock", () => {
  const w = (n: number) => ({ usedPercent: n, resetsAt: null });
  it("allowed e tutto < 100 → true", () => {
    expect(rateLimitAllowsUnlock(info("allowed", { five_hour: w(10), seven_day: w(99) }))).toBe(true);
  });
  it("rejected → false", () => {
    expect(rateLimitAllowsUnlock(info("rejected", { seven_day: w(10) }))).toBe(false);
  });
  it("allowed ma una finestra al 100 → false", () => {
    expect(rateLimitAllowsUnlock(info("allowed", { seven_day: w(40), seven_day_opus: w(100) }))).toBe(false);
  });
});

describe("effectiveUsedPercent", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const yesterday = new Date("2026-11-18T12:00:00.000Z");
  const tomorrow = new Date("2026-11-20T12:00:00.000Z");
  it("finestra assente → 0", () => {
    expect(effectiveUsedPercent(null, null, now)).toBe(0);
  });
  it("reset passato → 0, futuro → percentUsed, assente → percentUsed", () => {
    expect(effectiveUsedPercent({ percentUsed: 100 }, yesterday, now)).toBe(0);
    expect(effectiveUsedPercent({ percentUsed: 100 }, tomorrow, now)).toBe(100);
    expect(effectiveUsedPercent({ percentUsed: 73 }, null, now)).toBe(73);
  });
});

describe("clearProviderLimit", () => {
  it("azzera un limited_until valorizzato (true), poi non scrive più (false)", async () => {
    const id = await newAccount("c1");
    await testDb.db
      .update(aiProviders)
      .set({ limitedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(aiProviders.id, id));
    expect(await clearProviderLimit(testDb.db, id)).toBe(true);
    const [row] = await testDb.db.select().from(aiProviders).where(eq(aiProviders.id, id));
    expect(row!.limitedUntil).toBeNull();
    expect(await clearProviderLimit(testDb.db, id)).toBe(false);
  });
});
