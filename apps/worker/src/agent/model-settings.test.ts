import { aiModelSettings, instanceSettings } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { AI_OPERATIONS, type AiOperation } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createModelResolver, writeWorkerModelDefaults } from "./model-settings.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(aiModelSettings);
});

afterAll(async () => {
  await testDb.stop();
});

describe("createModelResolver", () => {
  it("restituisce il modello della riga, e un cambio vale dalla chiamata dopo (nessuna cache)", async () => {
    const log = { warn: vi.fn() };
    const models = createModelResolver(testDb.db, log);
    expect(await models.resolve("fix_plan", "opus")).toBe("opus");

    await testDb.db.insert(aiModelSettings).values({ operation: "fix_plan", model: "claude-fable-5-1" });
    expect(await models.resolve("fix_plan", "opus")).toBe("claude-fable-5-1");

    await testDb.db
      .update(aiModelSettings)
      .set({ model: "sonnet" })
      .where(eq(aiModelSettings.operation, "fix_plan"));
    expect(await models.resolve("fix_plan", "opus")).toBe("sonnet");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("senza riga e senza fallback restituisce undefined", async () => {
    const models = createModelResolver(testDb.db, { warn: vi.fn() });
    expect(await models.resolve("summary", undefined)).toBeUndefined();
  });

  it("un valore fuori catalogo (riga vecchia) → fallback + warn", async () => {
    // Il CHECK del DB impedisce di scriverlo: la lettura è simulata.
    const log = { warn: vi.fn() };
    const models = createModelResolver(testDb.db, log, async () => "opsu");
    expect(await models.resolve("fix_execute", "sonnet")).toBe("sonnet");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toContain("opsu");
  });

  it("un errore del DB → fallback, senza lanciare", async () => {
    const log = { warn: vi.fn() };
    const models = createModelResolver(testDb.db, log, async () => {
      throw new Error("db giù");
    });
    expect(await models.resolve("fix_execute", "sonnet")).toBe("sonnet");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("writeWorkerModelDefaults", () => {
  it("scrive i default effettivi in instance_settings", async () => {
    const defaults = Object.fromEntries(AI_OPERATIONS.map((op) => [op, "haiku"])) as Record<
      AiOperation,
      string
    >;
    defaults.fix_plan = "opus";
    await writeWorkerModelDefaults(testDb.db, defaults);
    const [row] = await testDb.db
      .select({ value: instanceSettings.workerModelDefaults })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(row!.value).toEqual(defaults);
  });

  it("è best-effort: un errore non lancia", async () => {
    const broken = {
      update: () => {
        throw new Error("db giù");
      },
    } as unknown as TestDb["db"];
    await expect(
      writeWorkerModelDefaults(broken, {} as Record<AiOperation, string>, { warn: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});
