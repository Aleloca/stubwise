import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentQuestions, aiJobs, comments, notifications, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { formatNotificationText, type NotificationEvent } from "@stubwise/notifications";
import { buildApp } from "../app.js";
import { createTicket } from "../db/tickets.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Test delle rotte `/api/inbox`. Le regole (permessi, propagazione, errori)
 * sono già coperte da `services/inbox.test.ts`: qui si verifica ciò che
 * aggiunge lo strato HTTP — autenticazione, validazione della query, mappatura
 * degli errori tipizzati sugli status code e forma delle risposte.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let seeded: SeededUsers;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  seeded = await seedUsers(app);
  ({ projectId } = await seedRepository(db));
  ({ projectId: otherProjectId } = await seedRepository(db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

// --- Fixture ---

/** Evento `job.plan_review` realistico, con override per gli altri kind. */
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

/** Evento `job.awaiting_input` realistico: il kind NON archiviabile. */
function awaitingInputEvent(questionId: string = randomUUID()): NotificationEvent {
  return {
    kind: "job.awaiting_input",
    ticketNumber: 7,
    ticketTitle: "Export CSV dello storico",
    projectName: "negozio-web",
    ticketUrl: "https://stubwise.test/tickets/7",
    questionId,
    round: 1,
    question: "Il CSV va esportato con le colonne del vecchio report o con quelle nuove?",
    options: [{ label: "Colonne vecchie" }, { label: "Colonne nuove" }],
    recommendedIndex: 0,
    allowFreeText: true,
  };
}

/** Inserisce una riga di inbox e ne restituisce l'id. */
async function seedNotification(input: {
  userId: string;
  kind?: NotificationEvent["kind"];
  event?: NotificationEvent;
  ticketId?: string | null;
  jobId?: string | null;
  projectId?: string | null;
  status?: "open" | "handled" | "snoozed";
  snoozedUntil?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const status = input.status ?? "open";
  const event = input.event ?? planReviewEvent();
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      kind: input.kind ?? event.kind,
      event: event as unknown as Record<string, unknown>,
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

/** Crea un ticket nel progetto di test, con `implementationPlan` opzionale. */
async function seedTicket(plan?: string): Promise<string> {
  const ticket = await createTicket(db, {
    projectId,
    title: `Ticket ${randomUUID().slice(0, 8)}`,
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
  status:
    | "queued"
    | "fixing"
    | "awaiting_plan_approval"
    | "awaiting_input"
    | "failed"
    | "pr_merged",
): Promise<string> {
  const [row] = await db.insert(aiJobs).values({ ticketId, status }).returning({ id: aiJobs.id });
  return row!.id;
}

/** Svuota l'inbox di entrambi gli utenti: i test della lista contano le righe. */
async function clearInbox(): Promise<void> {
  await db.delete(notifications);
}

/** Legge la riga di notifica per id. */
async function readNotification(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

/** Legge il job per id. */
async function readJob(id: string) {
  const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
  return row;
}

// --- Chiamate HTTP ---

function getInbox(query: Record<string, string> = {}, cookie = seeded.adminCookie) {
  return app.inject({ method: "GET", url: "/api/inbox", query, headers: { cookie } });
}

function post(url: string, cookie: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

interface InboxItemBody {
  id: string;
  kind: string;
  status: string;
  text: string;
  url?: string;
  actions: string[];
  question?: {
    questionId: string;
    round: number;
    question: string;
    options: { label: string; consequence?: string }[];
    recommendedIndex?: number;
    allowFreeText: boolean;
  };
  projectId: string | null;
  ticketId: string | null;
  jobId: string | null;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  handledAt: string | null;
  handledBy: { id: string; email: string } | null;
}

interface InboxPageBody {
  items: InboxItemBody[];
  nextCursor: string | null;
}

describe("autenticazione", () => {
  it("tutte le rotte inbox rispondono 401 senza sessione", async () => {
    const id = randomUUID();
    const calls = [
      app.inject({ method: "GET", url: "/api/inbox" }),
      app.inject({ method: "GET", url: "/api/inbox/unread-count" }),
      app.inject({ method: "POST", url: `/api/inbox/${id}/read` }),
      app.inject({ method: "POST", url: `/api/inbox/${id}/snooze`, payload: { until: "1h" } }),
      app.inject({ method: "POST", url: `/api/inbox/${id}/handled` }),
      app.inject({ method: "POST", url: `/api/inbox/${id}/actions/relaunch` }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("GET /api/inbox", () => {
  it("restituisce solo le notifiche dell'utente, con testo localizzato e azioni", async () => {
    await clearInbox();
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const event = planReviewEvent();
    const mine = await seedNotification({ userId: seeded.adminId, event, ticketId, jobId });
    await seedNotification({ userId: seeded.memberId, event, ticketId, jobId });

    const res = await getInbox();
    expect(res.statusCode).toBe(200);
    const body = res.json() as InboxPageBody;
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.id).toBe(mine);
    expect(item.kind).toBe("job.plan_review");
    expect(item.status).toBe("open");
    // Il testo viene dalla stessa fonte dei webhook, nella lingua dell'utente.
    expect(item.text).toBe(formatNotificationText(event, "en"));
    expect(item.url).toBe("https://stubwise.test/tickets/7");
    // Admin su un piano fermo sul gate: vede le decisioni, poi l'igiene.
    expect(item.actions).toEqual(["approve_plan", "reject_plan", "open", "snooze", "handled"]);
    expect(item.projectId).toBe(projectId);
    expect(item.ticketId).toBe(ticketId);
    expect(item.jobId).toBe(jobId);
    expect(item.handledBy).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it("rende il testo nella lingua dell'utente", async () => {
    await clearInbox();
    await db.update(users).set({ language: "it" }).where(eq(users.id, seeded.memberId));
    const event = planReviewEvent();
    await seedNotification({ userId: seeded.memberId, event });

    const res = await getInbox({}, seeded.memberCookie);
    const body = res.json() as InboxPageBody;
    expect(body.items[0]!.text).toBe(formatNotificationText(event, "it"));
    expect(body.items[0]!.text).not.toBe(formatNotificationText(event, "en"));
    await db.update(users).set({ language: "en" }).where(eq(users.id, seeded.memberId));
  });

  it("un member non vede le azioni decisionali riservate agli admin", async () => {
    await clearInbox();
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await getInbox({}, seeded.memberCookie);
    const item = (res.json() as InboxPageBody).items[0]!;
    expect(item.actions).toEqual(["open", "snooze", "handled"]);
  });

  it("filtra per progetto", async () => {
    await clearInbox();
    const mine = await seedNotification({ userId: seeded.adminId, projectId });
    await seedNotification({ userId: seeded.adminId, projectId: otherProjectId });

    const res = await getInbox({ projectId });
    const body = res.json() as InboxPageBody;
    expect(body.items.map((i) => i.id)).toEqual([mine]);
  });

  it("filtra per stato: default open, poi handled e snoozed", async () => {
    await clearInbox();
    const open = await seedNotification({ userId: seeded.adminId });
    const handled = await seedNotification({ userId: seeded.adminId, status: "handled" });
    const snoozed = await seedNotification({
      userId: seeded.adminId,
      status: "snoozed",
      snoozedUntil: new Date(Date.now() + 3_600_000),
    });

    expect(((await getInbox()).json() as InboxPageBody).items.map((i) => i.id)).toEqual([open]);
    expect(
      ((await getInbox({ status: "handled" })).json() as InboxPageBody).items.map((i) => i.id),
    ).toEqual([handled]);
    expect(
      ((await getInbox({ status: "snoozed" })).json() as InboxPageBody).items.map((i) => i.id),
    ).toEqual([snoozed]);
  });

  it("rifiuta uno stato fuori enum", async () => {
    const res = await getInbox({ status: "archiviata" });
    expect(res.statusCode).toBe(400);
  });

  it("pagina con nextCursor e non ripete le righe", async () => {
    await clearInbox();
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedNotification({
          userId: seeded.adminId,
          createdAt: new Date(base - i * 1000),
        }),
      );
    }

    const first = (await getInbox({ limit: "2" })).json() as InboxPageBody;
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (
      await getInbox({ limit: "2", cursor: first.nextCursor! })
    ).json() as InboxPageBody;
    expect(second.items.map((i) => i.id)).toEqual(ids.slice(2, 4));

    const third = (
      await getInbox({ limit: "2", cursor: second.nextCursor! })
    ).json() as InboxPageBody;
    expect(third.items.map((i) => i.id)).toEqual(ids.slice(4));
    expect(third.nextCursor).toBeNull();
  });

  it("400 invalid_cursor su un cursore malformato", async () => {
    const res = await getInbox({ cursor: "non-un-cursore" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("rifiuta un limit fuori intervallo", async () => {
    expect((await getInbox({ limit: "0" })).statusCode).toBe(400);
    expect((await getInbox({ limit: "101" })).statusCode).toBe(400);
  });
});

describe("GET /api/inbox/unread-count", () => {
  it("conta le proprie notifiche da smaltire", async () => {
    await clearInbox();
    await seedNotification({ userId: seeded.adminId });
    await seedNotification({ userId: seeded.adminId });
    await seedNotification({ userId: seeded.adminId, status: "handled" });
    await seedNotification({ userId: seeded.memberId });

    const res = await app.inject({
      method: "GET",
      url: "/api/inbox/unread-count",
      headers: { cookie: seeded.adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
  });
});

describe("POST /api/inbox/:id/read", () => {
  it("204 e idempotente: read_at è il momento della PRIMA apertura", async () => {
    const id = await seedNotification({ userId: seeded.adminId });

    const first = await post(`/api/inbox/${id}/read`, seeded.adminCookie);
    expect(first.statusCode).toBe(204);
    const readAt = (await readNotification(id))?.readAt;
    expect(readAt).toBeInstanceOf(Date);

    const second = await post(`/api/inbox/${id}/read`, seeded.adminCookie);
    expect(second.statusCode).toBe(204);
    expect((await readNotification(id))?.readAt?.getTime()).toBe(readAt?.getTime());
  });

  it("404 sulla notifica di un altro utente", async () => {
    const id = await seedNotification({ userId: seeded.memberId });
    const res = await post(`/api/inbox/${id}/read`, seeded.adminCookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("POST /api/inbox/:id/snooze", () => {
  it.each(["1h", "tomorrow", "3d"] as const)("rinvia con durata %s", async (until) => {
    const id = await seedNotification({ userId: seeded.adminId });
    const res = await post(`/api/inbox/${id}/snooze`, seeded.adminCookie, { until });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { snoozedUntil: string };
    expect(new Date(body.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
    const row = await readNotification(id);
    expect(row?.status).toBe("snoozed");
    expect(row?.snoozedUntil).toBeInstanceOf(Date);
  });

  it("rifiuta una durata fuori enum", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    const res = await post(`/api/inbox/${id}/snooze`, seeded.adminCookie, { until: "1 settimana" });
    expect(res.statusCode).toBe(400);
  });

  it("409 already_handled su una notifica già chiusa", async () => {
    const id = await seedNotification({ userId: seeded.adminId, status: "handled" });
    const res = await post(`/api/inbox/${id}/snooze`, seeded.adminCookie, { until: "1h" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "already_handled" });
  });

  it("404 sulla notifica di un altro utente", async () => {
    const id = await seedNotification({ userId: seeded.memberId });
    const res = await post(`/api/inbox/${id}/snooze`, seeded.adminCookie, { until: "1h" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/inbox/:id/handled", () => {
  it("204 e chiude la sola riga propria", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "failed");
    const mine = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const theirs = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await post(`/api/inbox/${mine}/handled`, seeded.adminCookie);
    expect(res.statusCode).toBe(204);
    expect((await readNotification(mine))?.status).toBe("handled");
    expect((await readNotification(mine))?.handledByUserId).toBe(seeded.adminId);
    expect((await readNotification(theirs))?.status).toBe("open");
  });

  it("409 already_handled alla seconda chiamata", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    expect((await post(`/api/inbox/${id}/handled`, seeded.adminCookie)).statusCode).toBe(204);
    const res = await post(`/api/inbox/${id}/handled`, seeded.adminCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "already_handled",
      handledBy: { id: seeded.adminId, email: "admin@example.com" },
    });
  });

  it("400 su una domanda dell'agente: non archiviabile, e nulla si muove", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "awaiting_input");
    const id = await seedNotification({
      userId: seeded.adminId,
      event: awaitingInputEvent(),
      ticketId,
      jobId,
    });

    const res = await post(`/api/inbox/${id}/handled`, seeded.adminCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_action" });

    // L'invariante è sullo STATO, non sulla risposta: la domanda resta aperta e
    // il job resta parcheggiato ad aspettarla. Se la guardia arrivasse dopo
    // l'UPDATE, qui si vedrebbe una riga archiviata con un 400 addosso.
    const row = await readNotification(id);
    expect(row?.status).toBe("open");
    expect(row?.handledAt).toBeNull();
    expect(row?.handledByUserId).toBeNull();
    expect((await readJob(jobId))?.status).toBe("awaiting_input");
  });
});

describe("POST /api/inbox/:id/actions/:action", () => {
  it("approve_plan da admin: 200, job in coda e copie chiuse", async () => {
    const ticketId = await seedTicket("## Piano\n1. Passo A");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const mine = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    const theirs = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await post(`/api/inbox/${mine}/actions/approve_plan`, seeded.adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; jobId?: string; changedNotificationIds: string[] };
    expect(body.kind).toBe("job.plan_review");
    expect(body.jobId).toBe(jobId);
    expect([...body.changedNotificationIds].sort()).toEqual([mine, theirs].sort());

    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("execute");
  });

  it("approve_plan da member: 403", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.memberId, ticketId, jobId });

    const res = await post(`/api/inbox/${id}/actions/approve_plan`, seeded.memberCookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden" });
    expect((await readJob(jobId))?.status).toBe("awaiting_plan_approval");
  });

  it("approve_plan su una notifica già gestita: 409 con handledBy", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });

    expect(
      (await post(`/api/inbox/${id}/actions/approve_plan`, seeded.adminCookie)).statusCode,
    ).toBe(200);
    const res = await post(`/api/inbox/${id}/actions/approve_plan`, seeded.adminCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "already_handled",
      handledBy: { id: seeded.adminId, email: "admin@example.com" },
    });
  });

  it("reject_plan con istruzioni: le scrive come commento del team", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });

    const res = await post(`/api/inbox/${id}/actions/reject_plan`, seeded.adminCookie, {
      instructions: "Usa il repository dei report, non quello del checkout",
    });
    expect(res.statusCode).toBe(200);

    const rows = await db
      .select({ body: comments.body, authorType: comments.authorType })
      .from(comments)
      .where(eq(comments.ticketId, ticketId))
      .orderBy(desc(comments.createdAt));
    expect(rows.some((r) => r.body.includes("repository dei report"))).toBe(true);
    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("fix");
    expect(job?.planText).toBeNull();
  });

  it("approve_plan senza piano fermo sul gate: 409 plan_not_pending", async () => {
    const ticketId = await seedTicket("## Piano");
    const jobId = await seedJob(ticketId, "awaiting_plan_approval");
    const id = await seedNotification({ userId: seeded.adminId, ticketId, jobId });
    // Il job avanza da sotto: la notifica resta aperta ma il gate non c'è più.
    await db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, jobId));

    const res = await post(`/api/inbox/${id}/actions/approve_plan`, seeded.adminCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "plan_not_pending" });
  });

  it("relaunch su un job fallito: 200 e job riaccodato", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "failed");
    const id = await seedNotification({
      userId: seeded.memberId,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed" }),
      ticketId,
      jobId,
    });

    const res = await post(`/api/inbox/${id}/actions/relaunch`, seeded.memberCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; jobId?: string; changedNotificationIds: string[] };
    expect(body.kind).toBe("job.failed");
    expect(body.jobId).toBe(jobId);
    expect(body.changedNotificationIds).toEqual([id]);
    expect((await readJob(jobId))?.status).toBe("queued");
  });

  it("relaunch con un job in volo: 409 job_in_flight", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "fixing");
    const id = await seedNotification({
      userId: seeded.adminId,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed" }),
      ticketId,
      jobId,
    });

    const res = await post(`/api/inbox/${id}/actions/relaunch`, seeded.adminCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "job_in_flight" });
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("relaunch su un kind che non lo offre: 400 invalid_action", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "pr_merged");
    const id = await seedNotification({
      userId: seeded.adminId,
      kind: "job.pr_opened",
      event: planReviewEvent({
        kind: "job.pr_opened",
        prUrl: "https://git.test/pr/1",
      } as Partial<NotificationEvent>),
      ticketId,
      jobId,
    });

    const res = await post(`/api/inbox/${id}/actions/relaunch`, seeded.adminCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_action" });
  });

  it("snooze non passa da /actions: 400", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    const res = await post(`/api/inbox/${id}/actions/snooze`, seeded.adminCookie, { until: "1h" });
    expect(res.statusCode).toBe(400);
    expect((await readNotification(id))?.status).toBe("open");
  });

  it("404 sulla notifica di un altro utente", async () => {
    const ticketId = await seedTicket();
    const jobId = await seedJob(ticketId, "failed");
    const id = await seedNotification({
      userId: seeded.memberId,
      kind: "job.failed",
      event: planReviewEvent({ kind: "job.failed" }),
      ticketId,
      jobId,
    });
    const res = await post(`/api/inbox/${id}/actions/relaunch`, seeded.adminCookie);
    expect(res.statusCode).toBe(404);
    expect((await readJob(jobId))?.status).toBe("failed");
  });

  it("404 su un id inesistente", async () => {
    const res = await post(`/api/inbox/${randomUUID()}/actions/relaunch`, seeded.adminCookie);
    expect(res.statusCode).toBe(404);
  });

  it("rifiuta un id di notifica non-uuid", async () => {
    const res = await post("/api/inbox/non-un-uuid/actions/relaunch", seeded.adminCookie);
    expect(res.statusCode).toBe(400);
  });
});

/** Nessun test tocca `notification_deliveries`: è materia del Task 9/10. */
describe("guardia di coerenza", () => {
  it("una notifica chiusa non conserva snoozed_until", async () => {
    const id = await seedNotification({ userId: seeded.adminId });
    await post(`/api/inbox/${id}/snooze`, seeded.adminCookie, { until: "1h" });
    await post(`/api/inbox/${id}/handled`, seeded.adminCookie);
    const row = await readNotification(id);
    expect(row?.status).toBe("handled");
    expect(row?.snoozedUntil).toBeNull();
  });

  it("non tocca le notifiche di altri progetti nel conteggio", async () => {
    await clearInbox();
    await seedNotification({ userId: seeded.adminId, projectId: otherProjectId });
    const res = await app.inject({
      method: "GET",
      url: "/api/inbox/unread-count",
      headers: { cookie: seeded.adminCookie },
    });
    // Il conteggio è per UTENTE, non per progetto: la riga c'è.
    expect(res.json()).toEqual({ count: 1 });
    await db
      .delete(notifications)
      .where(
        and(eq(notifications.userId, seeded.adminId), eq(notifications.projectId, otherProjectId)),
      );
  });
});

describe("POST /api/inbox/:id/actions/answer", () => {
  /** Ticket + job parcheggiato su una domanda aperta, con la copia di inbox. */
  async function seedQuestion(options: { requestedByUserId?: string } = {}) {
    const ticketId = await seedTicket();
    const [job] = await db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_input",
        ...(options.requestedByUserId ? { requestedByUserId: options.requestedByUserId } : {}),
      })
      .returning({ id: aiJobs.id });
    const [question] = await db
      .insert(agentQuestions)
      .values({
        jobId: job!.id,
        ticketId,
        round: 1,
        question: "Quali colonne deve avere il CSV?",
        options: [{ label: "Colonne vecchie" }, { label: "Colonne nuove" }],
        recommendedIndex: 0,
        allowFreeText: true,
      })
      .returning({ id: agentQuestions.id });
    const notificationId = await seedNotification({
      userId: options.requestedByUserId ?? seeded.adminId,
      event: awaitingInputEvent(question!.id),
      ticketId,
      jobId: job!.id,
    });
    return { ticketId, jobId: job!.id, questionId: question!.id, notificationId };
  }

  it("200: risposta scritta, job in coda e copie chiuse", async () => {
    const { jobId, questionId, notificationId } = await seedQuestion();
    const res = await post(`/api/inbox/${notificationId}/actions/answer`, seeded.adminCookie, {
      optionIndex: 1,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { kind: string; jobId?: string; changedNotificationIds: string[] };
    expect(body.kind).toBe("job.awaiting_input");
    expect(body.jobId).toBe(jobId);
    expect(body.changedNotificationIds).toEqual([notificationId]);

    const [question] = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, questionId));
    expect(question?.answer).toEqual({ optionIndex: 1 });
    const job = await readJob(jobId);
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("plan_continue");
  });

  it("200 col testo libero", async () => {
    const { questionId, notificationId } = await seedQuestion();
    const res = await post(`/api/inbox/${notificationId}/actions/answer`, seeded.adminCookie, {
      text: "  Colonne nuove, senza header  ",
    });
    expect(res.statusCode).toBe(200);
    const [question] = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, questionId));
    expect(question?.answer).toEqual({ text: "Colonne nuove, senza header" });
  });

  it("400 senza campi, con entrambi, o con un indice fuori range", async () => {
    const { notificationId, jobId } = await seedQuestion();
    for (const payload of [
      {},
      { optionIndex: 0, text: "anche" },
      { optionIndex: 9 },
      { optionIndex: -1 },
    ]) {
      const res = await post(
        `/api/inbox/${notificationId}/actions/answer`,
        seeded.adminCookie,
        payload,
      );
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Nulla si è mosso: il job resta parcheggiato ad aspettare.
    expect((await readJob(jobId))?.status).toBe("awaiting_input");
  });

  it("403 per un member che non ha chiesto il run", async () => {
    const { notificationId } = await seedQuestion();
    // La notifica è dell'admin: al member serve la SUA copia per arrivare al
    // controllo di permesso (altrimenti sarebbe un 404).
    const row = await readNotification(notificationId);
    const mine = await seedNotification({
      userId: seeded.memberId,
      event: awaitingInputEvent(),
      ticketId: row!.ticketId,
      jobId: row!.jobId,
    });
    const res = await post(`/api/inbox/${mine}/actions/answer`, seeded.memberCookie, {
      optionIndex: 0,
    });
    expect(res.statusCode).toBe(403);
  });

  it("409 alla seconda risposta, con chi ha risposto", async () => {
    const { notificationId } = await seedQuestion();
    expect(
      (
        await post(`/api/inbox/${notificationId}/actions/answer`, seeded.adminCookie, {
          optionIndex: 0,
        })
      ).statusCode,
    ).toBe(200);
    const res = await post(`/api/inbox/${notificationId}/actions/answer`, seeded.adminCookie, {
      optionIndex: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "already_handled",
      handledBy: { id: seeded.adminId, email: "admin@example.com" },
    });
  });

  it("409 question_not_pending se il job non è più in attesa", async () => {
    const { notificationId, jobId } = await seedQuestion();
    await db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, jobId));
    const res = await post(`/api/inbox/${notificationId}/actions/answer`, seeded.adminCookie, {
      optionIndex: 0,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "question_not_pending" });
  });

  it("la lista espone la domanda della card", async () => {
    await clearInbox();
    const { questionId } = await seedQuestion();
    const res = await getInbox();
    const body = res.json() as InboxPageBody;
    const item = body.items.find((i) => i.kind === "job.awaiting_input");
    expect(item?.question).toMatchObject({
      round: 1,
      options: [{ label: "Colonne vecchie" }, { label: "Colonne nuove" }],
      recommendedIndex: 0,
      allowFreeText: true,
    });
    // L'id della domanda arriva dal payload dell'EVENTO (autosufficiente): la
    // riga `agent_questions` non viene riletta per disegnare la card.
    expect(item?.question?.questionId).toBe(questionId);
    // Kind non archiviabile: la card offre answer, mai handled.
    expect(item?.actions).toContain("answer");
    expect(item?.actions).not.toContain("handled");
  });
});
