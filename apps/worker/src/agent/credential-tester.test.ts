import { aiProviders, encrypt, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunError, type AgentRunner } from "./runner.js";
import { runCredentialTestsOnce } from "./credential-tester.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const SECRET = "sk-credenziale-da-non-loggare";

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

async function seedPending(
  db: Db,
  values: { position: number; kind: "api_key" | "account"; label: string; secret?: string },
): Promise<string> {
  const [row] = await db
    .insert(aiProviders)
    .values({
      position: values.position,
      kind: values.kind,
      label: values.label,
      secretEncrypted: encrypt(values.secret ?? SECRET, ENCRYPTION_KEY),
      enabled: true,
      testStatus: "pending",
      testRequestedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("insert provider fallito");
  return row.id;
}

/** Runner fake tipato: `run` ha la firma di AgentRunner, così `mock.calls` è tipato. */
function fakeRunner(impl: AgentRunner["run"]): { run: ReturnType<typeof vi.fn<AgentRunner["run"]>> } {
  return { run: vi.fn<AgentRunner["run"]>(impl) };
}

function rowOf(db: Db, id: string) {
  return db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, id))
    .then((rows) => rows[0]);
}

describe("runCredentialTestsOnce", () => {
  it("una richiesta pending che ha successo (exit 0) → passed, testError null, testCheckedAt valorizzato", async () => {
    const { db } = testDb;
    const id = await seedPending(db, { position: 0, kind: "api_key", label: "key" });

    const runner = fakeRunner(async () => ({ output: "OK", exitCode: 0 }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    const row = await rowOf(db, id);
    expect(row!.testStatus).toBe("passed");
    expect(row!.testError).toBeNull();
    expect(row!.testCheckedAt).not.toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("inietta la credenziale risolta secondo il kind (account → ResolvedProvider con secret in chiaro)", async () => {
    const { db } = testDb;
    await seedPending(db, { position: 0, kind: "account", label: "max", secret: "oauth-tok" });

    const runner = fakeRunner(async () => ({ output: "OK", exitCode: 0 }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    expect(runner.run).toHaveBeenCalledTimes(1);
    const opts = runner.run.mock.calls[0]![0];
    expect(opts.provider?.kind).toBe("account");
    expect(opts.provider?.secret).toBe("oauth-tok");
  });

  it("exit code non-zero → failed con un messaggio (l'output dell'agente, senza il segreto)", async () => {
    const { db } = testDb;
    const id = await seedPending(db, { position: 0, kind: "api_key", label: "key" });

    // L'output dell'agente contiene il segreto: il tester DEVE redigerlo.
    const runner = fakeRunner(async () => ({
      output: `Invalid API key (${SECRET}) · Please run /login`,
      exitCode: 1,
    }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    const row = await rowOf(db, id);
    expect(row!.testStatus).toBe("failed");
    expect(row!.testError).toBeTruthy();
    // Il segreto è stato rimpiazzato (prova non tautologica della sanitizzazione).
    expect(row!.testError).not.toContain(SECRET);
    expect(row!.testError).toContain("***");
  });

  it("il runner lancia (spawn fallito) → failed, senza propagare", async () => {
    const { db } = testDb;
    const id = await seedPending(db, { position: 0, kind: "api_key", label: "key" });

    const runner = fakeRunner(async () => {
      throw new AgentRunError("Impossibile eseguire claude: ENOENT");
    });
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    const row = await rowOf(db, id);
    expect(row!.testStatus).toBe("failed");
    expect(row!.testError).toContain("claude");
  });

  it("una richiesta con secret non decifrabile → failed, e NON invoca il runner", async () => {
    const { db } = testDb;
    const [row] = await db
      .insert(aiProviders)
      .values({
        position: 0,
        kind: "api_key",
        label: "corrotta",
        secretEncrypted: "payload-non-decifrabile",
        enabled: true,
        testStatus: "pending",
        testRequestedAt: new Date(),
      })
      .returning();
    const id = row!.id;

    const runner = fakeRunner(async () => ({ output: "OK", exitCode: 0 }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    const after = await rowOf(db, id);
    expect(after!.testStatus).toBe("failed");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("ignora i provider non-pending (idle/passed/failed) e quelli disabilitati", async () => {
    const { db } = testDb;
    // idle: mai richiesto
    await db.insert(aiProviders).values({
      position: 0,
      kind: "api_key",
      label: "idle",
      secretEncrypted: encrypt(SECRET, ENCRYPTION_KEY),
      enabled: true,
    });
    // pending ma disabilitato: si testa comunque (l'admin vuole sapere se la
    // credenziale funziona PRIMA di abilitarla).
    const disabledId = await seedPending(db, { position: 1, kind: "api_key", label: "disabilitato" });
    await db.update(aiProviders).set({ enabled: false }).where(eq(aiProviders.id, disabledId));

    const runner = fakeRunner(async () => ({ output: "OK", exitCode: 0 }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    // Solo la riga pending (anche se disabilitata) è stata testata.
    expect(runner.run).toHaveBeenCalledTimes(1);
    const disabled = await rowOf(db, disabledId);
    expect(disabled!.testStatus).toBe("passed");
  });

  it("processa più richieste pending in un solo giro", async () => {
    const { db } = testDb;
    await seedPending(db, { position: 0, kind: "api_key", label: "a" });
    await seedPending(db, { position: 1, kind: "account", label: "b" });

    const runner = fakeRunner(async () => ({ output: "OK", exitCode: 0 }));
    await runCredentialTestsOnce({ db, encryptionKey: ENCRYPTION_KEY, runner });

    expect(runner.run).toHaveBeenCalledTimes(2);
    const rows = await db.select().from(aiProviders);
    expect(rows.every((r) => r.testStatus === "passed")).toBe(true);
  });
});
