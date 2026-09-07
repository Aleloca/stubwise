import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  aiJobs,
  milestones,
  notificationSettings,
  notifications,
  projectBriefs,
  projectDecisions,
  projects,
  users,
} from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0068 (fase 5 — roadmap e narrativa) applicata su un Postgres reale:
 * colonne dei riassunti, riparazione delle milestone, toggle del brief
 * settimanale, tabelle `project_briefs` e `project_decisions` coi loro vincoli,
 * e il valore enum `project.brief` inseribile in `notifications`.
 */
describe("schema: roadmap e narrativa (fase 5)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedProject(): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        ingestionKey: randomUUID(),
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  it("projects: il brief settimanale è spento di default", async () => {
    const projectId = await seedProject();

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.weeklyBriefEnabled).toBe(false);
  });

  it("notification_settings: il toggle webhook del brief nasce a true", async () => {
    const [settings] = await db.select().from(notificationSettings);
    expect(settings?.notifyBrief).toBe(true);
  });

  it("milestones: si creano senza repository, con descrizione e senza closed_at", async () => {
    const projectId = await seedProject();

    const [milestone] = await db
      .insert(milestones)
      .values({ projectId, name: "v1", description: "La prima release" })
      .returning();

    expect(milestone?.repositoryId).toBeNull();
    expect(milestone?.description).toBe("La prima release");
    expect(milestone?.closedAt).toBeNull();
  });

  it("ai_jobs.plan_summary e pr_reviews.pr_summary nascono nulli", async () => {
    const seeded = await seedTicket(db);
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId: seeded.ticketId })
      .returning();

    expect(job?.planSummary).toBeNull();
  });

  it("project_briefs: uno solo per (progetto, inizio periodo)", async () => {
    const projectId = await seedProject();
    await db
      .insert(projectBriefs)
      .values({ projectId, periodStart: "2026-08-31", periodEnd: "2026-09-06" });

    await expectSqlState(
      db
        .insert(projectBriefs)
        .values({ projectId, periodStart: "2026-08-31", periodEnd: "2026-09-06" }),
      "23505",
    );
  });

  it("project_briefs: uno stato fuori dalla lista è rifiutato dal CHECK", async () => {
    const projectId = await seedProject();

    await expectSqlState(
      db.insert(projectBriefs).values({
        projectId,
        periodStart: "2026-09-07",
        periodEnd: "2026-09-13",
        // Stato inesistente: il CHECK è l'unica difesa (status è text, non enum).
        status: "cancelled" as "queued",
      }),
      "23514",
    );
  });

  it("project_decisions: la stessa source_key nel progetto non entra due volte", async () => {
    const projectId = await seedProject();
    const questionId = randomUUID();
    await db.insert(projectDecisions).values({
      projectId,
      source: "ask_user",
      sourceKey: `question:${questionId}`,
      title: "Quale strada?",
      decision: "Quella corta",
    });

    await expectSqlState(
      db.insert(projectDecisions).values({
        projectId,
        source: "ask_user",
        sourceKey: `question:${questionId}`,
        title: "Quale strada?",
        decision: "Quella corta",
      }),
      "23505",
    );
  });

  it("project_decisions: una sorgente fuori dalla lista è rifiutata dal CHECK", async () => {
    const projectId = await seedProject();

    await expectSqlState(
      db.insert(projectDecisions).values({
        projectId,
        source: "oracolo" as "manual",
        sourceKey: `manual:${randomUUID()}`,
        title: "Decisione",
        decision: "Fatta",
      }),
      "23514",
    );
  });

  it("project_decisions: cancellare il ticket lascia viva la decisione", async () => {
    const seeded = await seedTicket(db);
    const [decision] = await db
      .insert(projectDecisions)
      .values({
        projectId: seeded.projectId,
        source: "plan_review",
        sourceKey: `plan_review:${randomUUID()}`,
        ticketId: seeded.ticketId,
        title: "Piano approvato",
        decision: "Si procede",
      })
      .returning();

    await db.execute(sql`delete from tickets where id = ${seeded.ticketId}`);

    const [row] = await db
      .select()
      .from(projectDecisions)
      .where(eq(projectDecisions.id, decision!.id));
    expect(row).toBeTruthy();
    expect(row?.ticketId).toBeNull();
  });

  it("notifications: il kind project.brief è inseribile", async () => {
    const projectId = await seedProject();
    const [user] = await db
      .insert(users)
      .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "admin" })
      .returning();

    const [row] = await db
      .insert(notifications)
      .values({
        kind: "project.brief",
        userId: user!.id,
        projectId,
        event: { kind: "project.brief", projectName: "Progetto di test" },
      })
      .returning();

    expect(row?.kind).toBe("project.brief");
  });
});
