import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  activityCommits,
  activityDayRollups,
  activityDevSummaries,
  activityRecountJobs,
  activityReports,
  aiJobs,
  aiProviders,
  aiUsageSnapshots,
  attachments,
  automationRules,
  backlogItems,
  backlogJobs,
  comments,
  docGenerationJobs,
  docGenerations,
  errorGroups,
  gitAuthorsSeen,
  gitIdentities,
  instanceSettings,
  invites,
  milestones,
  notificationSettings,
  personalAccessTokens,
  projectEnvFiles,
  projectEnvVars,
  projects,
  repositories,
  savedViews,
  ticketEvents,
  ticketLinks,
  ticketRepositories,
  tickets,
  users,
} from "./schema.js";
import {
  seedGitAccount,
  seedRepository,
  seedRepositoryInProject,
  seedTicket as seedTicketRow,
  seedTicketRepository,
  startTestDb,
  type TestDb,
} from "./testing.js";

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
    const { ticketId } = await seedTicketRow(db);
    return ticketId;
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
    const [bug] = await db.select().from(automationRules).where(eq(automationRules.type, "bug"));
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
    const { projectId } = await seedRepository(db);
    return projectId;
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

    const [updated] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    expect(updated?.slackSigningSecretEncrypted).toBe("signing-blob-cifrato");
    expect(updated?.slackBotTokenEncrypted).toBe("token-blob-cifrato");
  });

  it("lascia le colonne Slack null di default su una riga effimera", async () => {
    // Riga effimera id=3 per non dipendere dallo stato di id=1.
    const [row] = await db.insert(instanceSettings).values({ id: 3 }).returning();
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
    const [seeded] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    expect(seeded?.id).toBe(1);
    expect(seeded?.contentLanguage).toBe("en");

    await db
      .update(instanceSettings)
      .set({ contentLanguage: "it" })
      .where(eq(instanceSettings.id, 1));
    const [updated] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
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

  async function insertRepository(
    testCommand: string | null,
    installCommand: string | null = null,
  ): Promise<string> {
    const { projectId } = await seedRepository(db);
    const [repository] = await db
      .insert(repositories)
      .values({
        projectId,
        name: "Repository di test",
        slug: `repo-${randomUUID()}`,
        provider: "github",
        gitAccountId: await seedGitAccount(db),
        repoUrl: "https://example.com/repo.git",
        defaultBranch: "main",
        testCommand,
        installCommand,
      })
      .returning();
    if (!repository) throw new Error("insert del repository non ha restituito la riga");
    return repository.id;
  }

  it("persiste repositories.test_command valorizzato e null", async () => {
    const withCommandId = await insertRepository("pnpm test");
    const withNullId = await insertRepository(null);

    const [withCommand] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, withCommandId));
    const [withNull] = await db.select().from(repositories).where(eq(repositories.id, withNullId));
    expect(withCommand?.testCommand).toBe("pnpm test");
    expect(withNull?.testCommand).toBeNull();
  });

  it("persiste repositories.install_command valorizzato e null", async () => {
    const withCommandId = await insertRepository(null, "pnpm install");
    const withNullId = await insertRepository(null, null);

    const [withCommand] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, withCommandId));
    const [withNull] = await db.select().from(repositories).where(eq(repositories.id, withNullId));
    expect(withCommand?.installCommand).toBe("pnpm install");
    expect(withNull?.installCommand).toBeNull();
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
    const [bug] = await db.select().from(automationRules).where(eq(automationRules.type, "bug"));
    expect(bug?.maxCostUsd).toBe("0.500000");
  });

  it("instance_settings.monthly_budget_usd default null e aggiornabile (numeric come stringa)", async () => {
    const [seeded] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    expect(seeded?.monthlyBudgetUsd).toBeNull();

    await db
      .update(instanceSettings)
      .set({ monthlyBudgetUsd: "100.000000" })
      .where(eq(instanceSettings.id, 1));
    const [updated] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
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
    const { ticketId } = await seedTicketRow(db);
    return ticketId;
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

    const [read] = await db.select().from(ticketEvents).where(eq(ticketEvents.id, inserted.id));
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

    const before = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
    expect(before.length).toBe(1);

    await db.delete(tickets).where(eq(tickets.id, ticketId));

    const after = await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId));
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

  /** Crea un progetto (gruppo) con un repository e ne restituisce gli id. */
  async function seedProject(): Promise<{ projectId: string; repositoryId: string }> {
    return seedRepository(db);
  }

  /** Crea un ticket nel progetto col numero indicato e ne restituisce l'id. */
  async function seedTicketIn(
    projectId: string,
    repositoryId: string,
    number: number,
  ): Promise<string> {
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId, number });
    return ticketId;
  }

  /** Crea un progetto con due ticket (source e target). */
  async function seedTwoTickets(): Promise<{ projectId: string; source: string; target: string }> {
    const { projectId, repositoryId } = await seedProject();
    const source = await seedTicketIn(projectId, repositoryId, 1);
    const target = await seedTicketIn(projectId, repositoryId, 2);
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
      .where(and(eq(ticketLinks.sourceTicketId, source), eq(ticketLinks.targetTicketId, target)));
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
    const { ticketId } = await seedTicketRow(db);
    return ticketId;
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

    const [updated] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
    expect(updated?.s3Endpoint).toBe("https://s3.example.com");
    expect(updated?.s3Region).toBe("eu-central-1");
    expect(updated?.s3Bucket).toBe("stubwise-attachments");
    expect(updated?.s3AccessKey).toBe("AKIAEXAMPLE");
    expect(updated?.s3SecretKeyEncrypted).toBe("blob-cifrato");
  });

  it("lascia le colonne S3 null di default sulla riga seedata", async () => {
    // Riga effimera id=2 per verificare i default null senza dipendere
    // dallo stato di id=1 (modificato da altri test del file).
    const [row] = await db.insert(instanceSettings).values({ id: 2 }).returning();
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
    const { projectId } = await seedRepository(db);
    return projectId;
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

  async function seedProject(): Promise<{ projectId: string; repositoryId: string }> {
    return seedRepository(db);
  }

  it("persiste una milestone con dueDate valorizzata (status default open)", async () => {
    const { projectId, repositoryId } = await seedProject();
    const due = new Date("2026-12-31T00:00:00.000Z");
    const [inserted] = await db
      .insert(milestones)
      .values({ projectId, repositoryId, name: "v1.0", dueDate: due })
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
    const { projectId, repositoryId } = await seedProject();
    const [inserted] = await db
      .insert(milestones)
      .values({ projectId, repositoryId, name: "backlog" })
      .returning();
    expect(inserted?.dueDate).toBeNull();
    expect(inserted?.status).toBe("open");
  });

  it("vieta due milestone omonime nello stesso progetto, ammette omonime in progetti diversi", async () => {
    const a = await seedProject();
    const b = await seedProject();
    await db
      .insert(milestones)
      .values({ projectId: a.projectId, repositoryId: a.repositoryId, name: "Sprint 1" });

    await expect(
      db
        .insert(milestones)
        .values({ projectId: a.projectId, repositoryId: a.repositoryId, name: "Sprint 1" }),
    ).rejects.toThrow();

    const [other] = await db
      .insert(milestones)
      .values({ projectId: b.projectId, repositoryId: b.repositoryId, name: "Sprint 1" })
      .returning();
    expect(other?.projectId).toBe(b.projectId);
    expect(other?.name).toBe("Sprint 1");
  });

  it("cancella in cascata le milestone quando il progetto viene eliminato", async () => {
    const { projectId, repositoryId } = await seedProject();
    await db.insert(milestones).values({ projectId, repositoryId, name: "da-cancellare" });

    const before = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
    expect(before.length).toBe(1);

    await db.delete(projects).where(eq(projects.id, projectId));

    const after = await db.select().from(milestones).where(eq(milestones.projectId, projectId));
    expect(after.length).toBe(0);
  });

  it("nulla tickets.milestoneId quando la milestone viene eliminata (set null)", async () => {
    const { projectId, repositoryId } = await seedProject();
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId, number: 1 });
    const [milestone] = await db
      .insert(milestones)
      .values({ projectId, repositoryId, name: "rilascio" })
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
 * Verifica la tabella personal_access_tokens: persistenza di un token per un
 * utente (round-trip del tokenHash, default null di lastUsedAt/expiresAt).
 */
describe("schema: personal_access_tokens", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("persiste e rilegge un personal access token", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `pat-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    const [pat] = await db
      .insert(personalAccessTokens)
      .values({ userId: user!.id, name: "laptop", tokenHash: `deadbeef-${randomUUID()}` })
      .returning();
    expect(pat!.tokenHash).toContain("deadbeef");
    expect(pat!.lastUsedAt).toBeNull();
    expect(pat!.expiresAt).toBeNull();
  });

  it("tokenHash è unique tra token diversi", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `pat-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    const tokenHash = `sha256-${randomUUID()}`;
    await db.insert(personalAccessTokens).values({ userId: user!.id, name: "primo", tokenHash });

    // Stesso sha256 → viola l'unique (un hash mappa a un solo token).
    await expect(
      db.insert(personalAccessTokens).values({ userId: user!.id, name: "duplicato", tokenHash }),
    ).rejects.toThrow();
  });

  it("cascade su delete user: i token dell'utente spariscono", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `pat-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    await db
      .insert(personalAccessTokens)
      .values({ userId: user!.id, name: "laptop", tokenHash: `sha256-${randomUUID()}` });

    await db.delete(users).where(eq(users.id, user!.id));
    const rows = await db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, user!.id));
    expect(rows).toHaveLength(0);
  });
});

/**
 * Verifica la colonna additiva `backlog_jobs.result_item_id` (migrazione 0057):
 * legame job → voce prodotta dall'intake. È NULLABLE (null finché il job non è
 * done) e la FK è `on delete set null` (cancellando l'item, il job resta ma
 * perde il riferimento).
 */
describe("schema: backlog_jobs.result_item_id", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("accoda un intake job con resultItemId null di default", async () => {
    const { projectId } = await seedRepository(db);
    const [job] = await db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { title: "Nuova idea", body: "corpo" } })
      .returning();
    if (!job) throw new Error("insert del backlog job non ha restituito la riga");
    expect(job.resultItemId).toBeNull();
  });

  it("collega il job all'item prodotto e la FK fa set null alla cancellazione dell'item", async () => {
    const { projectId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce prodotta dall'intake", source: "manual" })
      .returning();
    if (!item) throw new Error("insert della voce di backlog non ha restituito la riga");

    const [job] = await db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { title: "x", body: "y" } })
      .returning();
    if (!job) throw new Error("insert del backlog job non ha restituito la riga");

    await db.update(backlogJobs).set({ resultItemId: item.id }).where(eq(backlogJobs.id, job.id));

    const [linked] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, job.id));
    expect(linked!.resultItemId).toBe(item.id);

    // FK on delete set null: cancellando l'item, il job resta ma perde il riferimento.
    await db.delete(backlogItems).where(eq(backlogItems.id, item.id));
    const [afterDelete] = await db.select().from(backlogJobs).where(eq(backlogJobs.id, job.id));
    expect(afterDelete!.resultItemId).toBeNull();
  });
});

/**
 * Verifica le colonne additive `implementation_plan` + `origin_content`
 * (migrazione 0058) su `backlog_items` e `tickets`: entrambe NULLABLE (null di
 * default), scrivibili in update e rileggibili. Il corpo principale resta il
 * campo esistente (`backlog_items.document` / `tickets.body`): queste due sono
 * il piano di implementazione dedicato e il corpo originale preservato quando un
 * design ne sostituisce il corpo.
 */
describe("schema: implementation_plan + origin_content (backlog_items + tickets)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("lascia implementationPlan e originContent null di default su un backlog_item", async () => {
    const { projectId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce senza piano", source: "manual" })
      .returning();
    if (!item) throw new Error("insert della voce di backlog non ha restituito la riga");
    expect(item.implementationPlan).toBeNull();
    expect(item.originContent).toBeNull();
  });

  it("scrive e rilegge implementationPlan e originContent su un backlog_item", async () => {
    const { projectId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce con design", source: "manual" })
      .returning();
    if (!item) throw new Error("insert della voce di backlog non ha restituito la riga");

    await db
      .update(backlogItems)
      .set({
        implementationPlan: "## Piano\n1. Step uno\n2. Step due",
        originContent: "Corpo originale prima del design",
      })
      .where(eq(backlogItems.id, item.id));

    const [read] = await db.select().from(backlogItems).where(eq(backlogItems.id, item.id));
    expect(read?.implementationPlan).toBe("## Piano\n1. Step uno\n2. Step due");
    expect(read?.originContent).toBe("Corpo originale prima del design");
  });

  it("lascia implementationPlan e originContent null di default su un ticket", async () => {
    const { ticketId } = await seedTicketRow(db);
    const [read] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(read?.implementationPlan).toBeNull();
    expect(read?.originContent).toBeNull();
  });

  it("scrive e rilegge implementationPlan e originContent su un ticket", async () => {
    const { ticketId } = await seedTicketRow(db);

    await db
      .update(tickets)
      .set({
        implementationPlan: "## Piano di implementazione\n- Modifica A\n- Modifica B",
        originContent: "Testo originale del ticket prima del design doc",
      })
      .where(eq(tickets.id, ticketId));

    const [read] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(read?.implementationPlan).toBe("## Piano di implementazione\n- Modifica A\n- Modifica B");
    expect(read?.originContent).toBe("Testo originale del ticket prima del design doc");
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
    const { ticketId } = await seedTicketRow(db);
    return ticketId;
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
    // Stato del test della credenziale: default idle, nessuna richiesta/esito.
    expect(read?.testStatus).toBe("idle");
    expect(read?.testRequestedAt).toBeNull();
    expect(read?.testCheckedAt).toBeNull();
    expect(read?.testError).toBeNull();
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

/**
 * Verifica le tabelle dei file d'ambiente per progetto: project_env_files
 * (path, unique per (project_id, path)) e project_env_vars (key +
 * value_encrypted, unique per (file_id, key)). In particolare la cancellazione
 * in cascata: eliminando un file spariscono le sue variabili; eliminando il
 * progetto spariscono file e variabili.
 */
describe("schema: project_env_files + project_env_vars", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedProject(): Promise<{ projectId: string; repositoryId: string }> {
    return seedRepository(db);
  }

  async function seedEnvFile(repositoryId: string, path = ".env"): Promise<string> {
    const [file] = await db.insert(projectEnvFiles).values({ repositoryId, path }).returning();
    if (!file) throw new Error("insert del file env non ha restituito la riga");
    return file.id;
  }

  it("persiste un file con due variabili e le rilegge", async () => {
    const { repositoryId } = await seedProject();
    const fileId = await seedEnvFile(repositoryId, ".env");

    const [file] = await db.select().from(projectEnvFiles).where(eq(projectEnvFiles.id, fileId));
    expect(file?.repositoryId).toBe(repositoryId);
    expect(file?.path).toBe(".env");
    expect(file?.createdAt).toBeInstanceOf(Date);
    expect(file?.updatedAt).toBeInstanceOf(Date);

    await db.insert(projectEnvVars).values([
      { fileId, key: "DATABASE_URL", valueEncrypted: "blob-cifrato-1" },
      { fileId, key: "API_KEY", valueEncrypted: "blob-cifrato-2" },
    ]);

    const vars = await db.select().from(projectEnvVars).where(eq(projectEnvVars.fileId, fileId));
    expect(vars.length).toBe(2);
    const byKey = new Map(vars.map((v) => [v.key, v.valueEncrypted]));
    expect(byKey.get("DATABASE_URL")).toBe("blob-cifrato-1");
    expect(byKey.get("API_KEY")).toBe("blob-cifrato-2");
  });

  it("cancella in cascata le variabili quando il file viene eliminato", async () => {
    const { repositoryId } = await seedProject();
    const fileId = await seedEnvFile(repositoryId);
    await db.insert(projectEnvVars).values({ fileId, key: "FOO", valueEncrypted: "x" });

    const before = await db.select().from(projectEnvVars).where(eq(projectEnvVars.fileId, fileId));
    expect(before.length).toBe(1);

    await db.delete(projectEnvFiles).where(eq(projectEnvFiles.id, fileId));

    const after = await db.select().from(projectEnvVars).where(eq(projectEnvVars.fileId, fileId));
    expect(after.length).toBe(0);
  });

  it("cancella in cascata file e variabili quando il progetto viene eliminato", async () => {
    const { projectId, repositoryId } = await seedProject();
    const fileId = await seedEnvFile(repositoryId);
    await db.insert(projectEnvVars).values({ fileId, key: "BAR", valueEncrypted: "y" });

    await db.delete(projects).where(eq(projects.id, projectId));

    const files = await db
      .select()
      .from(projectEnvFiles)
      .where(eq(projectEnvFiles.repositoryId, repositoryId));
    expect(files.length).toBe(0);
    const vars = await db.select().from(projectEnvVars).where(eq(projectEnvVars.fileId, fileId));
    expect(vars.length).toBe(0);
  });

  it("vieta due file con lo stesso (repository_id, path), ammette stesso path in repository diversi", async () => {
    const a = await seedProject();
    const b = await seedProject();
    await db.insert(projectEnvFiles).values({ repositoryId: a.repositoryId, path: ".env" });

    await expect(
      db.insert(projectEnvFiles).values({ repositoryId: a.repositoryId, path: ".env" }),
    ).rejects.toThrow();

    const [other] = await db
      .insert(projectEnvFiles)
      .values({ repositoryId: b.repositoryId, path: ".env" })
      .returning();
    expect(other?.repositoryId).toBe(b.repositoryId);
    expect(other?.path).toBe(".env");
  });

  it("vieta due variabili con la stessa (file_id, key), ammette stessa key in file diversi", async () => {
    const { repositoryId } = await seedProject();
    const fileA = await seedEnvFile(repositoryId, ".env");
    const fileB = await seedEnvFile(repositoryId, ".env.local");
    await db.insert(projectEnvVars).values({ fileId: fileA, key: "TOKEN", valueEncrypted: "a" });

    await expect(
      db.insert(projectEnvVars).values({ fileId: fileA, key: "TOKEN", valueEncrypted: "b" }),
    ).rejects.toThrow();

    const [other] = await db
      .insert(projectEnvVars)
      .values({ fileId: fileB, key: "TOKEN", valueEncrypted: "c" })
      .returning();
    expect(other?.fileId).toBe(fileB);
    expect(other?.key).toBe("TOKEN");
  });
});

/**
 * Verifica il modello del fix multi-repo (Fase 3, migrazione 0035): la
 * numerazione ticket e l'ingestion_key sono salite al PROGETTO (unique); gli
 * error_groups sono per-progetto (project_id, unique fingerprint per progetto);
 * i tickets non hanno più repository_id; la nuova ticket_repositories con il suo
 * unique (ticket_id, repository_id), il default prState=open e le cascate.
 */
describe("schema: fix multi-repo (progetto: ingestion/numerazione, error_groups, ticket_repositories)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("il progetto ha ingestion_key e next_ticket_number (default 1) e i seed li valorizzano", async () => {
    const { projectId } = await seedRepository(db);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.ingestionKey).toBeTruthy();
    // next_ticket_number ha default 1 (il seed non lo tocca).
    expect(project?.nextTicketNumber).toBe(1);
  });

  it("vieta due progetti con la stessa ingestion_key (unique salita dal repo)", async () => {
    const key = randomUUID();
    await db.insert(projects).values({ name: "P1", slug: `p1-${randomUUID()}`, ingestionKey: key });

    await expect(
      db.insert(projects).values({ name: "P2", slug: `p2-${randomUUID()}`, ingestionKey: key }),
    ).rejects.toThrow();
  });

  it("le colonne ingestion_key/next_ticket_number NON esistono più su repositories", async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'repositories'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("ingestion_key");
    expect(cols).not.toContain("next_ticket_number");
    // webhook_secret invece resta sul repo (il webhook PR è per-repo).
    expect(cols).toContain("webhook_secret");
  });

  it("error_groups ha project_id e NON ha più repository_id", async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'error_groups'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("project_id");
    expect(cols).not.toContain("repository_id");
  });

  it("persiste un error_group per-progetto e lo lega al ticket", async () => {
    const { projectId } = await seedRepository(db);
    const { ticketId } = await seedTicketRow(db, {
      projectId,
      repositoryId: await seedRepositoryInProject(db, projectId),
    });
    const [eg] = await db
      .insert(errorGroups)
      .values({ projectId, fingerprint: "fp-1", ticketId })
      .returning();
    if (!eg) throw new Error("insert dell'error group non ha restituito la riga");

    const [read] = await db.select().from(errorGroups).where(eq(errorGroups.id, eg.id));
    expect(read?.projectId).toBe(projectId);
    expect(read?.ticketId).toBe(ticketId);
    expect(read?.fingerprint).toBe("fp-1");
  });

  it("unique del fingerprint è PER PROGETTO: stesso fingerprint in progetti diversi ok, duplicato nello stesso no", async () => {
    const a = await seedRepository(db);
    const b = await seedRepository(db);
    const ticketA = (
      await seedTicketRow(db, { projectId: a.projectId, repositoryId: a.repositoryId })
    ).ticketId;
    const ticketB = (
      await seedTicketRow(db, { projectId: b.projectId, repositoryId: b.repositoryId })
    ).ticketId;

    await db
      .insert(errorGroups)
      .values({ projectId: a.projectId, fingerprint: "same-fp", ticketId: ticketA });

    // Stesso fingerprint nello STESSO progetto → viola l'unique.
    await expect(
      db
        .insert(errorGroups)
        .values({ projectId: a.projectId, fingerprint: "same-fp", ticketId: ticketA }),
    ).rejects.toThrow();

    // Stesso fingerprint in un ALTRO progetto → ammesso.
    const [other] = await db
      .insert(errorGroups)
      .values({ projectId: b.projectId, fingerprint: "same-fp", ticketId: ticketB })
      .returning();
    expect(other?.projectId).toBe(b.projectId);
  });

  it("cancella in cascata gli error_groups quando il progetto viene eliminato", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId });
    await db.insert(errorGroups).values({ projectId, fingerprint: "fp-cascade", ticketId });

    const before = await db.select().from(errorGroups).where(eq(errorGroups.projectId, projectId));
    expect(before.length).toBe(1);

    await db.delete(projects).where(eq(projects.id, projectId));

    const after = await db.select().from(errorGroups).where(eq(errorGroups.projectId, projectId));
    expect(after.length).toBe(0);
  });

  it("tickets NON ha più la colonna repository_id", async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'tickets'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain("repository_id");
    expect(cols).toContain("project_id");
  });

  it("persiste una riga ticket_repositories con default prState=open e pr_url null", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId });

    const [row] = await db
      .insert(ticketRepositories)
      .values({ ticketId, repositoryId, branch: "stubwise/ticket-7" })
      .returning();
    if (!row) throw new Error("insert di ticket_repositories non ha restituito la riga");

    const [read] = await db
      .select()
      .from(ticketRepositories)
      .where(eq(ticketRepositories.id, row.id));
    expect(read?.ticketId).toBe(ticketId);
    expect(read?.repositoryId).toBe(repositoryId);
    expect(read?.branch).toBe("stubwise/ticket-7");
    expect(read?.prUrl).toBeNull();
    expect(read?.prState).toBe("open");
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it("accetta prState merged/closed_unmerged e un pr_url valorizzato", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId });
    const id = await seedTicketRepository(db, {
      ticketId,
      repositoryId,
      branch: "stubwise/ticket-9",
      prUrl: "https://example.com/pr/9",
      prState: "merged",
    });

    const [read] = await db.select().from(ticketRepositories).where(eq(ticketRepositories.id, id));
    expect(read?.prState).toBe("merged");
    expect(read?.prUrl).toBe("https://example.com/pr/9");
  });

  it("vieta due righe per lo stesso (ticket, repo) ma ammette repo diversi per lo stesso ticket", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const otherRepoId = await seedRepositoryInProject(db, projectId);
    const { ticketId } = await seedTicketRow(db, { projectId, repositoryId });

    await db
      .insert(ticketRepositories)
      .values({ ticketId, repositoryId, branch: "stubwise/ticket-1" });

    // Stesso (ticket, repo) → viola l'unique.
    await expect(
      db.insert(ticketRepositories).values({ ticketId, repositoryId, branch: "stubwise/ticket-1" }),
    ).rejects.toThrow();

    // Stesso ticket, repo diverso → ammesso (fix multi-repo).
    const [other] = await db
      .insert(ticketRepositories)
      .values({ ticketId, repositoryId: otherRepoId, branch: "stubwise/ticket-1" })
      .returning();
    expect(other?.repositoryId).toBe(otherRepoId);

    const all = await db
      .select()
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(all.length).toBe(2);
  });

  it("cancella in cascata ticket_repositories col ticket e col repository", async () => {
    // Cascata dal ticket.
    const t = await seedRepository(db);
    const tk = (await seedTicketRow(db, { projectId: t.projectId, repositoryId: t.repositoryId }))
      .ticketId;
    await seedTicketRepository(db, { ticketId: tk, repositoryId: t.repositoryId });
    await db.delete(tickets).where(eq(tickets.id, tk));
    const afterTicket = await db
      .select()
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, tk));
    expect(afterTicket.length).toBe(0);

    // Cascata dal repository.
    const r = await seedRepository(db);
    const extraRepoId = await seedRepositoryInProject(db, r.projectId);
    const tk2 = (await seedTicketRow(db, { projectId: r.projectId, repositoryId: r.repositoryId }))
      .ticketId;
    await seedTicketRepository(db, { ticketId: tk2, repositoryId: extraRepoId });
    await db.delete(repositories).where(eq(repositories.id, extraRepoId));
    const afterRepo = await db
      .select()
      .from(ticketRepositories)
      .where(eq(ticketRepositories.repositoryId, extraRepoId));
    expect(afterRepo.length).toBe(0);
  });
});

/**
 * Verifica il bootstrap dell'automazione PR Review: il seed della regola di
 * automazione per il tipo `review`, che DEVE nascere con auto_fix spento
 * (anti-loop: il ticket creato da una review non deve innescare la pipeline
 * di fix). Il seed NON è una migrazione ma vive in `runMigrations`
 * (client.ts), DOPO il migratore: drizzle esegue tutte le migrazioni pendenti
 * in un'unica transazione, e Postgres vieta l'uso di un valore enum aggiunto
 * con ALTER TYPE nella stessa transazione quando l'enum pre-esiste (il primo
 * deploy su un DB vivo fallirebbe, come accaduto con la ex-0038).
 */
describe("schema: automazione PR Review (seed automation_rules)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("il bootstrap seeda automation_rules per 'review' con auto_fix=false", async () => {
    const [row] = await db.select().from(automationRules).where(eq(automationRules.type, "review"));
    expect(row).toBeDefined();
    expect(row!.autoFix).toBe(false);
  });
});

/**
 * Verifica la migrazione "pausa sul limite di utilizzo": il nuovo valore
 * `paused` di doc_generation_status (con paused_at/pause_reason) e la colonna
 * held_reason su ai_jobs e doc_generation_jobs. La migrazione aggiunge il
 * valore enum ma NON lo usa (nessun seed/UPDATE): questi test coprono il primo
 * uso runtime dopo il commit del migratore.
 */
describe("schema: pausa sul limite (paused + held_reason)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("doc_generations accetta status paused con pausedAt/pauseReason", async () => {
    const { repositoryId } = await seedRepository(db);
    const pausedAt = new Date();
    const [inserted] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "paused", pausedAt, pauseReason: "limite di utilizzo" })
      .returning();
    if (!inserted) throw new Error("insert della generazione non ha restituito la riga");

    const [read] = await db.select().from(docGenerations).where(eq(docGenerations.id, inserted.id));
    expect(read?.status).toBe("paused");
    expect(read?.pausedAt?.getTime()).toBe(pausedAt.getTime());
    expect(read?.pauseReason).toBe("limite di utilizzo");
  });

  it("doc_generations.brief è null di default e persiste un oggetto jsonb", async () => {
    const { repositoryId } = await seedRepository(db);

    // Default: nessun brief (il run del documentarista non è ancora avvenuto o è fallito).
    const [noBrief] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running" })
      .returning();
    if (!noBrief) throw new Error("insert della generazione non ha restituito la riga");
    expect(noBrief.brief).toBeNull();

    // Con brief: l'oggetto jsonb round-trippa integralmente.
    const brief = {
      identity: "Un prodotto demo.",
      actors: [{ name: "Cliente", description: "compra", internal: false }],
      surfaces: [
        { name: "Webapp", type: "web", rootPath: "apps/web", audience: "clienti", internal: false },
      ],
      glossary: [{ term: "Ordine", definition: "una richiesta d'acquisto" }],
      invariants: ["Un ordine ha almeno una riga"],
      confidentialFacts: [],
      journeys: [{ actor: "Cliente", title: "Compra", summary: "sceglie e paga" }],
      existingSources: ["README.md"],
    };
    const [withBrief] = await db
      .insert(docGenerations)
      .values({ repositoryId, status: "running", brief })
      .returning();
    if (!withBrief) throw new Error("insert della generazione non ha restituito la riga");

    const [read] = await db
      .select()
      .from(docGenerations)
      .where(eq(docGenerations.id, withBrief.id));
    expect(read?.brief).toEqual(brief);
  });

  it("ai_jobs e doc_generation_jobs accettano held_reason (null di default)", async () => {
    const { ticketId, repositoryId } = await seedTicketRow(db);
    const [aiJob] = await db
      .insert(aiJobs)
      .values({ ticketId, status: "held", heldReason: "limit" })
      .returning();
    const [docJob] = await db
      .insert(docGenerationJobs)
      .values({ repositoryId, status: "held", heldReason: "limit" })
      .returning();
    if (!aiJob || !docJob) throw new Error("insert dei job non ha restituito la riga");

    const [aiRead] = await db.select().from(aiJobs).where(eq(aiJobs.id, aiJob.id));
    const [docRead] = await db
      .select()
      .from(docGenerationJobs)
      .where(eq(docGenerationJobs.id, docJob.id));
    expect(aiRead?.heldReason).toBe("limit");
    expect(docRead?.heldReason).toBe("limit");

    // Gli held storici (pre-migrazione) restano null: mai riaccodati.
    const [legacy] = await db.insert(aiJobs).values({ ticketId, status: "held" }).returning();
    expect(legacy?.heldReason).toBeNull();
  });
});

/**
 * Verifica lo schema del Daily Activity Report: le identità git (email unique,
 * cascade sul membro), il registro degli autori osservati, i report per
 * (progetto, giorno) con l'unique che li rende idempotenti, le entry con i
 * default jsonb/interi e la cascade dal report, oltre a users.bitbucketUsername
 * (unique, nullable) e projects.dailyReportEnabled (default false).
 */
describe("schema: daily activity report", () => {
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
      .values({ email: `git-${randomUUID()}@x.it`, passwordHash: "x", role: "member" })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  async function seedProject(): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  it("git_identities: email unique, cascade su delete user", async () => {
    const userId = await seedUser();
    const email = `dev-${randomUUID()}@x.it`;
    await db.insert(gitIdentities).values({ userId, email, authorName: "Dev" });

    // Stessa email → viola l'unique (una email mappa a un solo membro).
    await expect(db.insert(gitIdentities).values({ userId, email })).rejects.toThrow();

    await db.delete(users).where(eq(users.id, userId));
    const rows = await db.select().from(gitIdentities).where(eq(gitIdentities.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("git_authors_seen: PK email, round-trip di first/last seen", async () => {
    const email = `seen-${randomUUID()}@x.it`;
    const [inserted] = await db
      .insert(gitAuthorsSeen)
      .values({ email, authorName: "Osservato" })
      .returning();
    expect(inserted?.email).toBe(email);
    expect(inserted?.authorName).toBe("Osservato");
    expect(inserted?.firstSeenAt).toBeInstanceOf(Date);
    expect(inserted?.lastSeenAt).toBeInstanceOf(Date);

    // La PK sull'email vieta il duplicato.
    await expect(db.insert(gitAuthorsSeen).values({ email })).rejects.toThrow();
  });

  it("activity_reports: (project_id, date) unique e status default queued", async () => {
    const projectId = await seedProject();
    const [report] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14" })
      .returning();
    expect(report?.status).toBe("queued");
    expect(report?.error).toBeNull();
    expect(report?.finishedAt).toBeNull();

    // Stesso (progetto, giorno) → viola l'unique (gate notturno idempotente).
    await expect(
      db.insert(activityReports).values({ projectId, date: "2026-07-14" }),
    ).rejects.toThrow();

    // Stesso progetto, giorno diverso: ammesso.
    const [other] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-15" })
      .returning();
    expect(other?.date).toBe("2026-07-15");
  });

  it("activity_commits: default interi, unique (report,repo,sha) e cascade da report e repository", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [report] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14" })
      .returning();
    if (!report) throw new Error("insert del report non ha restituito la riga");

    // Commit-row minimale: i default (0) su additions/deletions si applicano,
    // aiDescription/authorName sono null.
    const committedAt = new Date("2026-07-14T09:00:00.000Z");
    const [minimal] = await db
      .insert(activityCommits)
      .values({
        reportId: report.id,
        repoId: repositoryId,
        sha: "abc123",
        authorEmail: "dev@x.it",
        committedAt,
        subject: "fix: bug",
      })
      .returning();
    expect(minimal?.additions).toBe(0);
    expect(minimal?.deletions).toBe(0);
    expect(minimal?.authorName).toBeNull();
    expect(minimal?.aiDescription).toBeNull();
    expect(minimal?.committedAt).toBeInstanceOf(Date);

    // Commit-row valorizzata: round-trip dei campi.
    const [full] = await db
      .insert(activityCommits)
      .values({
        reportId: report.id,
        repoId: repositoryId,
        sha: "def456",
        authorEmail: "dev2@x.it",
        authorName: "Dev Due",
        committedAt,
        subject: "feat: cosa nuova",
        additions: 42,
        deletions: 7,
        aiDescription: "## Cosa\nHa aggiunto una feature",
      })
      .returning();
    expect(full?.additions).toBe(42);
    expect(full?.deletions).toBe(7);
    expect(full?.aiDescription).toBe("## Cosa\nHa aggiunto una feature");

    // Unique (reportId, repoId, sha): stesso sha nello stesso report/repo → errore.
    await expect(
      db.insert(activityCommits).values({
        reportId: report.id,
        repoId: repositoryId,
        sha: "abc123",
        authorEmail: "dev@x.it",
        committedAt,
        subject: "fix: bug (duplicato)",
      }),
    ).rejects.toThrow();

    // Cascade: eliminando il report spariscono i suoi activity_commits.
    await db.delete(activityReports).where(eq(activityReports.id, report.id));
    const afterReportDelete = await db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.reportId, report.id));
    expect(afterReportDelete).toHaveLength(0);
  });

  it("activity_commits: cascade da delete del repository", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [report] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-07-14" })
      .returning();
    if (!report) throw new Error("insert del report non ha restituito la riga");

    await db.insert(activityCommits).values({
      reportId: report.id,
      repoId: repositoryId,
      sha: "abc123",
      authorEmail: "dev@x.it",
      committedAt: new Date("2026-07-14T09:00:00.000Z"),
      subject: "fix: bug",
    });

    // Eliminando il repository spariscono i suoi activity_commits.
    await db.delete(repositories).where(eq(repositories.id, repositoryId));
    const rows = await db
      .select()
      .from(activityCommits)
      .where(eq(activityCommits.repoId, repositoryId));
    expect(rows).toHaveLength(0);
  });

  it("users.bitbucketUsername: unique non-null, nullable duplicabile; projects.dailyReportEnabled default false", async () => {
    const username = `bb-${randomUUID()}`;
    await db
      .insert(users)
      .values({
        email: `bb1-${randomUUID()}@x.it`,
        passwordHash: "x",
        role: "member",
        bitbucketUsername: username,
      });

    // Stesso username non-null → viola l'unique.
    await expect(
      db
        .insert(users)
        .values({
          email: `bb2-${randomUUID()}@x.it`,
          passwordHash: "x",
          role: "member",
          bitbucketUsername: username,
        }),
    ).rejects.toThrow();

    // Più utenti con username null convivono (NULL ignorato dall'unique).
    const [a] = await db
      .insert(users)
      .values({ email: `bbn1-${randomUUID()}@x.it`, passwordHash: "x", role: "member" })
      .returning();
    const [b] = await db
      .insert(users)
      .values({ email: `bbn2-${randomUUID()}@x.it`, passwordHash: "x", role: "member" })
      .returning();
    expect(a?.bitbucketUsername).toBeNull();
    expect(b?.bitbucketUsername).toBeNull();

    // Il toggle report giornaliero è opt-in: default false.
    const projectId = await seedProject();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.dailyReportEnabled).toBe(false);
  });

  it("activity_reports.summary: accetta null e testo", async () => {
    const projectId = await seedProject();
    // Di default (non generato) è null.
    const [pending] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-08-01" })
      .returning();
    expect(pending?.summary).toBeNull();

    // Valorizzabile con markdown.
    const [withSummary] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-08-02", summary: "## Oggi\nHa fatto cose" })
      .returning();
    expect(withSummary?.summary).toBe("## Oggi\nHa fatto cose");
  });

  it("activity_reports.stale_commit_count: default 0 e valorizzabile", async () => {
    const projectId = await seedProject();
    // Di default (report appena creato) il contatore dei commit mancanti è 0.
    const [fresh] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-08-05" })
      .returning();
    expect(fresh?.staleCommitCount).toBe(0);

    // Il recount lo può alzare: round-trip di un valore > 0.
    const [stale] = await db
      .insert(activityReports)
      .values({ projectId, date: "2026-08-06", staleCommitCount: 3 })
      .returning();
    expect(stale?.staleCommitCount).toBe(3);
  });

  it("activity_recount_jobs: PK projectId (upsert/duplicato) e cascade su delete project", async () => {
    const projectId = await seedProject();
    const notBefore = new Date("2026-08-05T10:00:00.000Z");
    const [job] = await db
      .insert(activityRecountJobs)
      .values({ projectId, notBefore })
      .returning();
    expect(job?.projectId).toBe(projectId);
    expect(job?.notBefore).toBeInstanceOf(Date);
    expect(job?.createdAt).toBeInstanceOf(Date);

    // Stesso projectId → viola la PK (un solo job pending per progetto: il
    // webhook fa upsert su questo vincolo).
    await expect(
      db.insert(activityRecountJobs).values({ projectId, notBefore }),
    ).rejects.toThrow();

    // Cascade: eliminando il progetto sparisce il suo job di recount.
    await db.delete(projects).where(eq(projects.id, projectId));
    const rows = await db
      .select()
      .from(activityRecountJobs)
      .where(eq(activityRecountJobs.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("activity_dev_summaries: unique parziali su (date,userId) e (date,gitEmail), set null su delete user", async () => {
    const userId = await seedUser();
    const day = "2026-08-10";

    // Riassunto per membro risolto (userId).
    const [byUser] = await db
      .insert(activityDevSummaries)
      .values({ date: day, userId, summary: "riassunto membro" })
      .returning();
    expect(byUser?.userId).toBe(userId);
    expect(byUser?.gitEmail).toBeNull();

    // Duplicato (date, userId) → viola l'unique parziale.
    await expect(
      db.insert(activityDevSummaries).values({ date: day, userId, summary: "dup" }),
    ).rejects.toThrow();

    // Riassunto per email non risolta (userId null) nello stesso giorno → ok:
    // le unique parziali sono distinte e mutuamente esclusive.
    const email = `unresolved-${randomUUID()}@x.it`;
    const [byEmail] = await db
      .insert(activityDevSummaries)
      .values({ date: day, gitEmail: email, summary: "riassunto email" })
      .returning();
    expect(byEmail?.userId).toBeNull();
    expect(byEmail?.gitEmail).toBe(email);

    // Duplicato (date, gitEmail) → viola l'unique parziale sull'email.
    await expect(
      db.insert(activityDevSummaries).values({ date: day, gitEmail: email, summary: "dup email" }),
    ).rejects.toThrow();

    // Delete dell'utente → userId set null (la riga sopravvive).
    await db.delete(users).where(eq(users.id, userId));
    const [afterDelete] = await db
      .select()
      .from(activityDevSummaries)
      .where(eq(activityDevSummaries.id, byUser!.id));
    expect(afterDelete?.userId).toBeNull();
    expect(afterDelete?.summary).toBe("riassunto membro");
  });

  it("activity_day_rollups: date PK, duplicato → viola", async () => {
    const day = "2026-08-20";
    const [inserted] = await db.insert(activityDayRollups).values({ date: day }).returning();
    expect(inserted?.date).toBe(day);
    expect(inserted?.generatedAt).toBeInstanceOf(Date);

    // Stessa data → viola la PK (gating idempotente per giorno).
    await expect(db.insert(activityDayRollups).values({ date: day })).rejects.toThrow();
  });
});
