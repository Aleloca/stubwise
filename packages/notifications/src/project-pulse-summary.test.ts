import {
  activityReports,
  agentQuestions,
  aiJobs,
  backlogItems,
  notifications,
  ticketRepositories,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  isRunningStatus,
  isWaitingStatus,
  RUNNING_STATUSES,
  stalledReasonFor,
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
    opts: {
      number?: number;
      title?: string;
      status?: "open" | "triaged" | "in_progress" | "in_review" | "done" | "closed";
      /** Sposta indietro `updated_at` DOPO l'insert: è l'ultimo MOVIMENTO del
       * ticket, e il quarto secchio ci si appoggia. Scritto in SQL grezzo e non
       * con `db.update(...)` perché la colonna ha un `$onUpdate` che
       * rimetterebbe "adesso". */
      updatedAt?: Date;
    } = {},
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
        ...(opts.status ? { status: opts.status } : {}),
      })
      .returning({ id: tickets.id });
    const ticketId = row!.id;
    if (opts.updatedAt) {
      await db.execute(
        sql`update tickets set updated_at = ${opts.updatedAt.toISOString()} where id = ${ticketId}`,
      );
    }
    return { ticketId, number };
  }

  async function seedAiJob(opts: {
    ticketId: string;
    // Allargato al 21 set 2026 (quarto secchio): il criterio del "fermo"
    // guarda anche gli stati CONCLUSI — un job che c'è stato ed è finito è la
    // differenza fra «mai lavorato» e «lavorato, poi fermo».
    status:
      | "queued"
      | "awaiting_input"
      | "awaiting_plan_approval"
      | "triaging"
      | "fixing"
      | "held"
      | "failed"
      | "skipped"
      | "pr_opened"
      | "pr_merged"
      | "pr_closed";
    requestedByUserId?: string | null;
    startedAt?: Date;
    lastActivityAt?: Date;
  }): Promise<string> {
    const [row] = await db
      .insert(aiJobs)
      .values({
        ticketId: opts.ticketId,
        status: opts.status,
        requestedByUserId: opts.requestedByUserId ?? null,
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
        ...(opts.lastActivityAt ? { lastActivityAt: opts.lastActivityAt } : {}),
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

  // ------------------------------------------------------------------------
  // IL QUARTO SECCHIO: ciò che non si muove (21 set 2026)
  // ------------------------------------------------------------------------

  async function seedProjectWithRepo(): Promise<{ projectId: string; repositoryId: string }> {
    return seedRepository(db);
  }

  async function seedOpenPr(opts: {
    ticketId: string;
    repositoryId: string;
    prUrl: string | null;
  }): Promise<void> {
    await db.insert(ticketRepositories).values({
      ticketId: opts.ticketId,
      repositoryId: opts.repositoryId,
      branch: "stubwise/ticket-1",
      prUrl: opts.prUrl,
      prState: "open",
    });
  }

  async function seedOpenQuestion(opts: { jobId: string; ticketId: string }): Promise<void> {
    await db.insert(agentQuestions).values({
      jobId: opts.jobId,
      ticketId: opts.ticketId,
      round: 1,
      question: "Quale strada?",
      options: [{ label: "A" }, { label: "B" }],
    });
  }

  it("ticket aperto e mai lavorato -> stalled, motivo `to_prepare`", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId, { number: 7, title: "Da preparare" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled).toEqual([
      {
        ticketId,
        ticketNumber: 7,
        title: "Da preparare",
        stalledSince: expect.any(String),
        reason: "to_prepare",
      },
    ]);
  });

  it("ticket aperto con un job CONCLUSO -> motivo `worked_then_stopped`", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId);
    await seedAiJob({ ticketId, status: "pr_closed" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled.map((item) => item.reason)).toEqual(["worked_then_stopped"]);
  });

  it("`in_progress` con un job che non ha MAI aperto una PR -> `interrupted`", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId, { status: "in_progress" });
    await seedAiJob({ ticketId, status: "failed" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled.map((item) => item.reason)).toEqual(["interrupted"]);
  });

  /**
   * ⚠️ IL CASO CHE HA CORRETTO IL DESIGN, e il motivo per cui il «perché» si
   * deriva dai JOB e non dallo STATO. In produzione, al 21 set, il ticket #25
   * era `in_progress` con ZERO job e il suo contenuto era già rilasciato da
   * settimane: chiamarlo «interrotto» avrebbe mandato un operatore a cercare
   * un lavoro a metà che non è mai esistito. Lo stato è una DICHIARAZIONE di
   * qualcuno, i job sono un FATTO.
   */
  it("`in_progress` SENZA nessun job -> `declared_no_work`, NON `interrupted`", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    await seedTicketRow(projectId, { status: "in_progress" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled.map((item) => item.reason)).toEqual(["declared_no_work"]);
  });

  it("un job VIVO toglie il ticket dai fermi — `held` compreso", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId: held } = await seedTicketRow(projectId, { number: 1 });
    await seedAiJob({ ticketId: held, status: "held" });
    const { ticketId: queued } = await seedTicketRow(projectId, { number: 2 });
    await seedAiJob({ ticketId: queued, status: "queued" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled).toEqual([]);
  });

  it("una domanda dell'agente ancora aperta toglie il ticket dai fermi", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId);
    // Job CONCLUSO apposta: senza la domanda questo ticket sarebbe fermo, e il
    // test non proverebbe niente se il job bastasse già da solo a escluderlo.
    const jobId = await seedAiJob({ ticketId, status: "failed" });
    await seedOpenQuestion({ jobId, ticketId });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled).toEqual([]);
  });

  it("un ticket chiuso non è mai fermo (done e closed)", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    await seedTicketRow(projectId, { number: 1, status: "done" });
    await seedTicketRow(projectId, { number: 2, status: "closed" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled).toEqual([]);
  });

  it("i giorni si contano dall'ultimo MOVIMENTO, non dalla creazione", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    const vecchio = new Date("2026-08-01T10:00:00.000Z");
    const recente = new Date("2026-09-15T08:30:00.000Z");
    const { ticketId } = await seedTicketRow(projectId, { updatedAt: vecchio });
    // Un job che ha lavorato DOPO: il ticket non è fermo da agosto.
    await seedAiJob({ ticketId, status: "failed", lastActivityAt: recente });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled[0]?.stalledSince).toBe(recente.toISOString());
  });

  it("l'ordine è dal più fermo (design §4: l'anzianità è il significato)", async () => {
    const projectId = await seedProject();
    const viewerId = await seedUser("member");
    await seedTicketRow(projectId, { number: 1, updatedAt: new Date("2026-09-19T10:00:00.000Z") });
    await seedTicketRow(projectId, { number: 2, updatedAt: new Date("2026-08-30T10:00:00.000Z") });
    await seedTicketRow(projectId, { number: 3, updatedAt: new Date("2026-09-10T10:00:00.000Z") });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "member" });

    expect(summary?.stalled.map((item) => item.ticketNumber)).toEqual([2, 3, 1]);
  });

  it("una PR aperta: NON fermo, va in `waitingForMerge`", async () => {
    const { projectId, repositoryId } = await seedProjectWithRepo();
    const viewerId = await seedUser("admin");
    const { ticketId } = await seedTicketRow(projectId, { number: 20, status: "in_review" });
    await seedOpenPr({ ticketId, repositoryId, prUrl: "https://example.com/pr/20" });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.stalled).toEqual([]);
    expect(summary?.waitingForMerge).toEqual([
      {
        ticketId,
        ticketNumber: 20,
        title: "Ticket 20",
        prUrl: "https://example.com/pr/20",
        canMerge: true,
      },
    ]);
  });

  /**
   * `prState` nasce `'open'` di default: una riga senza `prUrl` è un branch
   * preparato di cui la PR non è MAI stata aperta. Dirlo «in attesa di merge»
   * sarebbe falso — e il ticket deve ricadere fra i FERMI, non sparire da
   * tutt'e due i posti. È la stessa condizione che usa la coda di rilascio.
   */
  it("`prState = open` senza `prUrl` non è una PR aperta: il ticket resta fermo", async () => {
    const { projectId, repositoryId } = await seedProjectWithRepo();
    const viewerId = await seedUser("admin");
    const { ticketId } = await seedTicketRow(projectId, { status: "in_progress" });
    await seedAiJob({ ticketId, status: "failed" });
    await seedOpenPr({ ticketId, repositoryId, prUrl: null });

    const summary = await summarizeProject(db, projectId, { userId: viewerId, role: "admin" });

    expect(summary?.waitingForMerge).toEqual([]);
    expect(summary?.stalled.map((item) => item.reason)).toEqual(["interrupted"]);
  });

  /**
   * ⚠️ IL TEST CHE È IL CUORE DEL BATCH. Stessi dati, due ruoli: la stessa PR
   * arriva a un maintainer con `canMerge: true` e a un operatore con
   * `canMerge: false` — cioè il client la mette sotto «aspetta te» per il
   * primo e sotto «aspetta altri» per il secondo, senza deciderlo lui.
   *
   * È la verifica che il secondo divieto dell'operatore (CLAUDE.md, «I due
   * divieti dell'operatore») vale anche IN LETTURA e non solo sulle rotte di
   * scrittura: `release.test.ts` prova che un `member` non può mergiare, questo
   * prova che non gli viene nemmeno MOSTRATO come suo.
   */
  it("stessi dati, due ruoli: `canMerge` distingue il maintainer dall'operatore", async () => {
    const { projectId, repositoryId } = await seedProjectWithRepo();
    const maintainerId = await seedUser("admin");
    const operatoreId = await seedUser("member");
    const { ticketId } = await seedTicketRow(projectId, { number: 31, status: "in_review" });
    await seedOpenPr({ ticketId, repositoryId, prUrl: "https://example.com/pr/31" });

    const perIlMaintainer = await summarizeProject(db, projectId, {
      userId: maintainerId,
      role: "admin",
    });
    const perLOperatore = await summarizeProject(db, projectId, {
      userId: operatoreId,
      role: "member",
    });

    expect(perIlMaintainer?.waitingForMerge).toHaveLength(1);
    expect(perLOperatore?.waitingForMerge).toHaveLength(1);
    expect(perIlMaintainer?.waitingForMerge[0]?.canMerge).toBe(true);
    expect(perLOperatore?.waitingForMerge[0]?.canMerge).toBe(false);
    // …e per il resto è la STESSA riga: cambia il permesso, non il fatto.
    expect(perLOperatore?.waitingForMerge[0]?.prUrl).toBe(
      perIlMaintainer?.waitingForMerge[0]?.prUrl,
    );
    expect(perLOperatore?.waitingForMerge[0]?.ticketId).toBe(
      perIlMaintainer?.waitingForMerge[0]?.ticketId,
    );
  });
});

/**
 * Il «perché» come funzione PURA: la regola del design §3 esercitata caso per
 * caso, senza un Postgres davanti. I test sul database qui sopra provano che
 * la funzione è collegata ai dati giusti; questi provano la regola.
 */
describe("stalledReasonFor", () => {
  it("nessun job e stato non dichiarato in lavorazione -> `to_prepare`", () => {
    expect(stalledReasonFor({ ticketStatus: "open", jobCount: 0, deliveredJobCount: 0 })).toBe(
      "to_prepare",
    );
    expect(stalledReasonFor({ ticketStatus: "triaged", jobCount: 0, deliveredJobCount: 0 })).toBe(
      "to_prepare",
    );
  });

  it("nessun job ma stato dichiarato in lavorazione -> `declared_no_work`", () => {
    expect(
      stalledReasonFor({ ticketStatus: "in_progress", jobCount: 0, deliveredJobCount: 0 }),
    ).toBe("declared_no_work");
    expect(stalledReasonFor({ ticketStatus: "in_review", jobCount: 0, deliveredJobCount: 0 })).toBe(
      "declared_no_work",
    );
  });

  it("`in_progress` con job ma nessuna PR mai aperta -> `interrupted`", () => {
    expect(
      stalledReasonFor({ ticketStatus: "in_progress", jobCount: 2, deliveredJobCount: 0 }),
    ).toBe("interrupted");
  });

  it("`in_progress` con un job che una PR l'ha aperta -> `worked_then_stopped`", () => {
    expect(
      stalledReasonFor({ ticketStatus: "in_progress", jobCount: 1, deliveredJobCount: 1 }),
    ).toBe("worked_then_stopped");
  });

  it("aperto con job -> `worked_then_stopped` (non `interrupted`: non si dichiara in lavorazione)", () => {
    expect(stalledReasonFor({ ticketStatus: "open", jobCount: 1, deliveredJobCount: 0 })).toBe(
      "worked_then_stopped",
    );
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
