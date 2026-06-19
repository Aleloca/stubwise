import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  aiJobs,
  aiProviders,
  aiUsageSnapshots,
  attachments,
  automationRules,
  comments,
  instanceSettings,
  invites,
  milestones,
  notificationSettings,
  projects,
  savedViews,
  ticketEvents,
  ticketLinks,
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
 * Verifica l'ingestion esterna lato schema: i nuovi valori 'slack' e 'webhook'
 * dell'enum ticket_source sono inseribili/rileggibili e il singleton
 * instance_settings espone le colonne cifrate slack_signing_secret_encrypted e
 * slack_bot_token_encrypted (round-trip; default null quando non impostate).
 */
describe("schema: ingestion esterna (source slack/webhook + colonne Slack)", () => {
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
    return project.id;
  }

  it("inserisce e rilegge un ticket con source 'slack'", async () => {
    const projectId = await seedProject();
    const [inserted] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Ticket da Slack",
        type: "bug",
        priority: "medium",
        source: "slack",
      })
      .returning();
    if (!inserted) throw new Error("insert del ticket non ha restituito la riga");

    const [read] = await db.select().from(tickets).where(eq(tickets.id, inserted.id));
    expect(read?.source).toBe("slack");
  });

  it("inserisce e rilegge un ticket con source 'webhook'", async () => {
    const projectId = await seedProject();
    const [inserted] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Ticket da webhook",
        type: "task",
        priority: "low",
        source: "webhook",
      })
      .returning();
    if (!inserted) throw new Error("insert del ticket non ha restituito la riga");

    const [read] = await db.select().from(tickets).where(eq(tickets.id, inserted.id));
    expect(read?.source).toBe("webhook");
  });

  it("scrive e rilegge le colonne Slack cifrate del singleton instance_settings (id=1)", async () => {
    await db
      .update(instanceSettings)
      .set({
        slackSigningSecretEncrypted: "signing-blob-cifrato",
        slackBotTokenEncrypted: "token-blob-cifrato",
      })
      .where(eq(instanceSettings.id, 1));

    const [updated] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(updated?.slackSigningSecretEncrypted).toBe("signing-blob-cifrato");
    expect(updated?.slackBotTokenEncrypted).toBe("token-blob-cifrato");
  });

  it("lascia le colonne Slack null di default su una riga effimera", async () => {
    // Riga effimera id=3 per non dipendere dallo stato di id=1.
    const [row] = await db
      .insert(instanceSettings)
      .values({ id: 3 })
      .returning();
    expect(row?.slackSigningSecretEncrypted).toBeNull();
    expect(row?.slackBotTokenEncrypted).toBeNull();
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

/**
 * Verifica le colonne aggiunte per self-repair e budget di costo: projects
 * .test_command, automation_rules.max_cost_usd, instance_settings
 * .monthly_budget_usd, notification_settings.notify_budget_held. I numeric
 * sono stringhe lato drizzle.
 */
describe("schema: self-repair e budget di costo", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function insertProject(testCommand: string | null): Promise<string> {
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
        testCommand,
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  it("persiste projects.test_command valorizzato e null", async () => {
    const withCommandId = await insertProject("pnpm test");
    const withNullId = await insertProject(null);

    const [withCommand] = await db.select().from(projects).where(eq(projects.id, withCommandId));
    const [withNull] = await db.select().from(projects).where(eq(projects.id, withNullId));
    expect(withCommand?.testCommand).toBe("pnpm test");
    expect(withNull?.testCommand).toBeNull();
  });

  it("automation_rules.max_cost_usd default null e aggiornabile (numeric come stringa)", async () => {
    const rows = await db.select().from(automationRules);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.maxCostUsd).toBeNull();
    }

    await db
      .update(automationRules)
      .set({ maxCostUsd: "0.500000" })
      .where(eq(automationRules.type, "bug"));
    const [bug] = await db
      .select()
      .from(automationRules)
      .where(eq(automationRules.type, "bug"));
    expect(bug?.maxCostUsd).toBe("0.500000");
  });

  it("instance_settings.monthly_budget_usd default null e aggiornabile (numeric come stringa)", async () => {
    const [seeded] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(seeded?.monthlyBudgetUsd).toBeNull();

    await db
      .update(instanceSettings)
      .set({ monthlyBudgetUsd: "100.000000" })
      .where(eq(instanceSettings.id, 1));
    const [updated] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(updated?.monthlyBudgetUsd).toBe("100.000000");
  });

  it("seeda notification_settings.notify_budget_held a true (id=1)", async () => {
    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.id, 1));
    expect(settings?.notifyBudgetHeld).toBe(true);
  });
});

/**
 * Verifica la tabella di audit ticket_events: persistenza di un evento con
 * actor, kind e payload jsonb; eventi di sistema con actorId null; e la
 * cancellazione in cascata col ticket.
 */
describe("schema: ticket_events (audit)", () => {
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

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `actor-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("persiste un evento con actor, kind e payload jsonb", async () => {
    const ticketId = await seedTicket();
    const actorId = await seedUser();
    const [inserted] = await db
      .insert(ticketEvents)
      .values({
        ticketId,
        actorId,
        kind: "status_changed",
        payload: { from: "open", to: "in_progress" },
      })
      .returning();
    if (!inserted) throw new Error("insert dell'evento non ha restituito la riga");

    const [read] = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.id, inserted.id));
    expect(read?.ticketId).toBe(ticketId);
    expect(read?.actorId).toBe(actorId);
    expect(read?.kind).toBe("status_changed");
    expect(read?.payload).toEqual({ from: "open", to: "in_progress" });
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("ammette eventi di sistema con actorId null e payload null", async () => {
    const ticketId = await seedTicket();
    const [inserted] = await db
      .insert(ticketEvents)
      .values({ ticketId, kind: "body_changed" })
      .returning();
    expect(inserted?.actorId).toBeNull();
    expect(inserted?.payload).toBeNull();
    expect(inserted?.kind).toBe("body_changed");
  });

  it("cancella in cascata gli eventi quando il ticket viene eliminato", async () => {
    const ticketId = await seedTicket();
    await db
      .insert(ticketEvents)
      .values({ ticketId, kind: "priority_changed", payload: { from: "low", to: "high" } });

    const before = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId));
    expect(before.length).toBe(1);

    await db.delete(tickets).where(eq(tickets.id, ticketId));

    const after = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, ticketId));
    expect(after.length).toBe(0);
  });
});

/**
 * Verifica la tabella ticket_links: insert/read di una relazione tra due
 * ticket dello stesso progetto; la cancellazione in cascata su entrambe le
 * direzioni (source e target); e l'unique su (source, target, kind) che vieta
 * il duplicato ma ammette relazioni di tipo diverso tra gli stessi ticket.
 */
describe("schema: ticket_links (relazioni tra ticket)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  /** Crea un progetto e ne restituisce l'id. */
  async function seedProject(): Promise<string> {
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
    return project.id;
  }

  /** Crea un ticket nel progetto col numero indicato e ne restituisce l'id. */
  async function seedTicket(projectId: string, number: number): Promise<string> {
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number,
        title: `Ticket ${number}`,
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
    return ticket.id;
  }

  /** Crea un progetto con due ticket (source e target). */
  async function seedTwoTickets(): Promise<{ projectId: string; source: string; target: string }> {
    const projectId = await seedProject();
    const source = await seedTicket(projectId, 1);
    const target = await seedTicket(projectId, 2);
    return { projectId, source, target };
  }

  it("persiste e rilegge un link tra due ticket dello stesso progetto", async () => {
    const { source, target } = await seedTwoTickets();
    const [inserted] = await db
      .insert(ticketLinks)
      .values({ sourceTicketId: source, targetTicketId: target, kind: "blocks" })
      .returning();
    if (!inserted) throw new Error("insert del link non ha restituito la riga");

    const [read] = await db.select().from(ticketLinks).where(eq(ticketLinks.id, inserted.id));
    expect(read?.sourceTicketId).toBe(source);
    expect(read?.targetTicketId).toBe(target);
    expect(read?.kind).toBe("blocks");
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("cancella in cascata i link quando viene eliminato il ticket source", async () => {
    const { source, target } = await seedTwoTickets();
    const [link] = await db
      .insert(ticketLinks)
      .values({ sourceTicketId: source, targetTicketId: target, kind: "relates_to" })
      .returning();
    if (!link) throw new Error("insert del link non ha restituito la riga");

    await db.delete(tickets).where(eq(tickets.id, source));

    const remaining = await db.select().from(ticketLinks).where(eq(ticketLinks.id, link.id));
    expect(remaining.length).toBe(0);
  });

  it("cancella in cascata i link quando viene eliminato il ticket target", async () => {
    const { source, target } = await seedTwoTickets();
    const [link] = await db
      .insert(ticketLinks)
      .values({ sourceTicketId: source, targetTicketId: target, kind: "parent" })
      .returning();
    if (!link) throw new Error("insert del link non ha restituito la riga");

    await db.delete(tickets).where(eq(tickets.id, target));

    const remaining = await db.select().from(ticketLinks).where(eq(ticketLinks.id, link.id));
    expect(remaining.length).toBe(0);
  });

  it("vieta il duplicato (source, target, kind) ma ammette kind diverso", async () => {
    const { source, target } = await seedTwoTickets();
    await db
      .insert(ticketLinks)
      .values({ sourceTicketId: source, targetTicketId: target, kind: "blocks" });

    // Stessa terna (source, target, kind): deve fallire sull'unique.
    await expect(
      db
        .insert(ticketLinks)
        .values({ sourceTicketId: source, targetTicketId: target, kind: "blocks" }),
    ).rejects.toThrow();

    // Stessa coppia (source, target) ma kind diverso: ammesso.
    const [other] = await db
      .insert(ticketLinks)
      .values({ sourceTicketId: source, targetTicketId: target, kind: "relates_to" })
      .returning();
    expect(other?.kind).toBe("relates_to");

    const all = await db
      .select()
      .from(ticketLinks)
      .where(
        and(eq(ticketLinks.sourceTicketId, source), eq(ticketLinks.targetTicketId, target)),
      );
    expect(all.length).toBe(2);
  });
});

/**
 * Verifica la tabella attachments e le colonne S3 del singleton
 * instance_settings: insert/read di un allegato con tutti i campi; la
 * cancellazione in cascata dal ticket e dal commento; l'unique su storage_key;
 * e la scrivibilità/leggibilità delle nuove colonne di configurazione S3.
 */
describe("schema: attachments + colonne S3 (instance_settings)", () => {
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

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `uploader-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  async function seedComment(ticketId: string): Promise<string> {
    const [comment] = await db
      .insert(comments)
      .values({ ticketId, authorType: "user", body: "commento di test" })
      .returning();
    if (!comment) throw new Error("insert del commento non ha restituito la riga");
    return comment.id;
  }

  it("persiste e rilegge un allegato con tutti i campi valorizzati", async () => {
    const ticketId = await seedTicket();
    const commentId = await seedComment(ticketId);
    const uploaderId = await seedUser();

    const [inserted] = await db
      .insert(attachments)
      .values({
        ticketId,
        commentId,
        uploaderId,
        filename: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 12345,
        storageKey: `attachments/${randomUUID()}.png`,
      })
      .returning();
    if (!inserted) throw new Error("insert dell'allegato non ha restituito la riga");

    const [read] = await db.select().from(attachments).where(eq(attachments.id, inserted.id));
    expect(read?.ticketId).toBe(ticketId);
    expect(read?.commentId).toBe(commentId);
    expect(read?.uploaderId).toBe(uploaderId);
    expect(read?.filename).toBe("screenshot.png");
    expect(read?.mimeType).toBe("image/png");
    expect(read?.sizeBytes).toBe(12345);
    expect(read?.storageKey).toBe(inserted.storageKey);
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("ammette commentId e uploaderId null", async () => {
    const ticketId = await seedTicket();
    const [inserted] = await db
      .insert(attachments)
      .values({
        ticketId,
        filename: "log.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        storageKey: `attachments/${randomUUID()}.txt`,
      })
      .returning();
    expect(inserted?.commentId).toBeNull();
    expect(inserted?.uploaderId).toBeNull();
  });

  it("cancella in cascata gli allegati quando il ticket viene eliminato", async () => {
    const ticketId = await seedTicket();
    await db.insert(attachments).values({
      ticketId,
      filename: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: `attachments/${randomUUID()}.png`,
    });

    const before = await db.select().from(attachments).where(eq(attachments.ticketId, ticketId));
    expect(before.length).toBe(1);

    await db.delete(tickets).where(eq(tickets.id, ticketId));

    const after = await db.select().from(attachments).where(eq(attachments.ticketId, ticketId));
    expect(after.length).toBe(0);
  });

  it("cancella in cascata l'allegato quando il commento collegato viene eliminato", async () => {
    const ticketId = await seedTicket();
    const commentId = await seedComment(ticketId);
    const [inserted] = await db
      .insert(attachments)
      .values({
        ticketId,
        commentId,
        filename: "b.png",
        mimeType: "image/png",
        sizeBytes: 1,
        storageKey: `attachments/${randomUUID()}.png`,
      })
      .returning();
    if (!inserted) throw new Error("insert dell'allegato non ha restituito la riga");

    await db.delete(comments).where(eq(comments.id, commentId));

    const remaining = await db.select().from(attachments).where(eq(attachments.id, inserted.id));
    expect(remaining.length).toBe(0);
  });

  it("vieta due allegati con lo stesso storage_key (unique)", async () => {
    const ticketId = await seedTicket();
    const storageKey = `attachments/${randomUUID()}.png`;
    await db.insert(attachments).values({
      ticketId,
      filename: "c.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey,
    });

    await expect(
      db.insert(attachments).values({
        ticketId,
        filename: "d.png",
        mimeType: "image/png",
        sizeBytes: 1,
        storageKey,
      }),
    ).rejects.toThrow();
  });

  it("scrive e rilegge le colonne S3 del singleton instance_settings (id=1)", async () => {
    await db
      .update(instanceSettings)
      .set({
        s3Endpoint: "https://s3.example.com",
        s3Region: "eu-central-1",
        s3Bucket: "stubwise-attachments",
        s3AccessKey: "AKIAEXAMPLE",
        s3SecretKeyEncrypted: "blob-cifrato",
      })
      .where(eq(instanceSettings.id, 1));

    const [updated] = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    expect(updated?.s3Endpoint).toBe("https://s3.example.com");
    expect(updated?.s3Region).toBe("eu-central-1");
    expect(updated?.s3Bucket).toBe("stubwise-attachments");
    expect(updated?.s3AccessKey).toBe("AKIAEXAMPLE");
    expect(updated?.s3SecretKeyEncrypted).toBe("blob-cifrato");
  });

  it("lascia le colonne S3 null di default sulla riga seedata", async () => {
    // Riga effimera id=2 per verificare i default null senza dipendere
    // dallo stato di id=1 (modificato da altri test del file).
    const [row] = await db
      .insert(instanceSettings)
      .values({ id: 2 })
      .returning();
    expect(row?.s3Endpoint).toBeNull();
    expect(row?.s3Region).toBeNull();
    expect(row?.s3Bucket).toBeNull();
    expect(row?.s3AccessKey).toBeNull();
    expect(row?.s3SecretKeyEncrypted).toBeNull();
  });
});

/**
 * Verifica la ricerca full-text: la colonna generata `tickets.search_tsv`
 * (titolo + corpo) matchata via `@@ websearch_to_tsquery`, lo stemming inglese
 * (forme flesse) e l'indice GIN espressivo sul corpo dei commenti.
 */
describe("schema: ricerca full-text (tsvector + GIN)", () => {
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
    return project.id;
  }

  it("trova un ticket cercando una parola presente solo nel corpo (non nel titolo)", async () => {
    const projectId = await seedProject();
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Login",
        body: "the checkout crashes",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${tickets} where ${tickets.id} = ${ticket.id} and search_tsv @@ websearch_to_tsquery('english', 'checkout')`,
    );
    expect(rows.map((r) => r.id)).toContain(ticket.id);

    // Sanity: una parola assente da titolo+corpo non matcha.
    const none = await db.execute<{ id: string }>(
      sql`select id from ${tickets} where ${tickets.id} = ${ticket.id} and search_tsv @@ websearch_to_tsquery('english', 'database')`,
    );
    expect(none.length).toBe(0);
  });

  it("trova un ticket cercando una parola presente solo nel titolo (non nel corpo)", async () => {
    const projectId = await seedProject();
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Pagination broken",
        body: "the checkout crashes",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${tickets} where ${tickets.id} = ${ticket.id} and search_tsv @@ websearch_to_tsquery('english', 'pagination')`,
    );
    expect(rows.map((r) => r.id)).toContain(ticket.id);
  });

  it("matcha una forma flessa grazie allo stemming inglese (crashing → crashes)", async () => {
    const projectId = await seedProject();
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Login",
        body: "the checkout crashes",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${tickets} where ${tickets.id} = ${ticket.id} and search_tsv @@ websearch_to_tsquery('english', 'crashing')`,
    );
    expect(rows.map((r) => r.id)).toContain(ticket.id);
  });

  it("trova un commento per il suo corpo via indice espressivo full-text", async () => {
    const projectId = await seedProject();
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number: 1,
        title: "Ticket di test",
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");

    const [comment] = await db
      .insert(comments)
      .values({
        ticketId: ticket.id,
        authorType: "user",
        body: "The deployment pipeline is failing intermittently",
      })
      .returning();
    if (!comment) throw new Error("insert del commento non ha restituito la riga");

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${comments} where ${comments.id} = ${comment.id} and to_tsvector('english', body) @@ websearch_to_tsquery('english', 'deploy')`,
    );
    expect(rows.map((r) => r.id)).toContain(comment.id);
  });
});

/**
 * Verifica la tabella milestones e la colonna tickets.milestone_id: insert/read
 * con dueDate valorizzata e null (status default open); l'unique (project_id,
 * name) che vieta omonimie nello stesso progetto ma ammette lo stesso nome in
 * progetti diversi; la cancellazione in cascata dal progetto; e l'ON DELETE set
 * null su tickets.milestone_id (il ticket sopravvive alla milestone).
 */
describe("schema: milestones + tickets.milestoneId", () => {
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
    return project.id;
  }

  async function seedTicket(projectId: string, number: number): Promise<string> {
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId,
        number,
        title: `Ticket ${number}`,
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");
    return ticket.id;
  }

  it("persiste una milestone con dueDate valorizzata (status default open)", async () => {
    const projectId = await seedProject();
    const due = new Date("2026-12-31T00:00:00.000Z");
    const [inserted] = await db
      .insert(milestones)
      .values({ projectId, name: "v1.0", dueDate: due })
      .returning();
    if (!inserted) throw new Error("insert della milestone non ha restituito la riga");

    const [read] = await db.select().from(milestones).where(eq(milestones.id, inserted.id));
    expect(read?.projectId).toBe(projectId);
    expect(read?.name).toBe("v1.0");
    expect(read?.status).toBe("open");
    expect(read?.dueDate).toBeInstanceOf(Date);
    expect(read?.dueDate?.toISOString()).toBe(due.toISOString());
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("ammette dueDate null", async () => {
    const projectId = await seedProject();
    const [inserted] = await db
      .insert(milestones)
      .values({ projectId, name: "backlog" })
      .returning();
    expect(inserted?.dueDate).toBeNull();
    expect(inserted?.status).toBe("open");
  });

  it("vieta due milestone omonime nello stesso progetto, ammette omonime in progetti diversi", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    await db.insert(milestones).values({ projectId: projectA, name: "Sprint 1" });

    await expect(
      db.insert(milestones).values({ projectId: projectA, name: "Sprint 1" }),
    ).rejects.toThrow();

    const [other] = await db
      .insert(milestones)
      .values({ projectId: projectB, name: "Sprint 1" })
      .returning();
    expect(other?.projectId).toBe(projectB);
    expect(other?.name).toBe("Sprint 1");
  });

  it("cancella in cascata le milestone quando il progetto viene eliminato", async () => {
    const projectId = await seedProject();
    await db.insert(milestones).values({ projectId, name: "da-cancellare" });

    const before = await db
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, projectId));
    expect(before.length).toBe(1);

    await db.delete(projects).where(eq(projects.id, projectId));

    const after = await db
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, projectId));
    expect(after.length).toBe(0);
  });

  it("nulla tickets.milestoneId quando la milestone viene eliminata (set null)", async () => {
    const projectId = await seedProject();
    const ticketId = await seedTicket(projectId, 1);
    const [milestone] = await db
      .insert(milestones)
      .values({ projectId, name: "rilascio" })
      .returning();
    if (!milestone) throw new Error("insert della milestone non ha restituito la riga");

    await db.update(tickets).set({ milestoneId: milestone.id }).where(eq(tickets.id, ticketId));
    const [assigned] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(assigned?.milestoneId).toBe(milestone.id);

    await db.delete(milestones).where(eq(milestones.id, milestone.id));

    const [survived] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(survived?.id).toBe(ticketId);
    expect(survived?.milestoneId).toBeNull();
  });
});

/**
 * Verifica la tabella saved_views: round-trip dell'oggetto jsonb `filters`;
 * il default false di `shared`; l'unique (owner_id, name); e la cancellazione
 * in cascata dall'utente proprietario.
 */
describe("schema: saved_views", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `owner-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("persiste e rilegge una saved_view con filters jsonb non banale (shared default false)", async () => {
    const ownerId = await seedUser();
    const filters = {
      status: "open",
      type: "bug",
      priority: "high",
      assigneeId: randomUUID(),
      milestoneId: randomUUID(),
      q: "checkout crash",
    };
    const [inserted] = await db
      .insert(savedViews)
      .values({ ownerId, name: "I miei bug aperti", filters })
      .returning();
    if (!inserted) throw new Error("insert della saved_view non ha restituito la riga");

    const [read] = await db.select().from(savedViews).where(eq(savedViews.id, inserted.id));
    expect(read?.ownerId).toBe(ownerId);
    expect(read?.name).toBe("I miei bug aperti");
    expect(read?.shared).toBe(false);
    expect(read?.filters).toEqual(filters);
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("vieta due saved_view omonime per lo stesso owner, ammette omonime per owner diversi", async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    await db.insert(savedViews).values({ ownerId: ownerA, name: "Vista", filters: {} });

    await expect(
      db.insert(savedViews).values({ ownerId: ownerA, name: "Vista", filters: {} }),
    ).rejects.toThrow();

    const [other] = await db
      .insert(savedViews)
      .values({ ownerId: ownerB, name: "Vista", filters: {} })
      .returning();
    expect(other?.ownerId).toBe(ownerB);
  });

  it("cancella in cascata le saved_view quando l'utente proprietario viene eliminato", async () => {
    const ownerId = await seedUser();
    await db.insert(savedViews).values({ ownerId, name: "da-cancellare", filters: {} });

    const before = await db.select().from(savedViews).where(eq(savedViews.ownerId, ownerId));
    expect(before.length).toBe(1);

    await db.delete(users).where(eq(users.id, ownerId));

    const after = await db.select().from(savedViews).where(eq(savedViews.ownerId, ownerId));
    expect(after.length).toBe(0);
  });
});

/**
 * Verifica le colonne di identità Slack: users.slack_user_id (unique, nullable)
 * + users.slack_avatar_url, e invites.slack_user_id (NON unique) +
 * invites.slack_avatar_url. In particolare l'unique su users.slack_user_id
 * vieta due membri con lo stesso id Slack non-null ma ammette più membri con
 * id Slack null (semantica NULL di Postgres), mentre gli inviti possono
 * condividere lo stesso id Slack.
 */
describe("schema: identità Slack (users + invites)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("persiste e rilegge un utente con slackUserId e slackAvatarUrl", async () => {
    const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const [inserted] = await db
      .insert(users)
      .values({
        email: `slack-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId,
        slackAvatarUrl: "https://avatars.slack-edge.com/abc.png",
      })
      .returning();
    if (!inserted) throw new Error("insert dell'utente non ha restituito la riga");

    const [read] = await db.select().from(users).where(eq(users.id, inserted.id));
    expect(read?.slackUserId).toBe(slackUserId);
    expect(read?.slackAvatarUrl).toBe("https://avatars.slack-edge.com/abc.png");
  });

  it("lascia slackUserId e slackAvatarUrl null di default", async () => {
    const [inserted] = await db
      .insert(users)
      .values({
        email: `noslack-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    expect(inserted?.slackUserId).toBeNull();
    expect(inserted?.slackAvatarUrl).toBeNull();
  });

  it("vieta due utenti con lo stesso slackUserId non-null (unique)", async () => {
    const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    await db.insert(users).values({
      email: `dup1-${randomUUID()}@example.com`,
      passwordHash: "x",
      role: "member",
      slackUserId,
    });

    await expect(
      db.insert(users).values({
        email: `dup2-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId,
      }),
    ).rejects.toThrow();
  });

  it("ammette più utenti con slackUserId null (NULL non viola l'unique in Postgres)", async () => {
    const [a] = await db
      .insert(users)
      .values({
        email: `null1-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId: null,
      })
      .returning();
    const [b] = await db
      .insert(users)
      .values({
        email: `null2-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
        slackUserId: null,
      })
      .returning();
    expect(a?.slackUserId).toBeNull();
    expect(b?.slackUserId).toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  it("persiste e rilegge un invito con slackUserId e slackAvatarUrl", async () => {
    const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const token = randomUUID();
    const [inserted] = await db
      .insert(invites)
      .values({
        token,
        email: `invite-${randomUUID()}@example.com`,
        expiresAt: new Date(Date.now() + 86_400_000),
        slackUserId,
        slackAvatarUrl: "https://avatars.slack-edge.com/def.png",
      })
      .returning();
    if (!inserted) throw new Error("insert dell'invito non ha restituito la riga");

    const [read] = await db.select().from(invites).where(eq(invites.token, token));
    expect(read?.slackUserId).toBe(slackUserId);
    expect(read?.slackAvatarUrl).toBe("https://avatars.slack-edge.com/def.png");
  });

  it("ammette due inviti con lo stesso slackUserId (invites NON ha unique)", async () => {
    const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const [a] = await db
      .insert(invites)
      .values({
        token: randomUUID(),
        email: `inv-a-${randomUUID()}@example.com`,
        expiresAt: new Date(Date.now() + 86_400_000),
        slackUserId,
      })
      .returning();
    const [b] = await db
      .insert(invites)
      .values({
        token: randomUUID(),
        email: `inv-b-${randomUUID()}@example.com`,
        expiresAt: new Date(Date.now() + 86_400_000),
        slackUserId,
      })
      .returning();
    expect(a?.slackUserId).toBe(slackUserId);
    expect(b?.slackUserId).toBe(slackUserId);
    expect(a?.token).not.toBe(b?.token);
  });
});

/**
 * Verifica le tabelle dei provider AI: ai_providers (credenziale cifrata,
 * posizione, enabled, kind), ai_usage_snapshots (round-trip jsonb dei residui
 * di sessione/settimana, source, parseOk, rawText) e la colonna
 * ai_jobs.provider_id. In particolare le due FK con politiche diverse: ai_jobs
 * .provider_id ON DELETE SET NULL (il job sopravvive al provider), mentre gli
 * ai_usage_snapshots cadono in cascata col provider.
 */
describe("schema: ai_providers + ai_usage_snapshots + ai_jobs.providerId", () => {
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

  async function seedProvider(
    overrides: Partial<typeof aiProviders.$inferInsert> = {},
  ): Promise<string> {
    const [provider] = await db
      .insert(aiProviders)
      .values({
        position: 0,
        kind: "api_key",
        label: `Provider ${randomUUID()}`,
        secretEncrypted: "blob-cifrato",
        ...overrides,
      })
      .returning();
    if (!provider) throw new Error("insert del provider non ha restituito la riga");
    return provider.id;
  }

  it("persiste e rilegge un provider (secret, position, enabled default true, kind)", async () => {
    const providerId = await seedProvider({ position: 2, kind: "account", label: "Claude Max" });

    const [read] = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId));
    expect(read?.position).toBe(2);
    expect(read?.kind).toBe("account");
    expect(read?.label).toBe("Claude Max");
    expect(read?.secretEncrypted).toBe("blob-cifrato");
    expect(read?.enabled).toBe(true);
    expect(read?.createdAt).toBeInstanceOf(Date);
    expect(read?.updatedAt).toBeInstanceOf(Date);
  });

  it("accetta enabled=false e kind=api_key", async () => {
    const providerId = await seedProvider({ kind: "api_key", enabled: false });
    const [read] = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId));
    expect(read?.kind).toBe("api_key");
    expect(read?.enabled).toBe(false);
  });

  it("persiste uno snapshot con round-trip jsonb, source, parseOk, rawText", async () => {
    const providerId = await seedProvider();
    const sessionRemaining = { percent: 42, used: 58, window: "5h" };
    const weeklyRemaining = { percent: 80, resetsIn: "3d" };
    const sessionResetAt = new Date("2026-07-01T10:00:00.000Z");
    const weeklyResetAt = new Date("2026-07-05T10:00:00.000Z");

    const [inserted] = await db
      .insert(aiUsageSnapshots)
      .values({
        providerId,
        sessionRemaining,
        weeklyRemaining,
        sessionResetAt,
        weeklyResetAt,
        source: "deterministic",
        parseOk: true,
        rawText: "Session: 42% remaining",
      })
      .returning();
    if (!inserted) throw new Error("insert dello snapshot non ha restituito la riga");

    const [read] = await db
      .select()
      .from(aiUsageSnapshots)
      .where(eq(aiUsageSnapshots.id, inserted.id));
    expect(read?.providerId).toBe(providerId);
    expect(read?.sessionRemaining).toEqual(sessionRemaining);
    expect(read?.weeklyRemaining).toEqual(weeklyRemaining);
    expect(read?.sessionResetAt?.toISOString()).toBe(sessionResetAt.toISOString());
    expect(read?.weeklyResetAt?.toISOString()).toBe(weeklyResetAt.toISOString());
    expect(read?.source).toBe("deterministic");
    expect(read?.parseOk).toBe(true);
    expect(read?.rawText).toBe("Session: 42% remaining");
    expect(read?.capturedAt).toBeInstanceOf(Date);
  });

  it("ammette uno snapshot llm_fallback con jsonb/reset null e rawText null (parseOk false)", async () => {
    const providerId = await seedProvider();
    const [inserted] = await db
      .insert(aiUsageSnapshots)
      .values({ providerId, source: "llm_fallback", parseOk: false })
      .returning();
    expect(inserted?.source).toBe("llm_fallback");
    expect(inserted?.parseOk).toBe(false);
    expect(inserted?.sessionRemaining).toBeNull();
    expect(inserted?.weeklyRemaining).toBeNull();
    expect(inserted?.sessionResetAt).toBeNull();
    expect(inserted?.weeklyResetAt).toBeNull();
    expect(inserted?.rawText).toBeNull();
  });

  it("ai_jobs.provider_id default null e assegnabile a un provider", async () => {
    const ticketId = await seedTicket();
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    expect(job?.providerId).toBeNull();

    const providerId = await seedProvider();
    await db.update(aiJobs).set({ providerId }).where(eq(aiJobs.id, job!.id));
    const [updated] = await db.select().from(aiJobs).where(eq(aiJobs.id, job!.id));
    expect(updated?.providerId).toBe(providerId);
  });

  it("nulla ai_jobs.provider_id quando il provider viene eliminato (set null)", async () => {
    const ticketId = await seedTicket();
    const providerId = await seedProvider();
    const [job] = await db.insert(aiJobs).values({ ticketId, providerId }).returning();
    if (!job) throw new Error("insert del job non ha restituito la riga");
    expect(job.providerId).toBe(providerId);

    await db.delete(aiProviders).where(eq(aiProviders.id, providerId));

    const [survived] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(survived?.id).toBe(job.id);
    expect(survived?.providerId).toBeNull();
  });

  it("cancella in cascata gli ai_usage_snapshots quando il provider viene eliminato", async () => {
    const providerId = await seedProvider();
    await db
      .insert(aiUsageSnapshots)
      .values({ providerId, source: "deterministic", parseOk: true });

    const before = await db
      .select()
      .from(aiUsageSnapshots)
      .where(eq(aiUsageSnapshots.providerId, providerId));
    expect(before.length).toBe(1);

    await db.delete(aiProviders).where(eq(aiProviders.id, providerId));

    const after = await db
      .select()
      .from(aiUsageSnapshots)
      .where(eq(aiUsageSnapshots.providerId, providerId));
    expect(after.length).toBe(0);
  });
});
