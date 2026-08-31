import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  aiJobs,
  notificationDeliveries,
  notifications,
  projectFollows,
  projects,
  users,
} from "./schema.js";
import { seedTicket as seedTicketRow, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione delle fondamenta dell'inbox (colonne su `ai_jobs`
 * e `users`, `notifications`, `notification_deliveries`, `project_follows`) sia
 * applicabile su un Postgres reale: default delle colonne nuove, una notifica
 * per utente sullo stesso job, outbox per canale (riga di webhook senza
 * notifica associata), enum degli stati di consegna e chiave composta dei
 * progetti seguiti.
 */
describe("schema: fondamenta dell'inbox di notifiche", () => {
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
        email: `destinatario-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("ai_jobs: requestedByUserId nullable e planApprovalRequired default false", async () => {
    const { ticketId } = await seedTicketRow(db);

    const [automatico] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!automatico) throw new Error("insert del job automatico non ha restituito la riga");
    // Job nato dall'ingest: nessun operatore dietro, nessuna approvazione del piano.
    expect(automatico.requestedByUserId).toBeNull();
    expect(automatico.planApprovalRequired).toBe(false);

    const operatorId = await seedUser();
    const [manuale] = await db
      .insert(aiJobs)
      .values({
        ticketId,
        manualTrigger: true,
        requestedByUserId: operatorId,
        planApprovalRequired: true,
      })
      .returning();
    if (!manuale) throw new Error("insert del job manuale non ha restituito la riga");
    expect(manuale.requestedByUserId).toBe(operatorId);
    expect(manuale.planApprovalRequired).toBe(true);

    // Il job sopravvive all'eliminazione dell'utente che l'ha richiesto.
    await db.delete(users).where(eq(users.id, operatorId));
    const [dopoDelete] = await db.select().from(aiJobs).where(eq(aiJobs.id, manuale.id));
    expect(dopoDelete?.requestedByUserId).toBeNull();
  });

  it("users: notifySlackDm default true", async () => {
    const userId = await seedUser();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("read dell'utente non ha restituito la riga");
    expect(user.notifySlackDm).toBe(true);
  });

  it("una notifica per destinatario sullo stesso job, rileggibile per job_id", async () => {
    const { projectId, ticketId } = await seedTicketRow(db);
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!job) throw new Error("insert del job non ha restituito la riga");
    const primo = await seedUser();
    const secondo = await seedUser();

    const event = {
      kind: "job.plan_review",
      ticketNumber: 1,
      ticketTitle: "Ticket di test",
      ticketUrl: "https://example.com/tickets/1",
    };
    const inserite = await db
      .insert(notifications)
      .values([
        { userId: primo, projectId, ticketId, jobId: job.id, kind: "job.plan_review", event },
        { userId: secondo, projectId, ticketId, jobId: job.id, kind: "job.plan_review", event },
      ])
      .returning();

    expect(inserite).toHaveLength(2);
    const [prima] = inserite;
    if (!prima) throw new Error("insert delle notifiche non ha restituito le righe");
    expect(prima.status).toBe("open");
    expect(prima.snoozedUntil).toBeNull();
    expect(prima.readAt).toBeNull();
    expect(prima.handledAt).toBeNull();
    expect(prima.handledByUserId).toBeNull();
    expect(prima.event).toEqual(event);
    expect(prima.createdAt).toBeInstanceOf(Date);

    // Il fan-in dell'inbox: dal job si risale a tutti i destinatari avvisati.
    const perJob = await db.select().from(notifications).where(eq(notifications.jobId, job.id));
    expect(perJob.map((row) => row.userId).sort()).toEqual([primo, secondo].sort());
  });

  it("la notifica cascata sul delete dell'utente destinatario", async () => {
    const { projectId, ticketId } = await seedTicketRow(db);
    const userId = await seedUser();
    const [notifica] = await db
      .insert(notifications)
      .values({
        userId,
        projectId,
        ticketId,
        kind: "ticket.created",
        event: { kind: "ticket.created" },
      })
      .returning();
    if (!notifica) throw new Error("insert della notifica non ha restituito la riga");

    await db.delete(users).where(eq(users.id, userId));
    const rimaste = await db.select().from(notifications).where(eq(notifications.id, notifica.id));
    expect(rimaste).toHaveLength(0);
  });

  it("consegna webhook: notificationId null, event valorizzato, default della coda", async () => {
    // Il webhook d'istanza è per EVENTO, non per utente: la riga di outbox non
    // ha una notifica dietro e porta l'evento nella colonna `event`.
    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({ channel: "webhook", event: { kind: "ticket.created" } })
      .returning();
    if (!delivery) throw new Error("insert della consegna non ha restituito la riga");

    expect(delivery.notificationId).toBeNull();
    expect(delivery.channel).toBe("webhook");
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);
    expect(delivery.nextAttemptAt).toBeInstanceOf(Date);
    expect(delivery.error).toBeNull();
    expect(delivery.externalRef).toBeNull();
    expect(delivery.sentAt).toBeNull();
    expect(delivery.event).toEqual({ kind: "ticket.created" });
  });

  it("consegna slack_dm: legata a una notifica, cascata sul delete della notifica", async () => {
    const { projectId, ticketId } = await seedTicketRow(db);
    const userId = await seedUser();
    const [notifica] = await db
      .insert(notifications)
      .values({
        userId,
        projectId,
        ticketId,
        kind: "ticket.created",
        event: { kind: "ticket.created" },
      })
      .returning();
    if (!notifica) throw new Error("insert della notifica non ha restituito la riga");

    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({ notificationId: notifica.id, channel: "slack_dm" })
      .returning();
    if (!delivery) throw new Error("insert della consegna non ha restituito la riga");
    // Il DM non duplica l'evento: lo legge dalla notifica.
    expect(delivery.event).toBeNull();

    await db.delete(notifications).where(eq(notifications.id, notifica.id));
    const rimaste = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    expect(rimaste).toHaveLength(0);
  });

  it("delivery_status rifiuta i valori fuori enum", async () => {
    // Insert raw: il tipo drizzle vieterebbe già il valore a compile-time,
    // qui si verifica che sia l'enum Postgres a farlo rispettare a runtime.
    await expect(
      db.execute(
        sql`insert into notification_deliveries (channel, status) values ('webhook', 'inviata')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into notification_deliveries (channel) values ('email')`),
    ).rejects.toThrow();
  });

  it("project_follows: chiave composta (utente, progetto), duplicato rifiutato", async () => {
    const { projectId } = await seedTicketRow(db);
    const userId = await seedUser();

    const [follow] = await db.insert(projectFollows).values({ userId, projectId }).returning();
    if (!follow) throw new Error("insert del follow non ha restituito la riga");
    expect(follow.createdAt).toBeInstanceOf(Date);

    await expect(db.insert(projectFollows).values({ userId, projectId })).rejects.toThrow();

    // Un secondo progetto per lo stesso utente convive.
    const { projectId: altroProgetto } = await seedTicketRow(db);
    await db.insert(projectFollows).values({ userId, projectId: altroProgetto });
    const follows = await db.select().from(projectFollows).where(eq(projectFollows.userId, userId));
    expect(follows).toHaveLength(2);

    // Cascata su entrambi i lati: eliminare il progetto rimuove il follow.
    await db.delete(projects).where(eq(projects.id, altroProgetto));
    const dopoDelete = await db
      .select()
      .from(projectFollows)
      .where(eq(projectFollows.userId, userId));
    expect(dopoDelete).toHaveLength(1);
  });
});
