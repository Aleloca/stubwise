import {
  activityReports,
  aiJobs,
  backlogItems,
  notifications,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  isRunningStatus,
  isWaitingStatus,
  RUNNING_STATUSES,
  summarizeProject,
  WAITING_STATUSES,
} from "./project-pulse-summary.js";

/**
 * Test di `summarizeProject` su un Postgres reale (testcontainers), stesso
 * pattern di `publish.test.ts`: il riepilogo aggrega più tabelle (job,
 * notifiche, backlog, report attività) e la cosa che conta davvero — chi vede
 * cosa, e in che ordine — è proprio quella che un fake `Db` renderebbe banale
 * da far tornare "verde" senza che sia vero.
 */
describe("summarizeProject", () => {
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
    // Ogni test riparte da zero: le tabelle coinvolte cascatano dal progetto
    // (tickets/ai_jobs/notifications/backlog_items/activity_reports hanno
    // tutte project_id o ticket_id con ON DELETE CASCADE), quindi basta
    // svuotare projects... ma projects non lo tocchiamo qui (seedRepository ne
    // crea uno per test): svuotare gli utenti basta a isolare i test fra loro
    // sulle notifiche (che referenziano user_id).
    await db.delete(users);
  });

  async function seedProject(): Promise<string> {
    const { projectId } = await seedRepository(db);
    return projectId;
  }

  async function seedUser(role: "admin" | "member"): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.com`,
        passwordHash: "hash-placeholder",
        role,
      })
      .returning({ id: users.id });
    return row!.id;
  }

  async function seedTicketRow(
    projectId: string,
    opts: { number?: number; title?: string } = {},
  ): Promise<{ ticketId: string; number: number }> {
    const number = opts.number ?? 1;
    const [row] = await db
      .insert(tickets)
      .values({
        projectId,
        number,
        title: opts.title ?? `Ticket ${number}`,
        type: "bug",
        priority: "medium",
        source: "manual",
      })
      .returning({ id: tickets.id });
    return { ticketId: row!.id, number };
  }

  async function seedAiJob(opts: {
    ticketId: string;
    status: "awaiting_input" | "awaiting_plan_approval" | "triaging" | "fixing" | "failed";
    requestedByUserId?: string | null;
    startedAt?: Date;
  }): Promise<string> {
    const [row] = await db
      .insert(aiJobs)
      .values({
        ticketId: opts.ticketId,
        status: opts.status,
        requestedByUserId: opts.requestedByUserId ?? null,
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      })
      .returning({ id: aiJobs.id });
    return row!.id;
  }

  async function seedNotification(opts: {
    userId: string;
    jobId: string;
    kind: "job.awaiting_input" | "job.plan_review";
    status?: "open" | "handled" | "snoozed";
  }): Promise<string> {
    const status = opts.status ?? "open";
    const [row] = await db
      .insert(notifications)
      .values({
        userId: opts.userId,
        jobId: opts.jobId,
        kind: opts.kind,
        event: {},
        status,
        // I CHECK del DB impongono la coerenza: `handled` vuole `handledAt`,
        // `snoozed` vuole `snoozedUntil` (vedi `notifications_handled_at_chk`
        // e `notifications_snoozed_until_chk` in `packages/db/src/schema.ts`).
        ...(status === "handled" ? { handledAt: new Date() } : {}),
        ...(status === "snoozed" ? { snoozedUntil: new Date(Date.now() + 60 * 60 * 1000) } : {}),
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  async function seedBacklogItem(
    projectId: string,
    status: "new" | "refining" | "ready",
  ): Promise<void> {
    await db.insert(backlogItems).values({
      projectId,
      title: "Voce",
      document: "Un corpo qualsiasi.",
      status,
      source: "manual",
    });
  }

  async function seedActivityReport(
    projectId: string,
    date: string,
    status: "queued" | "running" | "done" | "failed" = "done",
  ): Promise<void> {
    await db.insert(activityReports).values({ projectId, date, status });
  }

  it("job awaiting_input col richiedente = viewer -> waitingForYou con notificationId", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Domanda aperta" });
    const jobId = await seedAiJob({
      ticketId,
      status: "awaiting_input",
      requestedByUserId: viewerId,
    });
    const notificationId = await seedNotification({
      userId: viewerId,
      jobId,
      kind: "job.awaiting_input",
    });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.waitingForYou).toEqual([
      {
        kind: "question",
        ticketId,
        ticketNumber: number,
        title: "Domanda aperta",
        notificationId,
      },
    ]);
    expect(summary?.waitingForOthers).toEqual([]);
  });

  it("notifica handled per il job awaiting_input: la voce non compare da nessuna parte (stale)", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId, { title: "Domanda aperta" });
    const jobId = await seedAiJob({
      ticketId,
      status: "awaiting_input",
      requestedByUserId: viewerId,
    });
    // La notifica è handled ma il JOB resta awaiting_input: incoerenza che
    // segnala una copia stantia (vedi il commento su `loadNotificationIds`).
    await seedNotification({
      userId: viewerId,
      jobId,
      kind: "job.awaiting_input",
      status: "handled",
    });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.waitingForYou).toEqual([]);
    expect(summary?.waitingForOthers).toEqual([]);
  });

  it("notifica snoozed per il job awaiting_input: la voce compare normalmente in waitingForYou", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Domanda aperta" });
    const jobId = await seedAiJob({
      ticketId,
      status: "awaiting_input",
      requestedByUserId: viewerId,
    });
    const notificationId = await seedNotification({
      userId: viewerId,
      jobId,
      kind: "job.awaiting_input",
      status: "snoozed",
    });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    // Rinviata non vuol dire risolta: resta la riga giusta su cui agire.
    expect(summary?.waitingForYou).toEqual([
      {
        kind: "question",
        ticketId,
        ticketNumber: number,
        title: "Domanda aperta",
        notificationId,
      },
    ]);
  });

  it("job awaiting_input, viewer member NON richiedente -> waitingForOthers con who=requester", async () => {
    const projectId = await seedProject();
    const requesterId = await seedUser("member");
    const viewerId = await seedUser("member");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Domanda di un altro" });
    const jobId = await seedAiJob({
      ticketId,
      status: "awaiting_input",
      requestedByUserId: requesterId,
    });
    await seedNotification({ userId: requesterId, jobId, kind: "job.awaiting_input" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.waitingForYou).toEqual([]);
    expect(summary?.waitingForOthers).toEqual([
      {
        kind: "question",
        ticketId,
        ticketNumber: number,
        title: "Domanda di un altro",
        who: { kind: "requester" },
      },
    ]);
  });

  it("job awaiting_plan_approval, viewer admin -> sempre in waitingForYou (anche non richiedente)", async () => {
    const projectId = await seedProject();
    const requesterId = await seedUser("member");
    const adminId = await seedUser("admin");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Piano da approvare" });
    const jobId = await seedAiJob({
      ticketId,
      status: "awaiting_plan_approval",
      requestedByUserId: requesterId,
    });
    const notificationId = await seedNotification({
      userId: adminId,
      jobId,
      kind: "job.plan_review",
    });

    const summary = await summarizeProject(db, projectId, { userId: adminId, role: "admin" });

    expect(summary?.waitingForYou).toEqual([
      {
        kind: "plan_approval",
        ticketId,
        ticketNumber: number,
        title: "Piano da approvare",
        notificationId,
      },
    ]);
    expect(summary?.waitingForOthers).toEqual([]);
  });

  it("job awaiting_plan_approval, viewer member NON richiedente -> waitingForOthers con who=maintainer", async () => {
    const projectId = await seedProject();
    const requesterId = await seedUser("member");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Piano da approvare" });
    await seedAiJob({
      ticketId,
      status: "awaiting_plan_approval",
      requestedByUserId: requesterId,
    });

    // Il richiedente stesso guarda il riepilogo: NON può approvare il proprio
    // piano (adminOnly), quindi anche lui la vede in waitingForOthers.
    const summary = await summarizeProject(db, projectId, {
      userId: requesterId,
      role: "member",
    });

    expect(summary?.waitingForYou).toEqual([]);
    expect(summary?.waitingForOthers).toEqual([
      {
        kind: "plan_approval",
        ticketId,
        ticketNumber: number,
        title: "Piano da approvare",
        who: { kind: "maintainer" },
      },
    ]);
  });

  it("job running (triaging/fixing) -> running[] con sinceMinutes", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    const { ticketId, number } = await seedTicketRow(projectId, { title: "Fix in corso" });
    const startedAt = new Date(Date.now() - 5 * 60 * 1000);
    await seedAiJob({ ticketId, status: "fixing", startedAt });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.running).toHaveLength(1);
    expect(summary?.running[0]).toMatchObject({
      ticketId,
      ticketNumber: number,
      title: "Fix in corso",
    });
    // Calcolato server-side da `now() - started_at`: qualche secondo di
    // margine per la latenza del test, ma deve stare vicino ai 5 minuti attesi.
    expect(summary?.running[0]?.sinceMinutes).toBeGreaterThanOrEqual(4);
    expect(summary?.running[0]?.sinceMinutes).toBeLessThanOrEqual(6);
  });

  it("job queued NON è running: non compare da nessuna parte", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    const { ticketId } = await seedTicketRow(projectId);
    await seedAiJob({ ticketId, status: "triaging" });
    // status default della tabella è "queued": lo forziamo esplicitamente
    // creando un secondo ticket/job in coda, mai avviato.
    const { ticketId: queuedTicketId } = await seedTicketRow(projectId, { number: 2 });
    await db.insert(aiJobs).values({ ticketId: queuedTicketId, status: "queued" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.running).toHaveLength(1);
    expect(summary?.failedCount).toBe(0);
  });

  it("failedCount conta i job falliti", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    const { ticketId: t1 } = await seedTicketRow(projectId, { number: 1 });
    const { ticketId: t2 } = await seedTicketRow(projectId, { number: 2 });
    await seedAiJob({ ticketId: t1, status: "failed" });
    await seedAiJob({ ticketId: t2, status: "failed" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.failedCount).toBe(2);
  });

  it("failedCount NON conta un job rilanciato: il rilancio riusa la riga e ne cambia lo stato", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    const { ticketId } = await seedTicketRow(projectId);
    const jobId = await seedAiJob({ ticketId, status: "failed" });
    // Simula ciò che fa `startRun` su un rilancio: la STESSA riga torna queued.
    await db.update(aiJobs).set({ status: "queued" }).where(eq(aiJobs.id, jobId));

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.failedCount).toBe(0);
  });

  it("backlogReadyCount conta solo le voci ready, non new/refining", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    await seedBacklogItem(projectId, "ready");
    await seedBacklogItem(projectId, "ready");
    await seedBacklogItem(projectId, "new");
    await seedBacklogItem(projectId, "refining");

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.backlogReadyCount).toBe(2);
  });

  it("idleDays 0 su un progetto mai partito (nessun job)", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.idleDays).toBe(0);
  });

  it("idleDays riflette i giorni dall'ultima attività di un job", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    const { ticketId } = await seedTicketRow(projectId);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db
      .insert(aiJobs)
      .values({ ticketId, status: "pr_merged", lastActivityAt: threeDaysAgo });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.idleDays).toBe(3);
  });

  it("lastReportDate legge l'ultimo activity_reports done, ignora quelli non done", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");
    await seedActivityReport(projectId, "2026-08-01", "done");
    await seedActivityReport(projectId, "2026-08-15", "done");
    await seedActivityReport(projectId, "2026-08-20", "failed");

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.lastReportDate).toBe("2026-08-15");
  });

  it("lastReportDate null quando nessun report è mai stato generato", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("admin");

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.lastReportDate).toBeNull();
  });

  it("ritorna null se il progetto non esiste", async () => {
    const viewerId = await seedUser("admin");
    const summary = await summarizeProject(db, randomUUID(), { userId: viewerId, role: "admin" });
    expect(summary).toBeNull();
  });

  it("una voce waitingForYou senza notifica corrispondente non entra nel riepilogo", async () => {
    // Corsa difensiva: il job è awaiting_input col viewer come richiedente, ma
    // per qualche motivo la notifica non c'è (mai pubblicata, o già ripulita).
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId);
    await seedAiJob({ ticketId, status: "awaiting_input", requestedByUserId: viewerId });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.waitingForYou).toEqual([]);
    expect(summary?.waitingForOthers).toEqual([]);
  });
});

/**
 * `isWaitingStatus`/`isRunningStatus` DERIVANO da `WAITING_STATUSES`/
 * `RUNNING_STATUSES` (stesso pattern di `isInFlight` in `./actions.ts`): un
 * test che si limitasse a verificare "gli stati di oggi tornano il valore
 * atteso" passerebbe anche se le due funzioni fossero riscritte come confronti
 * letterali (`status === "awaiting_input" || ...`) — esattamente il difetto
 * che questa derivazione elimina. La prova che chiude il buco per davvero è
 * MUTARE l'array a runtime (gli array `as const` restano array normali, non
 * congelati) e verificare che la funzione SEGUA: se seguisse un confronto
 * scritto a mano invece che l'array, non se ne accorgerebbe.
 */
describe("isWaitingStatus / isRunningStatus derivano dalle costanti, non da confronti ripetuti", () => {
  it("isWaitingStatus segue WAITING_STATUSES anche se la lista cambia a runtime", () => {
    expect(isWaitingStatus("failed")).toBe(false);
    const mutable = WAITING_STATUSES as unknown as string[];
    mutable.push("failed");
    try {
      expect(isWaitingStatus("failed")).toBe(true);
    } finally {
      mutable.pop();
    }
    // Ripristinato: non deve restare vero fuori da questo test.
    expect(isWaitingStatus("failed")).toBe(false);
  });

  it("isRunningStatus segue RUNNING_STATUSES anche se la lista cambia a runtime", () => {
    expect(isRunningStatus("failed")).toBe(false);
    const mutable = RUNNING_STATUSES as unknown as string[];
    mutable.push("failed");
    try {
      expect(isRunningStatus("failed")).toBe(true);
    } finally {
      mutable.pop();
    }
    expect(isRunningStatus("failed")).toBe(false);
  });

  it("i due elenchi non si sovrappongono (uno stato non è mai sia 'in attesa' che 'in esecuzione')", () => {
    for (const status of WAITING_STATUSES) {
      expect(isRunningStatus(status)).toBe(false);
    }
    for (const status of RUNNING_STATUSES) {
      expect(isWaitingStatus(status)).toBe(false);
    }
  });
});
