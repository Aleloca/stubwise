import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  aiJobs,
  automationRules,
  comments,
  instanceSettings,
  notificationSettings,
  projects,
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
