import { aiProviders, aiUsageSnapshots, encrypt, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../providers/chain.js";
import { pollUsageOnce } from "./usage-poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(aiProviders); // cascade cancella anche gli snapshot
});

afterAll(async () => {
  await testDb.stop();
});

async function seedProvider(
  db: Db,
  values: { position: number; kind: "api_key" | "account"; label: string; secret: string },
): Promise<string> {
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: values.position,
      kind: values.kind,
      label: values.label,
      secretEncrypted: encrypt(values.secret, ENCRYPTION_KEY),
      enabled: true,
    })
    .returning();
  if (!row) throw new Error("insert provider fallito");
  return row.id;
}

describe("pollUsageOnce", () => {
  it("salva uno snapshot per OGNI credenziale account (deterministico → parseOk true, rawText null)", async () => {
    const { db } = testDb;
    const acc1 = await seedProvider(db, { position: 1, kind: "account", label: "max-1", secret: "o1" });
    const acc2 = await seedProvider(db, { position: 2, kind: "account", label: "max-2", secret: "o2" });
    // Una api_key NON è un account → niente snapshot, ma è usabile per il runLlm.
    await seedProvider(db, { position: 3, kind: "api_key", label: "key", secret: "sk-1" });

    const deterministicOutput = "Current session\n42% used\nWeekly limit\n31% used\n";

    await pollUsageOnce({
      db,
      encryptionKey: ENCRYPTION_KEY,
      capture: async () => deterministicOutput,
      runLlm: async () => {
        throw new Error("non dovrebbe servire: il deterministico funziona");
      },
    });

    const snaps = await db.select().from(aiUsageSnapshots);
    expect(snaps).toHaveLength(2);
    const byProvider = new Map(snaps.map((s) => [s.providerId, s]));
    for (const id of [acc1, acc2]) {
      const s = byProvider.get(id);
      expect(s).toBeTruthy();
      expect(s?.source).toBe("deterministic");
      expect(s?.parseOk).toBe(true);
      // rawText conservato SOLO quando parseOk=false.
      expect(s?.rawText).toBeNull();
      expect(s?.sessionRemaining).toEqual({ percentUsed: 42, percentRemaining: 58 });
    }
  });

  it("fallback LLM → parseOk false, source llm_fallback, rawText = grezzo conservato", async () => {
    const { db } = testDb;
    const acc = await seedProvider(db, { position: 1, kind: "account", label: "max", secret: "o" });

    const unparseable = "schermata illeggibile per il regex deterministico";
    await pollUsageOnce({
      db,
      encryptionKey: ENCRYPTION_KEY,
      capture: async () => unparseable,
      runLlm: async () =>
        JSON.stringify({
          sessionRemaining: { percentUsed: 5, percentRemaining: 95 },
          weeklyRemaining: { percentUsed: 7, percentRemaining: 93 },
        }),
    });

    const [s] = await db.select().from(aiUsageSnapshots);
    expect(s?.providerId).toBe(acc);
    expect(s?.source).toBe("llm_fallback");
    expect(s?.parseOk).toBe(false);
    expect(s?.rawText).toBe(unparseable);
  });

  it("un capture che lancia per una credenziale NON blocca le altre (best-effort)", async () => {
    const { db } = testDb;
    const good = await seedProvider(db, { position: 1, kind: "account", label: "ok", secret: "o1" });
    const bad = await seedProvider(db, { position: 2, kind: "account", label: "boom", secret: "o2" });

    await pollUsageOnce({
      db,
      encryptionKey: ENCRYPTION_KEY,
      capture: async (provider: ResolvedProvider) => {
        if (provider.id === bad) throw new Error("PTY si è bloccato");
        return "Current session\n10% used\nWeekly\n20% used\n";
      },
      runLlm: async () => {
        throw new Error("no");
      },
    });

    const snaps = await db.select().from(aiUsageSnapshots);
    // Solo la buona ha prodotto uno snapshot; la cattiva è saltata senza crash.
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.providerId).toBe(good);
  });

  it("snapshot con valori non estraibili (parse null) → NON salva nulla per quella credenziale", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "account", label: "max", secret: "o" });

    await pollUsageOnce({
      db,
      encryptionKey: ENCRYPTION_KEY,
      capture: async () => "illeggibile",
      runLlm: async () => "{{{ json rotto",
    });

    const snaps = await db.select().from(aiUsageSnapshots);
    expect(snaps).toHaveLength(0);
  });
});
