import { aiProviders, aiUsageSnapshots, encrypt, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LatestSnapshot } from "../providers/usage-window.js";
import type { AgentRunner } from "./runner.js";
import { probeIdleAccountsOnce, shouldProbe } from "./usage-poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const MIN = 60_000;
const NOW = new Date("2026-11-19T12:00:00Z");
const IDLE = 30 * MIN;
const TICK = 5 * MIN;

function snap(over: Partial<LatestSnapshot> & { ageMin: number }): LatestSnapshot {
  const { ageMin, ...rest } = over;
  return {
    capturedAt: new Date(NOW.getTime() - ageMin * MIN),
    parseOk: true,
    sessionRemaining: { percentUsed: 10, percentRemaining: 90, resetsLabel: null },
    weeklyRemaining: { percentUsed: 10, percentRemaining: 90, resetsLabel: null },
    sessionResetAt: null,
    weeklyResetAt: null,
    ...rest,
  };
}

describe("shouldProbe", () => {
  const free = { limitedUntil: null };
  it("senza snapshot sonda", () => {
    expect(shouldProbe(free, undefined, NOW, IDLE, TICK)).toBe(true);
  });
  it("snapshot di 10' non sonda", () => {
    expect(shouldProbe(free, snap({ ageMin: 10 }), NOW, IDLE, TICK)).toBe(false);
  });
  it("snapshot di 31' sonda", () => {
    expect(shouldProbe(free, snap({ ageMin: 31 }), NOW, IDLE, TICK)).toBe(true);
  });
  it("parseOk false vale come assente", () => {
    expect(shouldProbe(free, snap({ ageMin: 1, parseOk: false }), NOW, IDLE, TICK)).toBe(true);
  });
  describe("account al limite", () => {
    const limited = { limitedUntil: new Date(NOW.getTime() + 60 * MIN) };
    it("snapshot di 6' con tick 5' sonda (più spesso dell'inattività)", () => {
      expect(shouldProbe(limited, snap({ ageMin: 6 }), NOW, IDLE, TICK)).toBe(true);
    });
    it("snapshot di 2' non sonda", () => {
      expect(shouldProbe(limited, snap({ ageMin: 2 }), NOW, IDLE, TICK)).toBe(false);
    });
    it("finestra settimanale a 100 con reset domani: non sonda", () => {
      const s = snap({
        ageMin: 6,
        weeklyRemaining: { percentUsed: 100, percentRemaining: 0, resetsLabel: null },
        weeklyResetAt: new Date(NOW.getTime() + 24 * 60 * MIN),
      });
      expect(shouldProbe(limited, s, NOW, IDLE, TICK)).toBe(false);
    });
    it("stessa finestra con reset ieri: sonda", () => {
      const s = snap({
        ageMin: 6,
        weeklyRemaining: { percentUsed: 100, percentRemaining: 0, resetsLabel: null },
        weeklyResetAt: new Date(NOW.getTime() - 24 * 60 * MIN),
      });
      expect(shouldProbe(limited, s, NOW, IDLE, TICK)).toBe(true);
    });
  });
});

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

async function seedProvider(
  db: Db,
  v: { position: number; kind: "api_key" | "account"; label: string; enabled?: boolean; limitedUntil?: Date },
): Promise<string> {
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: v.position,
      kind: v.kind,
      label: v.label,
      secretEncrypted: encrypt(`secret-${v.label}`, ENCRYPTION_KEY),
      enabled: v.enabled ?? true,
      ...(v.limitedUntil ? { limitedUntil: v.limitedUntil } : {}),
    })
    .returning();
  if (!row) throw new Error("insert provider fallito");
  return row.id;
}

async function seedSnapshot(db: Db, providerId: string, ageMin: number): Promise<void> {
  await db.insert(aiUsageSnapshots).values({
    providerId,
    capturedAt: new Date(NOW.getTime() - ageMin * MIN),
    source: "deterministic",
    parseOk: true,
    rawText: null,
    sessionRemaining: { percentUsed: 10, percentRemaining: 90, resetsLabel: null },
    weeklyRemaining: { percentUsed: 10, percentRemaining: 90, resetsLabel: null },
  });
}

function deps(db: Db, runner: AgentRunner) {
  return { db, encryptionKey: ENCRYPTION_KEY, runner, idleMs: IDLE, tickMs: TICK, now: () => NOW };
}

describe("probeIdleAccountsOnce", () => {
  it("sonda solo gli account che ne hanno bisogno", async () => {
    const { db } = testDb;
    const fresh = await seedProvider(db, { position: 0, kind: "account", label: "fresco" });
    const stale = await seedProvider(db, { position: 1, kind: "account", label: "fermo" });
    await seedProvider(db, { position: 2, kind: "api_key", label: "key" });
    await seedProvider(db, { position: 3, kind: "account", label: "off", enabled: false });
    await seedSnapshot(db, fresh, 5);
    await seedSnapshot(db, stale, 40);
    const run = vi.fn<AgentRunner["run"]>(async () => ({ output: "ok", exitCode: 0 }));

    await probeIdleAccountsOnce(deps(db, { run }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].provider?.id).toBe(stale);
  });

  it("il run ha i vincoli globali e una cwd temporanea che poi sparisce", async () => {
    const { db } = testDb;
    const id = await seedProvider(db, { position: 0, kind: "account", label: "a" });
    const run = vi.fn<AgentRunner["run"]>(async () => ({ output: "ok", exitCode: 0 }));

    await probeIdleAccountsOnce(deps(db, { run }));

    const opts = run.mock.calls[0]![0];
    expect(opts.usage).toEqual({ operation: "usage_probe", projectId: null });
    expect(opts.model).toBe("haiku");
    expect(opts.maxTurns).toBe(1);
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.permissionMode).toBe("default");
    expect(opts.provider).toMatchObject({ id, kind: "account" });
    const { existsSync } = await import("node:fs");
    expect(opts.cwd).toContain("stubwise-usage-probe-");
    expect(existsSync(opts.cwd)).toBe(false);
  });

  it("un run che lancia sul primo account non ferma il secondo, e non lancia", async () => {
    const { db } = testDb;
    const a = await seedProvider(db, { position: 0, kind: "account", label: "a" });
    const b = await seedProvider(db, { position: 1, kind: "account", label: "b" });
    const run = vi.fn<AgentRunner["run"]>(async (o) => {
      if (o.provider?.id === a) throw new Error("boom");
      return { output: "ok", exitCode: 0 };
    });

    await expect(probeIdleAccountsOnce(deps(db, { run }))).resolves.toBeUndefined();

    expect(run.mock.calls.map((c) => c[0].provider?.id)).toEqual([a, b]);
  });
});
