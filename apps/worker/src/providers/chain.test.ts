import { aiProviders, encrypt, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadProviderChain } from "./chain.js";

// loadProviderChain legge ai_providers ABILITATI, ordinati per position, e
// decifra il segreto di ciascuno. Una voce non decifrabile viene scartata
// (senza bloccare le altre); le disabilitate sono escluse.

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

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
  values: {
    position: number;
    kind: "api_key" | "account";
    label: string;
    secret?: string;
    secretEncrypted?: string;
    enabled?: boolean;
  },
): Promise<string> {
  const secretEncrypted =
    values.secretEncrypted ?? encrypt(values.secret ?? "secret-default", ENCRYPTION_KEY);
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: values.position,
      kind: values.kind,
      label: values.label,
      secretEncrypted,
      enabled: values.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error("insert del provider non ha restituito la riga");
  return row.id;
}

describe("loadProviderChain", () => {
  it("ordina per position e decifra il segreto di ogni voce abilitata", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 2, kind: "account", label: "seconda", secret: "oauth-2" });
    await seedProvider(db, { position: 1, kind: "api_key", label: "prima", secret: "sk-ant-1" });

    const chain = await loadProviderChain(db, ENCRYPTION_KEY);

    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ kind: "api_key", secret: "sk-ant-1" });
    expect(chain[1]).toMatchObject({ kind: "account", secret: "oauth-2" });
    // L'id è propagato (serve per ai_jobs.provider_id).
    expect(chain[0]?.id).toBeTruthy();
  });

  it("esclude i provider disabilitati", async () => {
    const { db } = testDb;
    await seedProvider(db, { position: 1, kind: "api_key", label: "off", secret: "x", enabled: false });
    await seedProvider(db, { position: 2, kind: "api_key", label: "on", secret: "y", enabled: true });

    const chain = await loadProviderChain(db, ENCRYPTION_KEY);

    expect(chain).toHaveLength(1);
    expect(chain[0]?.secret).toBe("y");
  });

  it("scarta una voce con segreto non decifrabile senza bloccare le altre", async () => {
    const { db } = testDb;
    // Posizione 1: segreto cifrato con un'ALTRA chiave → non decifrabile.
    await seedProvider(db, {
      position: 1,
      kind: "api_key",
      label: "corrotta",
      secretEncrypted: encrypt("sk-altrove", randomBytes(32)),
    });
    // Posizione 2: valida.
    await seedProvider(db, { position: 2, kind: "account", label: "valida", secret: "oauth-ok" });

    const chain = await loadProviderChain(db, ENCRYPTION_KEY);

    // La corrotta è scartata, la valida resta.
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ kind: "account", secret: "oauth-ok" });
  });

  it("catena vuota quando non ci sono provider abilitati", async () => {
    const { db } = testDb;
    const chain = await loadProviderChain(db, ENCRYPTION_KEY);
    expect(chain).toEqual([]);
  });
});
