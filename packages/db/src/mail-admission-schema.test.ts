import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { instanceSettings } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0071 (fase 6c — ammissione della posta): tre colonne nuove sul
 * singleton `instance_settings`, tutte con default, nessun enum, un solo
 * batch. Verifica che (1) la riga id=1, seedata da una migrazione precedente
 * (0013), riceva i default corretti dopo la migrazione — il caso "riga
 * PREESISTENTE prima di questa fase", non solo un DB nuovo — e (2) le
 * colonne sono scrivibili.
 *
 * I default sono un ALLARGAMENTO del perimetro di ammissione di oggi, non un
 * restringimento: `emailAdmitWorkspaceDomains` default true AGGIUNGE
 * ammissione per dominio Workspace, non toglie nulla a chi ha già regole di
 * progetto — vedi il commento nella migrazione e nello schema.
 */
describe("schema: instance_settings — ammissione della posta (fase 6c)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("la riga id=1 preesistente riceve i default corretti dopo la migrazione", async () => {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    if (!row) throw new Error("la riga id=1 dovrebbe essere seedata da una migrazione precedente");
    expect(row.emailAdmitWorkspaceDomains).toBe(true);
    expect(row.emailAdmissionDenyLabels).toEqual([
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "SPAM",
    ]);
    expect(row.emailAdmissionDenyAutomated).toBe(true);
  });

  it("una riga inserita a mano (id diverso) riceve gli stessi default", async () => {
    const [row] = await db.insert(instanceSettings).values({ id: 2 }).returning();
    if (!row) throw new Error("insert non ha restituito la riga");
    expect(row.emailAdmitWorkspaceDomains).toBe(true);
    expect(row.emailAdmissionDenyLabels).toEqual([
      "CATEGORY_PROMOTIONS",
      "CATEGORY_SOCIAL",
      "SPAM",
    ]);
    expect(row.emailAdmissionDenyAutomated).toBe(true);
  });

  it("le tre colonne sono scrivibili", async () => {
    await db
      .update(instanceSettings)
      .set({
        emailAdmitWorkspaceDomains: false,
        emailAdmissionDenyLabels: ["SPAM"],
        emailAdmissionDenyAutomated: false,
      })
      .where(eq(instanceSettings.id, 1));

    const [updated] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    expect(updated?.emailAdmitWorkspaceDomains).toBe(false);
    expect(updated?.emailAdmissionDenyLabels).toEqual(["SPAM"]);
    expect(updated?.emailAdmissionDenyAutomated).toBe(false);

    // Ripristina, per non sporcare l'ordine dei test nello stesso file.
    await db
      .update(instanceSettings)
      .set({
        emailAdmitWorkspaceDomains: true,
        emailAdmissionDenyLabels: ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
        emailAdmissionDenyAutomated: true,
      })
      .where(eq(instanceSettings.id, 1));
  });
});
