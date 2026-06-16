import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  aiJobs,
  automationRules,
  instanceSettings,
  notificationSettings,
  projects,
  tickets,
  users,
} from "./schema.js";
import { seedGitAccount, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del loop di feedback AI sia applicabile su un
 * Postgres reale e che le nuove colonne/enum esistano e siano scrivibili:
 * i nuovi valori di ai_job_status, l'enum resume_mode, plan_text,
 * plan_approval_min_effort e i toggle di notifica.
 */
describe("schema: loop di feedback AI", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedTicket(): Promise<string> {
    const gitAccountId = await seedGitAccount(db);
    const [project] = await db
      .insert(projects)
      .values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        provider: "github",
        gitAccountId,
        repoUrl: "https://example.com/repo.git",
        defaultBranch: "main",
        ingestionKey: randomUUID(),
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId: project.id,
        number: 1,
        title: "Ticket di test",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
    return ticket.id;
  }

  it("persiste un job in awaiting_plan_approval con resume_mode e plan_text", async () => {
    const ticketId = await seedTicket();
    const [inserted] = await db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_plan_approval",
        resumeMode: "execute",
        planText: "x",
      })
      .returning();
    if (!inserted) throw new Error("insert del job non ha restituito la riga");

    const [read] = await db.select().from(aiJobs).where(eq(aiJobs.id, inserted.id));
    expect(read?.status).toBe("awaiting_plan_approval");
    expect(read?.resumeMode).toBe("execute");
    expect(read?.planText).toBe("x");
  });

  it("accetta il nuovo stato pr_closed e resume_mode=fix", async () => {
    const ticketId = await seedTicket();
    const [inserted] = await db
      .insert(aiJobs)
      .values({ ticketId, status: "pr_closed", resumeMode: "fix" })
      .returning();
    expect(inserted?.status).toBe("pr_closed");
    expect(inserted?.resumeMode).toBe("fix");
  });

  it("lascia resume_mode e plan_text null di default", async () => {
    const ticketId = await seedTicket();
    const [inserted] = await db.insert(aiJobs).values({ ticketId }).returning();
    expect(inserted?.resumeMode).toBeNull();
    expect(inserted?.planText).toBeNull();
  });

  it("espone plan_approval_min_effort su automation_rules (default null dalle righe seedate)", async () => {
    const rows = await db.select().from(automationRules);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.planApprovalMinEffort).toBeNull();
    }

    await db
      .update(automationRules)
      .set({ planApprovalMinEffort: 3 })
      .where(eq(automationRules.type, "bug"));
    const [bug] = await db
      .select()
      .from(automationRules)
      .where(eq(automationRules.type, "bug"));
    expect(bug?.planApprovalMinEffort).toBe(3);
  });

  it("seeda i nuovi toggle di notifica a true", async () => {
    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.id, 1));
    expect(settings?.notifyPrClosed).toBe(true);
    expect(settings?.notifyPlanReview).toBe(true);
  });
});

/**
 * Verifica lo schema i18n: la colonna users.language (default 'en', valore
 * 'it') e il singleton instance_settings (riga id=1 seedata con
 * content_language='en', aggiornabile a 'it').
 */
describe("schema: i18n (users.language + instance_settings)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("crea un user con language default 'en'", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: `default-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    expect(user?.language).toBe("en");
  });

  it("crea un user con language 'it'", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: `it-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "admin",
        language: "it",
      })
      .returning();
    expect(user?.language).toBe("it");
  });

  it("seeda instance_settings id=1 con content_language='en' e lo aggiorna a 'it'", async () => {
    const [seeded] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(seeded?.id).toBe(1);
    expect(seeded?.contentLanguage).toBe("en");

    await db
      .update(instanceSettings)
      .set({ contentLanguage: "it" })
      .where(eq(instanceSettings.id, 1));
    const [updated] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(updated?.contentLanguage).toBe("it");
  });
});
