import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AI_OPERATIONS } from "@stubwise/shared";
import { aiModelSettings, changeLog, instanceSettings } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  await testDb.db.delete(aiModelSettings);
  await testDb.db.update(instanceSettings).set({ workerModelDefaults: null, workerModelEnvOperations: null });
});

const get = (cookie?: string) =>
  app.inject({ method: "GET", url: "/api/settings/models", headers: cookie ? { cookie } : {} });
const patch = (models: Record<string, unknown>, cookie?: string) =>
  app.inject({
    method: "PATCH",
    url: "/api/settings/models",
    headers: cookie ? { cookie } : {},
    payload: { models },
  });

interface Entry {
  operation: string;
  configurable: boolean;
  model: string | null;
  workerDefault: string | null;
}

describe("/api/settings/models", () => {
  it("senza sessione: 401", async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it("member: 403 e nessuna riga scritta", async () => {
    expect((await get(users.memberCookie)).statusCode).toBe(403);
    const res = await patch({ fix_execute: "claude-opus-5-5" }, users.memberCookie);
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(aiModelSettings)).toHaveLength(0);
  });

  it("GET: una voce per operazione, in ordine, workerDefault null se mancante", async () => {
    const res = await get(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { operations: Entry[]; choices: string[] };
    expect(body.operations.map((o) => o.operation)).toEqual([...AI_OPERATIONS]);
    expect(body.operations.every((o) => o.workerDefault === null && o.model === null)).toBe(true);
    expect(body.operations.find((o) => o.operation === "credential_test")?.configurable).toBe(
      false,
    );
    expect(body.operations.find((o) => o.operation === "fix_execute")?.configurable).toBe(true);
    expect(body.choices).toContain("opus");
  });

  it("GET: workerDefault dal jsonb del worker", async () => {
    await testDb.db
      .update(instanceSettings)
      .set({ workerModelDefaults: { fix_execute: "claude-sonnet-5-5" } });
    const body = (await get(users.adminCookie)).json() as { operations: Entry[] };
    expect(body.operations.find((o) => o.operation === "fix_execute")?.workerDefault).toBe(
      "claude-sonnet-5-5",
    );
    expect(body.operations.find((o) => o.operation === "triage")?.workerDefault).toBeNull();
  });

  it("PATCH: upsert con autore, poi null cancella la riga", async () => {
    const res = await patch({ fix_execute: "claude-opus-5-5" }, users.adminCookie);
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { operations: Entry[] }).operations.find((o) => o.operation === "fix_execute")
        ?.model,
    ).toBe("claude-opus-5-5");
    const rows = await testDb.db.select().from(aiModelSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedByUserId).toBe(users.adminId);

    // aggiornamento della stessa riga
    await patch({ fix_execute: "opus" }, users.adminCookie);
    expect((await testDb.db.select().from(aiModelSettings))[0]?.model).toBe("opus");

    const del = await patch({ fix_execute: null }, users.adminCookie);
    expect(del.statusCode).toBe(200);
    expect(
      await testDb.db
        .select()
        .from(aiModelSettings)
        .where(eq(aiModelSettings.operation, "fix_execute")),
    ).toHaveLength(0);
  });

  it("PATCH: operazione non configurabile -> 400, modello ignoto -> 400, nulla scritto", async () => {
    expect((await patch({ credential_test: "opus" }, users.adminCookie)).statusCode).toBe(400);
    expect((await patch({ fix_execute: "opsu" }, users.adminCookie)).statusCode).toBe(400);
    expect(
      (await patch({ fix_execute: "opus", credential_test: "opus" }, users.adminCookie)).statusCode,
    ).toBe(400);
    expect(await testDb.db.select().from(aiModelSettings)).toHaveLength(0);
  });

  it("area 9, F3: la fonte del modello — impostazione, env del worker, default di codice", async () => {
    await testDb.db.update(instanceSettings).set({ workerModelDefaults: { fix_plan: "opus", pr_review: "haiku" }, workerModelEnvOperations: ["pr_review"] });
    await patch({ triage: "sonnet" }, users.adminCookie);
    const ops = (await get(users.adminCookie)).json().operations as { operation: string; source: string }[];
    const sourceOf = (op: string) => ops.find((o) => o.operation === op)!.source;
    expect(sourceOf("triage")).toBe("setting");
    expect(sourceOf("pr_review")).toBe("env");
    expect(sourceOf("fix_plan")).toBe("default");
    // Dove riporta «Use default» (94): la fonte senza l'impostazione.
    const fallbackOf = (op: string) => (ops.find((o) => o.operation === op) as unknown as { fallbackSource: string }).fallbackSource;
    expect(fallbackOf("triage")).toBe("default");
    expect(fallbackOf("pr_review")).toBe("env");
  });

  it("area 9, F3: model.changed per ogni operazione che cambia, col modello effettivo in valore stabile", async () => {
    await testDb.db.update(instanceSettings).set({ workerModelDefaults: { fix_plan: "opus", pr_review: "haiku" }, workerModelEnvOperations: ["pr_review"] });
    // Il registro è append-only: si guardano le sole voci nuove.
    const seen = new Set((await testDb.db.select({ id: changeLog.id }).from(changeLog)).map((r) => r.id));
    const fresh = async () => (await testDb.db.select().from(changeLog).where(eq(changeLog.type, "model.changed"))).filter((r) => !seen.has(r.id));
    expect((await patch({ pr_review: "opus", fix_plan: "opus" }, users.adminCookie)).statusCode).toBe(200);
    const rows = (await fresh()).map((r) => r.data as { object: { id: string }; before: string; after: string });
    expect(rows.map((r) => [r.object.id, r.before, r.after]).sort()).toEqual([
      ["fix_plan", "default:opus", "set:opus"],
      ["pr_review", "env:haiku", "set:opus"],
    ]);
    expect((await patch({ pr_review: null }, users.adminCookie)).statusCode).toBe(200);
    const back = (await fresh()).map((r) => r.data as { before: string; after: string });
    expect(back).toContainEqual(expect.objectContaining({ before: "set:opus", after: "env:haiku" }));
    expect(back).toHaveLength(3);
  });
});
