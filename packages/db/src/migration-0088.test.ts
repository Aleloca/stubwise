import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { seedRepository, startTestDb, type TestDb } from "./testing.js";
import { aiProviders, projects } from "./schema.js";

let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 120_000);
afterAll(async () => t.stop());

describe("0088 quota degli account", () => {
  it("le due colonne esistono", async () => {
    const r = await t.db.execute<{ column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where (table_name = 'ai_providers' and column_name = 'limited_until')
         or (table_name = 'projects' and column_name = 'ai_provider_exclusive')`);
    expect([...r]).toHaveLength(2);
  });

  it("ai_provider_exclusive nasce false su un progetto esistente", async () => {
    const { projectId } = await seedRepository(t.db);
    const [p] = await t.db.select().from(projects).where(sql`${projects.id} = ${projectId}`);
    expect(p!.aiProviderExclusive).toBe(false);
  });

  it("limited_until nasce null", async () => {
    const [row] = await t.db
      .insert(aiProviders)
      .values({ position: 1, kind: "account", label: "a", secretEncrypted: "x" })
      .returning();
    expect(row!.limitedUntil).toBeNull();
  });
});
