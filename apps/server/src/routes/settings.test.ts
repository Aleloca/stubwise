import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { automationRules } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function getAutomation(cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/api/settings/automation",
    headers: cookie ? { cookie } : {},
  });
}

function putAutomation(payload: Record<string, unknown>, cookie?: string) {
  return app.inject({
    method: "PUT",
    url: "/api/settings/automation",
    headers: cookie ? { cookie } : {},
    payload,
  });
}

interface Rule {
  type: string;
  autoFix: boolean;
  maxEffort: number;
}

describe("GET /api/settings/automation", () => {
  it("senza sessione: 401", async () => {
    expect((await getAutomation()).statusCode).toBe(401);
  });

  it("member: 403 (riservato agli admin)", async () => {
    expect((await getAutomation(users.memberCookie)).statusCode).toBe(403);
  });

  it("admin: restituisce le 4 regole con i default seedati", async () => {
    const res = await getAutomation(users.adminCookie);
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(4);
    const byType = new Map(rules.map((r) => [r.type, r]));
    // Default di seed della migrazione.
    expect(byType.get("bug")).toEqual({ type: "bug", autoFix: true, maxEffort: 3 });
    expect(byType.get("task")).toEqual({ type: "task", autoFix: true, maxEffort: 2 });
    expect(byType.get("feature")).toEqual({ type: "feature", autoFix: false, maxEffort: 3 });
    expect(byType.get("feedback")).toEqual({ type: "feedback", autoFix: false, maxEffort: 3 });
  });

  it("admin: una riga mancante nel DB viene riempita con il default", async () => {
    // Rimuove la riga 'feedback': la GET deve comunque restituirne 4.
    await testDb.db.delete(automationRules).where(eq(automationRules.type, "feedback"));
    const res = await getAutomation(users.adminCookie);
    const { rules } = res.json() as { rules: Rule[] };
    expect(rules).toHaveLength(4);
    const feedback = rules.find((r) => r.type === "feedback");
    // Default difensivo: auto-fix true, max 3.
    expect(feedback).toEqual({ type: "feedback", autoFix: true, maxEffort: 3 });
  });
});

describe("PUT /api/settings/automation", () => {
  it("member: 403", async () => {
    const res = await putAutomation(
      { rules: [{ type: "bug", autoFix: false, maxEffort: 1 }] },
      users.memberCookie,
    );
    expect(res.statusCode).toBe(403);
  });

  it("admin: upsert delle regole e ritorna lo stato aggiornato", async () => {
    const res = await putAutomation(
      {
        rules: [
          { type: "bug", autoFix: false, maxEffort: 5 },
          { type: "feature", autoFix: true, maxEffort: 4 },
        ],
      },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: Rule[] };
    const byType = new Map(rules.map((r) => [r.type, r]));
    expect(byType.get("bug")).toEqual({ type: "bug", autoFix: false, maxEffort: 5 });
    expect(byType.get("feature")).toEqual({ type: "feature", autoFix: true, maxEffort: 4 });

    // Persistito: una GET successiva riflette l'upsert.
    const after = (await getAutomation(users.adminCookie)).json() as { rules: Rule[] };
    expect(after.rules.find((r) => r.type === "bug")).toEqual({
      type: "bug",
      autoFix: false,
      maxEffort: 5,
    });
  });

  it("maxEffort fuori scala 1–5 → 400", async () => {
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 6 }] },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await putAutomation(
          { rules: [{ type: "bug", autoFix: true, maxEffort: 0 }] },
          users.adminCookie,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("tipo fuori enum → 400", async () => {
    const res = await putAutomation(
      { rules: [{ type: "banana", autoFix: true, maxEffort: 3 }] },
      users.adminCookie,
    );
    expect(res.statusCode).toBe(400);
  });
});
