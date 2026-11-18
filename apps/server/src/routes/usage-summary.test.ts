import { randomUUID } from "node:crypto";
import { agentRuns, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { UsageSummary } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";
import { usageDays, usageRows } from "../services/usage-summary.js";

/**
 * Area 9, F4: AI → Usage nell'app (`GET /api/ai-usage/summary`), nella forma
 * della scheda del prototipo. R-G5: un progetto invisibile è la riga `other`.
 */
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let mine: { projectId: string; name: string; code: string };
let hiddenProjectId: string;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 5).toString("base64") });
  await seedUsers(app);
  const a = await seedRepository(db);
  const [pa] = await db.select().from(projects).where(eq(projects.id, a.projectId));
  mine = { projectId: a.projectId, name: pa!.name, code: pa!.code };
  hiddenProjectId = (await seedRepository(db)).projectId;
  const run = (projectId: string | null, model: string, cost: string, daysAgo: number) =>
    ({ phase: "fix", operation: "fix_execute", model, costUsd: cost, inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, projectId, createdAt: new Date(Date.now() - daysAgo * 86_400_000) }) as typeof agentRuns.$inferInsert;
  await db.insert(agentRuns).values([run(mine.projectId, "sonnet", "2", 0), run(mine.projectId, "opus", "5", 1), run(hiddenProjectId, "sonnet", "3", 0), run(null, "haiku", "1", 2), run(mine.projectId, "sonnet", "100", 40)]);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

async function viewer(instancePerms: string[], projectPreset: string | null) {
  const [role] = await db.insert(roles).values({ name: `U ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: instancePerms }).returning({ id: roles.id });
  const [u] = await db.insert(users).values({ email: `u-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member", instanceRoleId: role!.id }).returning({ id: users.id });
  if (projectPreset) {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, projectPreset));
    await db.insert(projectMembers).values({ projectId: mine.projectId, userId: u!.id, roleId: r!.id });
  }
  return fullSessionCookie(app, u!.id);
}
const summary = async (cookie: string, query: string) => {
  const res = await app.inject({ method: "GET", url: `/api/ai-usage/summary?${query}`, headers: { cookie } });
  return { code: res.statusCode, body: res.json() as UsageSummary };
};

describe("AI → Usage", () => {
  it("senza usage.view né project.usage.view: 403", async () => {
    expect((await summary(await viewer([], null), "days=7&groupBy=day")).code).toBe(403);
  });

  it("usage.view: per progetto il mio col nome e il codice, quello invisibile è `other` (senza nome né id), le righe senza progetto `none`; i totali contano tutto", async () => {
    const cookie = await viewer(["usage.view"], "developer");
    const { code, body } = await summary(cookie, "days=7&groupBy=project");
    expect(code).toBe(200);
    expect(body.totals).toEqual({ costUsd: 11, inputTokens: 400, outputTokens: 200, cacheReadTokens: 28, runs: 4 });
    expect(body.rows.map((r) => [r.key, r.label, r.code, r.costUsd])).toEqual([
      [mine.projectId, mine.name, mine.code, 7],
      ["other", "other", null, 3],
      ["none", "none", null, 1],
    ]);
    expect(JSON.stringify(body)).not.toContain(hiddenProjectId);
  });

  it("per modello coi sotto-gruppi per progetto: `other` anche nei figli; per giorno dal più recente; byDay un punto per OGNI giorno", async () => {
    const cookie = await viewer(["usage.view"], "developer");
    const byModel = (await summary(cookie, "days=7&groupBy=model&thenBy=project")).body;
    const sonnet = byModel.rows.find((r) => r.key === "sonnet")!;
    expect(sonnet).toMatchObject({ costUsd: 5, tokens: 300, runs: 2 });
    expect(sonnet.children.map((c) => c.key)).toEqual(["other", mine.projectId]);
    const byDay = (await summary(cookie, "days=7&groupBy=day")).body;
    expect(byDay.byDay).toHaveLength(7);
    expect(byDay.byDay.filter((d) => d.runs === 0)).toHaveLength(4);
    expect(byDay.rows.map((r) => r.key)).toEqual([...byDay.rows.map((r) => r.key)].sort().reverse());
  });

  it("chi ha solo project.usage.view vede i suoi progetti: niente righe di altri né senza progetto", async () => {
    const cookie = await viewer([], "project_lead");
    const { code, body } = await summary(cookie, "days=7&groupBy=project");
    expect(code).toBe(200);
    expect(body.rows.map((r) => r.key)).toEqual([mine.projectId]);
    expect(body.totals.costUsd).toBe(7);
  });

  it("l'intervallo: from/to oltre 366 giorni o rovesciato → 400; nessun intervallo → 400; il mese corrente", async () => {
    const cookie = await viewer(["usage.view"], null);
    expect((await summary(cookie, "from=2025-01-01&to=2026-06-01&groupBy=day")).code).toBe(400);
    expect((await summary(cookie, "from=2026-06-02&to=2026-06-01&groupBy=day")).code).toBe(400);
    expect((await summary(cookie, "groupBy=day")).code).toBe(400);
    expect((await summary(cookie, "month=1&groupBy=operation")).code).toBe(200);
  });
});

describe("le regole pure", () => {
  it("usageDays: gli ultimi N giorni compreso oggi, il mese dal primo, from/to compresi", () => {
    const now = new Date("2026-11-18T15:00:00.000Z");
    expect(usageDays({ days: 7 }, now).days).toEqual(["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(usageDays({ month: true }, now).days[0]).toBe("2026-11-01");
    expect(usageDays({ from: "2026-02-27", to: "2026-03-01" }, now).days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
  it("usageRows: due progetti invisibili diventano UNA riga `other`", () => {
    const names = { visibleProjects: new Map([["a", { name: "A", code: "AA" }]]), providers: new Map() };
    const rows = usageRows([{ a: "x", b: null, cost: 1, tokens: 10, runs: 1 }, { a: "y", b: null, cost: 2, tokens: 20, runs: 2 }, { a: "a", b: null, cost: 0.5, tokens: 5, runs: 1 }], "project", null, names);
    expect(rows.map((r) => [r.key, r.costUsd, r.runs])).toEqual([["other", 3, 3], ["a", 0.5, 1]]);
  });
});
