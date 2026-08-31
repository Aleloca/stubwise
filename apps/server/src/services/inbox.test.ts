import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, comments, notifications, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { NotificationEvent } from "@stubwise/notifications";
import { createTicket } from "../db/tickets.js";
import type { Actor } from "./jobs.js";
import { actionsFor, executeAction, listInbox, markRead, unreadCount } from "./inbox.js";

/**
 * Test del servizio inbox su un Postgres reale (testcontainers), come
 * `jobs.test.ts`: le parti interessanti sono UPDATE guardati, propagazione su
 * più righe e riapertura lazy degli snooze — cioè esattamente ciò che un fake
 * `Db` non saprebbe raccontare. `actionsFor` è invece pura e non tocca il DB.
 */

let testDb: TestDb;
let db: Db;
let projectId: string;
let maintainer: Actor;
let operator: Actor;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  maintainer = await seedUser("admin");
  operator = await seedUser("member");
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Inserisce un utente col ruolo dato (id reale: serve alle FK). */
async function seedUser(role: "admin" | "member"): Promise<Actor & { email: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role })
    .returning({ id: users.id, role: users.role, email: users.email });
  return { id: row!.id, role: row!.role, email: row!.email };
}

/** Crea un ticket nel progetto di test, con `implementationPlan` opzionale. */
async function seedTicket(plan?: string): Promise<string> {
  const ticket = await createTicket(db, {
    projectId,
    title: "Ticket di servizio",
    type: "bug",
    priority: "medium",
    source: "manual",
    ...(plan === undefined ? {} : { implementationPlan: plan }),
  });
  return ticket.id;
}

/** Inserisce un job nello stato dato e ne restituisce l'id. */
async function seedJob(
  ticketId: string,
  status: "queued" | "fixing" | "awaiting_plan_approval" | "failed" | "pr_merged" | "held",
  values: Partial<typeof aiJobs.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(aiJobs)
    .values({ ticketId, status, ...values })
    .returning({ id: aiJobs.id });
  return row!.id;
}

/** Evento `job.plan_review` realistico per il ticket dato. */
function planReviewEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "job.plan_review",
    ticketNumber: 7,
    ticketTitle: "Export CSV dello storico",
    projectName: "negozio-web",
    ticketUrl: "https://stubwise.test/tickets/7",
    ...overrides,
  } as NotificationEvent;
}

/** Inserisce una riga di inbox e ne restituisce l'id. */
async function seedNotification(input: {
  userId: string;
  kind: NotificationEvent["kind"];
  event: NotificationEvent;
  ticketId?: string | null;
  jobId?: string | null;
  projectId?: string | null;
  status?: "open" | "handled" | "snoozed";
  snoozedUntil?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const status = input.status ?? "open";
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind,
      event: input.event as unknown as Record<string, unknown>,
      ticketId: input.ticketId ?? null,
      jobId: input.jobId ?? null,
      projectId: input.projectId === undefined ? projectId : input.projectId,
      status,
      snoozedUntil: input.snoozedUntil ?? null,
      handledAt: status === "handled" ? new Date() : null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/**
 * Come {@link seedNotification} ma con un `event` jsonb ARBITRARIO: serve a
 * riprodurre le righe storiche scritte da versioni precedenti del codice, che
 * il DB accetta senza controllarne la forma (nessun CHECK sul payload).
 */
async function seedRawNotification(input: {
  userId: string;
  kind: NotificationEvent["kind"];
  event: Record<string, unknown>;
  createdAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind,
      event: input.event,
      projectId,
      status: "open",
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/** Legge una riga di inbox per id. */
async function readNotification(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

/** Legge il job per id. */
async function readJob(jobId: string) {
  const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
  return row;
}

describe("actionsFor", () => {
  it("job.plan_review in attesa + admin → approva, rifiuta, apri, snooze, gestita", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "awaiting_plan_approval", maintainer)).toEqual([
      "approve_plan",
      "reject_plan",
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.plan_review in attesa + member → nessuna decisione sul piano", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "awaiting_plan_approval", operator)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.plan_review con job già in lavorazione → niente approve/reject nemmeno all'admin", () => {
    expect(actionsFor({ kind: "job.plan_review" }, "fixing", maintainer)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.budget_held → relaunch solo all'admin", () => {
    expect(actionsFor({ kind: "job.budget_held" }, "held", maintainer)).toEqual([
      "relaunch",
      "open",
      "snooze",
      "handled",
    ]);
    expect(actionsFor({ kind: "job.budget_held" }, "held", operator)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.held → relaunch anche al member", () => {
    expect(actionsFor({ kind: "job.held" }, "held", operator)).toEqual([
      "relaunch",
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("job.failed e job.pr_closed → relaunch a tutti", () => {
    expect(actionsFor({ kind: "job.failed" }, "failed", operator)).toContain("relaunch");
    expect(actionsFor({ kind: "job.pr_closed" }, "pr_merged", operator)).toContain("relaunch");
  });

  it("job.failed con l'ultimo job del ticket in volo → niente relaunch", () => {
    expect(actionsFor({ kind: "job.failed" }, "queued", maintainer)).toEqual([
      "open",
      "snooze",
      "handled",
    ]);
  });

  it("kind informativi → solo apri, snooze, gestita", () => {
    for (const kind of [
      "job.pr_opened",
      "review.completed",
      "ticket.created",
      "docs.limit_paused",
      "monitor.alert",
      "monitor.recovered",
    ] as const) {
      expect(actionsFor({ kind }, null, maintainer)).toEqual(["open", "snooze", "handled"]);
    }
  });
});

describe("executeAction", () => {
  it("notifica inesistente → not_found", async () => {
    const result = await executeAction(db, {
      notificationId: randomUUID(),
      action: "handled",
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("notifica di un altro utente → not_found (non ne rivela l'esistenza)", async () => {
    const other = await seedUser("member");
    const id = await seedNotification({
      userId: other.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    const result = await executeAction(db, {
      notificationId: id,
      action: "handled",
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("open → invalid_action (non è eseguibile lato server)", async () => {
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    const result = await executeAction(db, {
      notificationId: id,
      action: "open",
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "invalid_action" });
  });

  it("approve_plan → esegue il piano e marca handled TUTTE le copie del job", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval", {
      planText: "## Piano\n1. Passo A",
      resumeMode: "execute",
      planApprovalRequired: true,
    });
    const secondAdmin = await seedUser("admin");
    const mine = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    const theirs = await seedNotification({
      userId: secondAdmin.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    // Notifica di ALTRO kind sullo stesso job: non deve essere toccata.
    const otherKind = await seedNotification({
      userId: maintainer.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed" }),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: mine,
      action: "approve_plan",
      actor: maintainer,
    });
    expect(result).toMatchObject({
      ok: true,
      action: "approve_plan",
      jobId,
      kind: "job.plan_review",
      notificationJobId: jobId,
    });
    // Il Task 10 userà questi id per ritoccare i DM Slack delle copie chiuse:
    // ci sono entrambe le righe plan_review, NON quella di kind diverso.
    const closed = result.ok ? result.changedNotificationIds : [];
    expect([...closed].sort()).toEqual([mine, theirs].sort());
    expect(closed).not.toContain(otherKind);

    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("execute");

    for (const id of [mine, theirs]) {
      const row = await readNotification(id);
      expect(row?.status).toBe("handled");
      expect(row?.handledByUserId).toBe(maintainer.id);
      expect(row?.handledAt).toBeInstanceOf(Date);
    }
    expect((await readNotification(otherKind))?.status).toBe("open");
  });

  it("approve_plan ripetuta → already_handled con chi l'ha gestita", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const first = await executeAction(db, {
      notificationId: id,
      action: "approve_plan",
      actor: maintainer,
    });
    expect(first.ok).toBe(true);

    const second = await executeAction(db, {
      notificationId: id,
      action: "approve_plan",
      actor: maintainer,
    });
    expect(second).toEqual({
      ok: false,
      error: "already_handled",
      handledBy: { id: maintainer.id, email: expect.stringContaining("admin-") },
    });
  });

  it("approve_plan da un member → forbidden", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({
      userId: operator.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "approve_plan",
      actor: operator,
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect((await readNotification(id))?.status).toBe("open");
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
  });

  it("azione che il kind non prevede → invalid_action, non forbidden (anche da admin)", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed", error: "test rossi" }),
      ticketId,
      jobId,
    });

    // Chi chiede è admin: se rispondessimo `forbidden` gli diremmo "riprova con
    // più permessi" per una richiesta che nessun ruolo potrà mai soddisfare.
    const result = await executeAction(db, {
      notificationId: id,
      action: "approve_plan",
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "invalid_action" });
    expect((await readNotification(id))?.status).toBe("open");
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
  });

  it("due approve_plan concorrenti → ne vince esattamente una", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval", {
      planText: "## Piano\n1. Passo A",
    });
    const secondAdmin = await seedUser("admin");
    const mine = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    const theirs = await seedNotification({
      userId: secondAdmin.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const [a, b] = await Promise.all([
      executeAction(db, { notificationId: mine, action: "approve_plan", actor: maintainer }),
      executeAction(db, { notificationId: theirs, action: "approve_plan", actor: secondAdmin }),
    ]);

    // Una sola vince: l'UPDATE condizionato di `resolvePlan` fa passare una sola
    // transizione da awaiting_plan_approval.
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    // Chi arriva secondo vede o la riga già chiusa, o il piano non più pendente
    // (dipende da quale delle due scritture del vincitore ha già committato).
    expect(loser && !loser.ok ? loser.error : null).toMatch(/^(already_handled|plan_not_pending)$/);

    // Il piano è stato eseguito UNA volta sola.
    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("execute");
    const systemComments = (
      await db.select().from(comments).where(eq(comments.ticketId, ticketId))
    ).filter((c) => c.authorType === "system");
    expect(systemComments).toHaveLength(1);
  });

  it("reject_plan con istruzioni → ripianificazione e commento del team", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval", {
      planText: "## Piano\n1. Passo A",
    });
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "reject_plan",
      actor: maintainer,
      payload: { instructions: "Usa lo streaming, non caricare tutto in memoria" },
    });
    expect(result).toMatchObject({ ok: true, action: "reject_plan", jobId });

    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("fix");
    expect(job?.planText).toBeNull();

    const rows = await db.select().from(comments).where(eq(comments.ticketId, ticketId));
    expect(rows.some((c) => c.body.includes("streaming") && c.authorType === "user")).toBe(true);
    expect((await readNotification(id))?.status).toBe("handled");
  });

  it("approve_plan quando il piano non è più pendente e nessuno ha gestito → plan_not_pending", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    // Il job è già ripartito da un'altra superficie: niente più gate da sbloccare.
    const jobId = await seedJob(ticketId, "fixing");
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "approve_plan",
      actor: maintainer,
    });
    expect(result).toEqual({ ok: false, error: "plan_not_pending" });
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("approve_plan su un piano approvato dalla pagina ticket (righe già handled) → already_handled", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const first = await seedNotification({
      userId: maintainer.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    const secondAdmin = await seedUser("admin");
    const second = await seedNotification({
      userId: secondAdmin.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    expect(
      (
        await executeAction(db, {
          notificationId: first,
          action: "approve_plan",
          actor: maintainer,
        })
      ).ok,
    ).toBe(true);

    // Il secondo admin arriva dopo: il piano non è più pendente MA le righe
    // risultano gestite → il messaggio giusto è "l'ha già fatto X".
    const late = await executeAction(db, {
      notificationId: second,
      action: "approve_plan",
      actor: secondAdmin,
    });
    expect(late).toEqual({
      ok: false,
      error: "already_handled",
      handledBy: { id: maintainer.id, email: expect.any(String) },
    });
  });

  it("relaunch su job.failed → nuovo run in coda e notifiche del job chiuse", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "failed");
    const id = await seedNotification({
      userId: operator.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed", error: "test rossi" }),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "relaunch",
      actor: operator,
    });
    expect(result).toMatchObject({
      ok: true,
      action: "relaunch",
      kind: "job.failed",
      notificationJobId: jobId,
      changedNotificationIds: [id],
    });
    expect((await readJob(jobId))?.status).toBe("queued");
    expect((await readNotification(id))?.status).toBe("handled");
    expect((await readNotification(id))?.handledByUserId).toBe(operator.id);
  });

  it("relaunch con il job già in volo → job_in_flight, notifica intatta", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "fixing");
    const id = await seedNotification({
      userId: operator.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed", error: "test rossi" }),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "relaunch",
      actor: operator,
    });
    expect(result).toEqual({ ok: false, error: "job_in_flight", jobStatus: "fixing" });
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("relaunch di un budget_held da un member → forbidden", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "held", { heldReason: "budget" });
    const id = await seedNotification({
      userId: operator.id,
      kind: "job.budget_held",
      event: planReviewEvent({ kind: "job.budget_held" }),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "relaunch",
      actor: operator,
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect((await readJob(jobId))?.status).toBe("held");
  });

  it("snooze 1h → snoozed con scadenza fra un'ora", async () => {
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.pr_opened",
      event: planReviewEvent({ kind: "job.pr_opened", prUrl: "https://pr.test/1" }),
    });

    const result = await executeAction(db, {
      notificationId: id,
      action: "snooze",
      actor: maintainer,
      payload: { until: "1h" },
    });
    // Lo snooze non gestisce nulla, ma la riga cambia stato: il campo la elenca
    // (è ciò che serve a rinfrescare il DM Slack corrispondente).
    expect(result).toMatchObject({
      ok: true,
      action: "snooze",
      kind: "job.pr_opened",
      notificationJobId: null,
      changedNotificationIds: [id],
    });

    const row = await readNotification(id);
    expect(row?.status).toBe("snoozed");
    const delta = row!.snoozedUntil!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(50 * 60_000);
    expect(delta).toBeLessThan(70 * 60_000);
  });

  it("snooze tomorrow e 3d → scadenze a +24h e +3 giorni", async () => {
    const tomorrowId = await seedNotification({
      userId: maintainer.id,
      kind: "job.pr_opened",
      event: planReviewEvent({ kind: "job.pr_opened", prUrl: "https://pr.test/1" }),
    });
    await executeAction(db, {
      notificationId: tomorrowId,
      action: "snooze",
      actor: maintainer,
      payload: { until: "tomorrow" },
    });
    const tomorrow = (await readNotification(tomorrowId))!.snoozedUntil!.getTime() - Date.now();
    expect(tomorrow).toBeGreaterThan(23 * 3_600_000);
    expect(tomorrow).toBeLessThan(25 * 3_600_000);

    const threeId = await seedNotification({
      userId: maintainer.id,
      kind: "job.pr_opened",
      event: planReviewEvent({ kind: "job.pr_opened", prUrl: "https://pr.test/1" }),
    });
    await executeAction(db, {
      notificationId: threeId,
      action: "snooze",
      actor: maintainer,
      payload: { until: "3d" },
    });
    const three = (await readNotification(threeId))!.snoozedUntil!.getTime() - Date.now();
    expect(three).toBeGreaterThan(71 * 3_600_000);
    expect(three).toBeLessThan(73 * 3_600_000);
  });

  it("snooze senza durata valida → invalid_action", async () => {
    const id = await seedNotification({
      userId: maintainer.id,
      kind: "job.pr_opened",
      event: planReviewEvent({ kind: "job.pr_opened", prUrl: "https://pr.test/1" }),
    });
    const result = await executeAction(db, {
      notificationId: id,
      action: "snooze",
      actor: maintainer,
      payload: { until: "next-week" as never },
    });
    expect(result).toEqual({ ok: false, error: "invalid_action" });
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("handled manuale → chiude SOLO la propria riga", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "failed");
    const other = await seedUser("admin");
    const mine = await seedNotification({
      userId: maintainer.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed", error: "x" }),
      ticketId,
      jobId,
    });
    const theirs = await seedNotification({
      userId: other.id,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed", error: "x" }),
      ticketId,
      jobId,
    });

    const result = await executeAction(db, {
      notificationId: mine,
      action: "handled",
      actor: maintainer,
    });
    expect(result).toMatchObject({
      ok: true,
      action: "handled",
      kind: "job.failed",
      notificationJobId: jobId,
      // Archiviazione personale: nell'elenco c'è solo la propria riga.
      changedNotificationIds: [mine],
    });
    expect((await readNotification(mine))?.status).toBe("handled");
    expect((await readNotification(mine))?.handledByUserId).toBe(maintainer.id);
    expect((await readNotification(theirs))?.status).toBe("open");
    // Il job non è stato toccato: `handled` è solo igiene dell'inbox.
    expect((await readJob(jobId))?.status).toBe("failed");
  });
});

describe("listInbox", () => {
  it("di default elenca solo le proprie notifiche aperte, con testo e azioni", async () => {
    const user = await seedUser("admin");
    const stranger = await seedUser("admin");
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const mine = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    await seedNotification({
      userId: stranger.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    await seedNotification({
      userId: user.id,
      kind: "job.pr_opened",
      event: planReviewEvent({ kind: "job.pr_opened", prUrl: "https://pr.test/1" }),
      status: "handled",
    });

    const { items, nextCursor } = await listInbox(db, { userId: user.id, lang: "it" });
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
    expect(items[0]!.id).toBe(mine);
    expect(items[0]!.text).toContain("Export CSV dello storico");
    // Testo piano: niente markup Slack né link renderizzati.
    expect(items[0]!.text).not.toContain("<https");
    expect(items[0]!.text).not.toContain("*");
    expect(items[0]!.url).toBe("https://stubwise.test/tickets/7");
    expect(items[0]!.actions).toEqual(["approve_plan", "reject_plan", "open", "snooze", "handled"]);
  });

  it("le azioni seguono il ruolo di chi legge", async () => {
    const member = await seedUser("member");
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    await seedNotification({
      userId: member.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });

    const { items } = await listInbox(db, { userId: member.id, lang: "it" });
    expect(items[0]!.actions).toEqual(["open", "snooze", "handled"]);
  });

  it("il testo è nella lingua richiesta", async () => {
    const user = await seedUser("admin");
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });

    const it = await listInbox(db, { userId: user.id, lang: "it" });
    const en = await listInbox(db, { userId: user.id, lang: "en" });
    expect(it.items[0]!.text).toContain("Piano in attesa di approvazione");
    expect(en.items[0]!.text).toContain("Plan awaiting approval");
  });

  it("riapre le snoozate scadute prima di leggere (lazy)", async () => {
    const user = await seedUser("admin");
    const scaduta = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "snoozed",
      snoozedUntil: new Date(Date.now() - 60_000),
    });
    const futura = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "snoozed",
      snoozedUntil: new Date(Date.now() + 3_600_000),
    });

    const { items } = await listInbox(db, { userId: user.id, lang: "it" });
    expect(items.map((i) => i.id)).toEqual([scaduta]);

    const riaperta = await readNotification(scaduta);
    expect(riaperta?.status).toBe("open");
    expect(riaperta?.snoozedUntil).toBeNull();
    expect((await readNotification(futura))?.status).toBe("snoozed");
  });

  it("filtra per stato e per progetto", async () => {
    const user = await seedUser("admin");
    const { projectId: altroProgetto } = await seedRepository(db);
    const qui = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      projectId: altroProgetto,
    });
    const chiusa = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "handled",
    });

    const filtrata = await listInbox(db, { userId: user.id, lang: "it", projectId });
    expect(filtrata.items.map((i) => i.id)).toEqual([qui]);

    const gestite = await listInbox(db, { userId: user.id, lang: "it", status: "handled" });
    expect(gestite.items.map((i) => i.id)).toEqual([chiusa]);
  });

  it("pagina in keyset dalla più recente", async () => {
    const user = await seedUser("admin");
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        await seedNotification({
          userId: user.id,
          kind: "job.plan_review",
          event: planReviewEvent(),
          createdAt: new Date(base - i * 1_000),
        }),
      );
    }

    const first = await listInbox(db, { userId: user.id, lang: "it", limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    expect(first.nextCursor).toBeTruthy();

    const second = await listInbox(db, {
      userId: user.id,
      lang: "it",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((i) => i.id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
  });

  it("espone chi ha gestito la notifica", async () => {
    const user = await seedUser("admin");
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
    });
    await executeAction(db, { notificationId: id, action: "approve_plan", actor: user });

    const { items } = await listInbox(db, { userId: user.id, lang: "it", status: "handled" });
    expect(items[0]!.handledBy).toEqual({ id: user.id, email: user.email });
  });

  it("una riga con event malformato degrada da sola: la lista resta intera", async () => {
    const user = await seedUser("admin");
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const base = Date.now();

    const sana = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      ticketId,
      jobId,
      createdAt: new Date(base),
    });
    // `limitUsd` arrivato come stringa: `event.limitUsd.toFixed(2)` LANCIA
    // dentro formatNotificationText.
    const esplode = await seedRawNotification({
      userId: user.id,
      kind: "job.budget_held",
      event: {
        kind: "job.budget_held",
        ticketNumber: 9,
        ticketTitle: "Titolo",
        projectName: "negozio-web",
        scope: "ticket",
        limitUsd: "molti",
        spentUsd: "moltissimi",
        ticketUrl: "https://stubwise.test/tickets/9",
      },
      createdAt: new Date(base - 1_000),
    });
    // Payload vuoto: nemmeno il `kind` dentro il jsonb. Il testo esplode e non
    // c'è alcun url.
    const vuota = await seedRawNotification({
      userId: user.id,
      kind: "job.failed",
      event: {},
      createdAt: new Date(base - 2_000),
    });
    // Non lancia, ma il campo `url` del payload non c'è: l'esito va validato
    // comunque, altrimenti la card linkerebbe a `undefined`.
    const senzaUrl = await seedRawNotification({
      userId: user.id,
      kind: "monitor.alert",
      event: {
        kind: "monitor.alert",
        serverName: "web-prod-1",
        condition: "disk",
        detail: "disco al 93%",
      },
      createdAt: new Date(base - 3_000),
    });

    const { items } = await listInbox(db, { userId: user.id, lang: "it" });
    // Nessun 500: ci sono TUTTE e quattro le righe.
    expect(items.map((i) => i.id)).toEqual([sana, esplode, vuota, senzaUrl]);

    expect(items[0]!.text).toContain("Piano in attesa di approvazione");
    expect(items[0]!.url).toBe("https://stubwise.test/tickets/7");

    // Le marce degradano: testo = kind (la colonna enum), nessun url.
    for (const item of [items[1]!, items[2]!]) {
      expect(item.text).toBe(item.kind);
      expect(item.url).toBeUndefined();
    }
    expect(items[1]!.kind).toBe("job.budget_held");

    // Il testo si rende, ma l'url mancante non diventa un link rotto.
    expect(items[3]!.text).toContain("web-prod-1");
    expect(items[3]!.url).toBeUndefined();

    // Le azioni si calcolano dalla COLONNA kind, non dal jsonb: la card
    // degradata resta azionabile.
    expect(items[0]!.actions).toContain("approve_plan");
    expect(items[1]!.actions).toContain("relaunch");
    expect(items[3]!.actions).toEqual(["open", "snooze", "handled"]);
  });

  it("cursore malformato → lista vuota e nessun errore", async () => {
    const user = await seedUser("admin");
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    const result = await listInbox(db, { userId: user.id, lang: "it", cursor: "non-un-cursore" });
    expect(result).toEqual({ items: [], nextCursor: null, invalidCursor: true });
  });
});

describe("unreadCount", () => {
  it("conta le aperte e le snoozate scadute, non le altre — e non scrive", async () => {
    const user = await seedUser("admin");
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    const scaduta = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "snoozed",
      snoozedUntil: new Date(Date.now() - 60_000),
    });
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "snoozed",
      snoozedUntil: new Date(Date.now() + 3_600_000),
    });
    await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
      status: "handled",
    });

    expect(await unreadCount(db, user.id)).toBe(2);
    // Il conteggio non riapre nulla: la scrittura è compito di `listInbox`.
    expect((await readNotification(scaduta))?.status).toBe("snoozed");
  });

  it("una notifica già letta resta nel conteggio (è 'da smaltire', non 'non letta')", async () => {
    const user = await seedUser("admin");
    const id = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    await markRead(db, { notificationId: id, userId: user.id });
    expect(await unreadCount(db, user.id)).toBe(1);
  });
});

describe("markRead", () => {
  it("segna la lettura una sola volta ed è idempotente", async () => {
    const user = await seedUser("admin");
    const id = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });

    expect(await markRead(db, { notificationId: id, userId: user.id })).toEqual({
      ok: true,
      changedNotificationIds: [id],
    });
    const first = (await readNotification(id))!.readAt!;
    expect(first).toBeInstanceOf(Date);

    // Seconda chiamata: nessuno stato cambiato, quindi nessun id da rispecchiare.
    expect(await markRead(db, { notificationId: id, userId: user.id })).toEqual({
      ok: true,
      changedNotificationIds: [],
    });
    expect((await readNotification(id))!.readAt!.getTime()).toBe(first.getTime());
  });

  it("notifica di un altro utente → not_found", async () => {
    const user = await seedUser("admin");
    const id = await seedNotification({
      userId: user.id,
      kind: "job.plan_review",
      event: planReviewEvent(),
    });
    expect(await markRead(db, { notificationId: id, userId: maintainer.id })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect((await readNotification(id))?.readAt).toBeNull();
  });
});

describe("invarianti dello schema", () => {
  it("nessuna riga resta snoozed senza scadenza", async () => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, "snoozed"), sql`${notifications.snoozedUntil} is null`));
    expect(rows).toEqual([]);
  });

  it("handled e handled_at restano coerenti", async () => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, "handled"), sql`${notifications.handledAt} is null`));
    expect(rows).toEqual([]);
  });
});
