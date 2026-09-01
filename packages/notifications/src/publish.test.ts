import {
  aiJobs,
  notificationDeliveries,
  notifications,
  notificationSettings,
  projectFollows,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationEvent } from "./format.js";
import { publishNotification } from "./publish.js";

/**
 * Test di `publishNotification` su un Postgres reale (testcontainers): la
 * pubblicazione fa un fan-out su più tabelle (inbox + outbox) con CHECK di
 * coerenza lato DB, quindi un fake `Db` non direbbe granché. Il caso "config
 * webhook" resta invece coperto anche dai test a fake di `dispatch.test.ts`.
 */

describe("publishNotification", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    // Ogni test parte da zero utenti (gli admin sono destinatari di TUTTO:
    // lasciarli accumulare falserebbe i conteggi dei test successivi), inbox
    // vuota e webhook non configurato (default della riga seedata dalla
    // migrazione). Le notifiche cascatano con l'utente; le consegne webhook non
    // hanno un utente dietro, quindi si cancellano a parte.
    await db.delete(users);
    await db.delete(notificationDeliveries);
    await db.update(notificationSettings).set({ webhookUrl: null, notifyPrOpened: true });
  });

  /** Crea un utente col ruolo dato; email univoca per chiamata. */
  async function seedUser(opts: {
    role: "admin" | "member";
    slackUserId?: string | null;
    notifySlackDm?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.com`,
        passwordHash: "hash-placeholder",
        role: opts.role,
        slackUserId: opts.slackUserId ?? null,
        notifySlackDm: opts.notifySlackDm ?? true,
      })
      .returning();
    if (!row) throw new Error("insert dell'utente di test non ha restituito la riga");
    return row.id;
  }

  /**
   * Scenario condiviso: un admin con identità Slack, un member che segue il
   * progetto (senza Slack) e un member che non lo segue.
   */
  async function seedScenario() {
    const { projectId, ticketId } = await seedTicket(db);
    const adminId = await seedUser({ role: "admin", slackUserId: `U${randomUUID().slice(0, 8)}` });
    const followerId = await seedUser({ role: "member" });
    const outsiderId = await seedUser({ role: "member" });
    await db.insert(projectFollows).values({ userId: followerId, projectId });
    return { projectId, ticketId, adminId, followerId, outsiderId };
  }

  const prOpened: NotificationEvent = {
    kind: "job.pr_opened",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    prUrl: "https://github.com/acme/repo/pull/1",
    ticketUrl: "https://stubwise.example.com/tickets/1",
    costUsd: 0.12,
  };

  const planReview: NotificationEvent = {
    kind: "job.plan_review",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    ticketUrl: "https://stubwise.example.com/tickets/1",
  };

  const awaitingInput: NotificationEvent = {
    kind: "job.awaiting_input",
    ticketNumber: 1,
    ticketTitle: "Ticket di test",
    projectName: "Progetto di test",
    ticketUrl: "https://stubwise.example.com/tickets/1",
    questionId: "0f2a1c7d-1111-4222-8333-444455556666",
    round: 1,
    question: "Invalidare tutte le sessioni o solo quella corrente?",
    options: [{ label: "Tutte" }, { label: "Solo la corrente" }],
    allowFreeText: true,
  };

  const projectPulse: NotificationEvent = {
    kind: "project.pulse",
    pulseId: "5b7c2e10-1111-4222-8333-444455556666",
    projectName: "Progetto di test",
    projectUrl: "https://stubwise.example.com/projects/p1/backlog",
    idleDays: 5,
    question: "Nessun lavoro in corso da 5 giorni. Da quale proposta partiamo?",
    options: [{ label: "Export CSV" }, { label: "Filtro per stato" }],
    recommendedIndex: 0,
    allowFreeText: false,
    proposals: [
      {
        backlogItemId: "aa11bb22-1111-4222-8333-444455556666",
        title: "Export CSV",
        urgency: "high",
        effort: 2,
        hasAnalysis: true,
      },
      {
        backlogItemId: "cc33dd44-1111-4222-8333-444455556666",
        title: "Filtro per stato",
        urgency: "medium",
        effort: 1,
        hasAnalysis: false,
      },
    ],
  };

  it("scrive una notifica per admin e follower, con evento e riferimenti", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 2 });
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(outsiderId);
    for (const row of rows) {
      expect(row.kind).toBe("job.pr_opened");
      expect(row.status).toBe("open");
      expect(row.event).toEqual(prOpened);
      expect(row.projectId).toBe(projectId);
      expect(row.ticketId).toBe(ticketId);
      expect(row.jobId).toBeNull();
      expect(row.handledAt).toBeNull();
    }
  });

  it("include l'assegnatario del ticket anche se non segue il progetto", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 3 });
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId, outsiderId].sort());
  });

  it("crea una slack_dm solo per chi ha un'identità Slack, legata alla SUA notifica", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();

    await publishNotification(db, prOpened, { projectId, ticketId });

    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery?.channel).toBe("slack_dm");
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempts).toBe(0);
    expect(delivery?.event).toBeNull();
    const adminNotification = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, adminId));
    expect(delivery?.notificationId).toBe(adminNotification[0]?.id);
  });

  it("non crea la slack_dm per l'admin che ha disattivato i DM", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    await seedUser({
      role: "admin",
      slackUserId: `U${randomUUID().slice(0, 8)}`,
      notifySlackDm: false,
    });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 1 });
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("crea una sola consegna webhook per evento quando il webhook è configurato", async () => {
    const { projectId, ticketId } = await seedScenario();
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    await publishNotification(db, prOpened, { projectId, ticketId });

    const webhooks = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.channel, "webhook"));
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.notificationId).toBeNull();
    expect(webhooks[0]?.event).toEqual(prOpened);
    expect(webhooks[0]?.status).toBe("pending");
  });

  it("non crea la consegna webhook se il toggle del kind è spento", async () => {
    const { projectId, ticketId } = await seedScenario();
    await db
      .update(notificationSettings)
      .set({ webhookUrl: "https://hooks.example.com/abc", notifyPrOpened: false });

    await publishNotification(db, prOpened, { projectId, ticketId });

    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channel, "webhook")),
    ).toHaveLength(0);
  });

  it("non crea la consegna webhook senza URL configurato", async () => {
    const { projectId, ticketId } = await seedScenario();

    await publishNotification(db, prOpened, { projectId, ticketId });

    expect(
      await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channel, "webhook")),
    ).toHaveLength(0);
  });

  it("manda job.plan_review ai soli admin, non ai follower", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();

    const result = await publishNotification(db, planReview, { projectId, ticketId });

    expect(result).toEqual({ published: 1 });
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(adminId);
    expect(rows[0]?.kind).toBe("job.plan_review");
  });

  it("manda job.awaiting_input al richiedente e agli admin, con inbox e consegne", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, requestedByUserId: outsiderId })
      .returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    const result = await publishNotification(db, awaitingInput, {
      projectId,
      ticketId,
      jobId: job.id,
    });

    // Admin + richiedente. Il follower del progetto NON riceve la domanda:
    // rispondere è una decisione, non un aggiornamento di avanzamento.
    expect(result).toEqual({ published: 2 });
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, outsiderId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(followerId);
    for (const row of rows) {
      expect(row.kind).toBe("job.awaiting_input");
      expect(row.event).toEqual(awaitingInput);
      expect(row.jobId).toBe(job.id);
    }
    // Outbox: il DM Slack del solo admin (l'unico con identità Slack) e la
    // consegna webhook d'istanza, che il toggle `notifyAwaitingInput` consente.
    const deliveries = await db.select().from(notificationDeliveries);
    const slackDm = deliveries.filter((row) => row.channel === "slack_dm");
    expect(slackDm).toHaveLength(1);
    expect(deliveries.filter((row) => row.channel === "webhook")).toHaveLength(1);
  });

  it("senza richiedente (automazione) job.awaiting_input resta ai soli admin", async () => {
    const { projectId, ticketId, adminId } = await seedScenario();
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");

    const result = await publishNotification(db, awaitingInput, {
      projectId,
      ticketId,
      jobId: job.id,
    });

    expect(result).toEqual({ published: 1 });
    const rows = await db.select().from(notifications);
    expect(rows[0]?.userId).toBe(adminId);
  });

  it("manda project.pulse ad admin e follower, senza ticket né job dietro", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    // L'outsider è ASSEGNATARIO del ticket del progetto: il pulse non è ancorato
    // a nessun ticket, quindi non deve raggiungerlo per quella via.
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, projectPulse, { projectId });

    expect(result).toEqual({ published: 2 });
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId].sort());
    expect(rows.map((row) => row.userId)).not.toContain(outsiderId);
    for (const row of rows) {
      expect(row.kind).toBe("project.pulse");
      expect(row.event).toEqual(projectPulse);
      expect(row.projectId).toBe(projectId);
      expect(row.ticketId).toBeNull();
      expect(row.jobId).toBeNull();
    }
  });

  it("inserisce DENTRO la transazione ricevuta (il rollback annulla tutto)", async () => {
    const { projectId, ticketId } = await seedScenario();

    await expect(
      db.transaction(async (tx) => {
        const result = await publishNotification(tx, prOpened, { projectId, ticketId });
        expect(result).toEqual({ published: 2 });
        throw new Error("rollback voluto");
      }),
    ).rejects.toThrow("rollback voluto");

    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("non lancia mai: con un db rotto restituisce { published: 0 }", async () => {
    const broken = {
      transaction() {
        throw new Error("connessione persa");
      },
      select() {
        throw new Error("connessione persa");
      },
      insert() {
        throw new Error("connessione persa");
      },
    } as unknown as Db;

    await expect(publishNotification(broken, prOpened, {})).resolves.toEqual({ published: 0 });
  });

  it("su errore SQL non aborta la transazione del chiamante (savepoint annidato)", async () => {
    const { ticketId } = await seedScenario();
    // Progetto inesistente: l'insert nell'inbox viola la FK su project_id. Il
    // fallimento deve restare confinato al savepoint di publishNotification.
    const projectIdFantasma = randomUUID();
    const emailDopo = `${randomUUID()}@example.com`;

    await db.transaction(async (tx) => {
      const result = await publishNotification(tx, prOpened, {
        projectId: projectIdFantasma,
        ticketId,
      });
      expect(result).toEqual({ published: 0 });
      // La transazione del chiamante è ancora usabile: se il savepoint non ci
      // fosse, qui Postgres risponderebbe "current transaction is aborted".
      await tx
        .insert(users)
        .values({ email: emailDopo, passwordHash: "hash-placeholder", role: "member" });
    });

    // Il commit del chiamante è andato a buon fine...
    expect(await db.select().from(users).where(eq(users.email, emailDopo))).toHaveLength(1);
    // ...e la pubblicazione fallita non ha lasciato righe parziali.
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });

  it("instrada verso chi ha richiesto il job e ancora le notifiche al job", async () => {
    const { projectId, ticketId, adminId, followerId, outsiderId } = await seedScenario();
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, requestedByUserId: outsiderId })
      .returning();
    if (!job) throw new Error("insert del job di test non ha restituito la riga");

    const result = await publishNotification(db, prOpened, { projectId, ticketId, jobId: job.id });

    expect(result).toEqual({ published: 3 });
    const rows = await db.select().from(notifications);
    // L'outsider non segue il progetto e non è assegnatario: arriva solo perché
    // ha lanciato lui il job.
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, followerId, outsiderId].sort());
    for (const row of rows) {
      expect(row.jobId).toBe(job.id);
    }
  });

  it("senza projectId esclude i follower ma tiene admin e persone del ticket", async () => {
    const { ticketId, adminId, outsiderId } = await seedScenario();
    await db.update(tickets).set({ assigneeId: outsiderId }).where(eq(tickets.id, ticketId));

    const result = await publishNotification(db, prOpened, { ticketId });

    expect(result).toEqual({ published: 2 });
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, outsiderId].sort());
    for (const row of rows) {
      expect(row.projectId).toBeNull();
      expect(row.ticketId).toBe(ticketId);
    }
  });

  it("scrive comunque la consegna webhook quando non c'è nessun destinatario", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    await db.update(notificationSettings).set({ webhookUrl: "https://hooks.example.com/abc" });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 0 });
    expect(await db.select().from(notifications)).toHaveLength(0);
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.channel).toBe("webhook");
    expect(deliveries[0]?.notificationId).toBeNull();
    expect(deliveries[0]?.event).toEqual(prOpened);
  });

  it("non scrive nulla se non ci sono destinatari né webhook configurato", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const memberId = await seedUser({ role: "member" });

    const result = await publishNotification(db, prOpened, { projectId, ticketId });

    expect(result).toEqual({ published: 0 });
    expect(
      await db.select().from(notifications).where(inArray(notifications.userId, [memberId])),
    ).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });
});
