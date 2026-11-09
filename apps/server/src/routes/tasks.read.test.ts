import { randomBytes } from "node:crypto";
import {
  agentQuestions,
  aiJobs,
  comments,
  departments,
  projectStatuses,
  projects,
  ticketEvents,
  ticketLinks,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedDecisionRequest, seedDepartment, seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  stalledTaskViewSchema,
  taskActivityEntryViewSchema,
  taskListResponseSchema,
  taskViewSchema,
  taskWorkViewSchema,
} from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
/** Progetto in cui il member è Project Lead. */
let projectId: string;
let repositoryId: string;
let projectCode: string;
/** Progetto che il member NON vede. */
let hiddenProjectId: string;
let hiddenCode: string;
let number = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  await addMember(app, projectId, users.memberId, "project_lead");
  hiddenProjectId = (await seedRepository(testDb.db)).projectId;
  const codes = await testDb.db.select({ id: projects.id, code: projects.code }).from(projects);
  projectCode = codes.find((p) => p.id === projectId)!.code;
  hiddenCode = codes.find((p) => p.id === hiddenProjectId)!.code;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function statusId(pid: string, name: string): Promise<string> {
  const [row] = await testDb.db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, pid), eq(projectStatuses.name, name)));
  return row!.id;
}

async function insertTask(
  opts: {
    pid?: string;
    title?: string;
    type?: "bug" | "feature" | "task" | "feedback" | "review";
    effort?: number | null;
    assigneeId?: string | null;
    departmentId?: string;
    status?: string;
  } = {},
): Promise<{ id: string; number: number }> {
  number += 1;
  const pid = opts.pid ?? projectId;
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId: pid,
      number,
      title: opts.title ?? `Task ${number}`,
      type: opts.type ?? "bug",
      priority: "medium",
      source: "manual",
      effort: opts.effort ?? null,
      assigneeId: opts.assigneeId === undefined ? users.memberId : opts.assigneeId,
      ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
      ...(opts.status ? { statusId: await statusId(pid, opts.status) } : {}),
    })
    .returning({ id: tickets.id, number: tickets.number });
  return row!;
}

const get = (url: string, cookie = users.memberCookie) =>
  app.inject({ method: "GET", url, headers: { cookie } });

async function list(query: string): Promise<{ id: string; code: string }[]> {
  const res = await get(`/api/tasks?projectIds=${projectId}${query}`);
  expect(res.statusCode).toBe(200);
  return taskListResponseSchema.parse(res.json()).items;
}

describe("GET /api/tasks", () => {
  it("filtra per famiglia, reparto, assegnatario, taglia, testo", async () => {
    const dept = await seedDepartment(testDb.db, { name: "Filtri" });
    const a = await insertTask({ title: "Carrello vuoto", effort: 1, status: "In progress", departmentId: dept.id });
    const b = await insertTask({ title: "Login lento", effort: 5, assigneeId: null });
    const ids = async (q: string) => (await list(q)).map((t) => t.id);
    expect(await ids("&families=active")).toContain(a.id);
    expect(await ids("&families=active")).not.toContain(b.id);
    expect(await ids(`&departmentIds=${dept.id}`)).toEqual([a.id]);
    expect(await ids("&assigneeIds=none")).toContain(b.id);
    expect(await ids("&assigneeIds=none")).not.toContain(a.id);
    expect(await ids("&sizes=XS")).toEqual([a.id]);
    expect(await ids("&sizes=XL")).toEqual([b.id]);
    expect(await ids("&text=carrello")).toEqual([a.id]);
    expect(await ids(`&text=${projectCode.toLowerCase()}-${b.number}`)).toEqual([b.id]);
  });

  it("ogni risposta parsa con lo schema condiviso, e il codice è CODICE-numero", async () => {
    const t = await insertTask({ effort: 3 });
    const res = await get(`/api/tasks?projectIds=${projectId}`);
    const body = taskListResponseSchema.parse(res.json());
    expect(body.truncated).toBe(false);
    const view = body.items.find((i) => i.id === t.id)!;
    expect(view).toMatchObject({ code: `${projectCode}-${t.number}`, size: "M", ticketId: t.id, number: t.number });
    taskViewSchema.array().parse(body.items);
  });

  it("feedback si legge come feature, review come activity", async () => {
    const f = await insertTask({ type: "feedback" });
    const r = await insertTask({ type: "review" });
    const items = await list("");
    expect(items.find((i) => i.id === f.id)).toMatchObject({ type: "feature" });
    expect(items.find((i) => i.id === r.id)).toMatchObject({ type: "activity" });
  });

  it("una task di un progetto non visibile non compare nell'elenco", async () => {
    const hidden = await insertTask({ pid: hiddenProjectId });
    const res = await get("/api/tasks");
    const items = taskListResponseSchema.parse(res.json()).items;
    expect(items.map((i) => i.id)).not.toContain(hidden.id);
    expect(items.every((i) => i.projectId === projectId)).toBe(true);
  });

  it("senza tickets.view_all si vedono solo le task chieste da sé", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "contributor");
    const mine = await insertTask({ pid });
    await testDb.db.update(tickets).set({ requestedByUserId: users.memberId }).where(eq(tickets.id, mine.id));
    const other = await insertTask({ pid });
    const items = taskListResponseSchema.parse((await get(`/api/tasks?projectIds=${pid}`)).json()).items;
    expect(items.map((i) => i.id)).toEqual([mine.id]);
    expect((await get(`/api/tasks/${other.id}/activity`)).statusCode).toBe(404);
  });
});

describe("scadenza", () => {
  it("il filtro periodo due trova la task, e la vista porta la scadenza", async () => {
    const t = await insertTask();
    const today = new Date().toISOString().slice(0, 10);
    await testDb.db.update(tickets).set({ dueDate: today }).where(eq(tickets.id, t.id));
    const items = await list("&periodField=due&periodPreset=last7");
    expect(items.map((i) => i.id)).toEqual([t.id]);
    expect(taskViewSchema.parse(items[0]).dueDate).toBe(today);
    expect(await list(`&periodField=due&periodFrom=2000-01-01&periodTo=2000-01-02`)).toEqual([]);
    expect(await list("&periodField=plannedWeek&periodPreset=thisWeek")).toEqual([]);
  });
});

describe("tetto e collegamenti", () => {
  it("col filtro stalled, oltre il tetto l'elenco dice truncated anche se ne resta poco", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "project_lead");
    // 2001 task in To do, nessuna ferma: senza il fix `truncated` sarebbe false.
    await testDb.db.execute(sql`
      insert into tickets (project_id, number, title, type, priority, source)
      select ${pid}, g, 'Tanta ' || g, 'bug', 'medium', 'manual' from generate_series(1, 2001) g
    `);
    const body = taskListResponseSchema.parse((await get(`/api/tasks?projectIds=${pid}&stalled=true`)).json());
    expect(body.truncated).toBe(true);
  }, 60_000);

  it("un collegamento verso una task che chi guarda non vede non compare", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "contributor");
    const mine = await insertTask({ pid });
    await testDb.db.update(tickets).set({ requestedByUserId: users.memberId }).where(eq(tickets.id, mine.id));
    const visibleToo = await insertTask({ pid });
    await testDb.db.update(tickets).set({ requestedByUserId: users.memberId }).where(eq(tickets.id, visibleToo.id));
    const hidden = await insertTask({ pid });
    await testDb.db.insert(ticketLinks).values([
      { sourceTicketId: mine.id, targetTicketId: hidden.id, kind: "blocks" },
      { sourceTicketId: mine.id, targetTicketId: visibleToo.id, kind: "relates_to" },
    ]);
    const items = taskListResponseSchema.parse((await get(`/api/tasks?projectIds=${pid}`)).json()).items;
    const view = items.find((i) => i.id === mine.id)!;
    expect(view.links).toEqual([{ kind: "relates", taskId: visibleToo.id }]);
  });
});

describe("GET /api/tasks/by-code/:code", () => {
  it("restituisce la task, anche col codice in minuscolo", async () => {
    const t = await insertTask();
    const res = await get(`/api/tasks/by-code/${projectCode.toLowerCase()}-${t.number}`);
    expect(res.statusCode).toBe(200);
    expect(taskViewSchema.parse(res.json()).id).toBe(t.id);
  });

  it("una task di un progetto non visibile per codice → 404 not_found", async () => {
    const hidden = await insertTask({ pid: hiddenProjectId });
    const res = await get(`/api/tasks/by-code/${hiddenCode}-${hidden.number}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
    const missing = await get(`/api/tasks/by-code/${projectCode}-99999`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(res.json());
  });
});

describe("GET /api/tasks/stalled", () => {
  it("stalled: manuale, decisione aperta, bloccata, senza assegnatario, inattiva da 8 giorni su active", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "project_lead");
    const manual = await insertTask({ pid, status: "In progress" });
    await testDb.db
      .update(tickets)
      .set({ manualStallReason: "Aspetta il fornitore", manualStallNote: "mail", manualStallSince: new Date() })
      .where(eq(tickets.id, manual.id));
    const decision = await insertTask({ pid, status: "In progress" });
    await seedDecisionRequest(testDb.db, { ticketId: decision.id, askedOfUserId: users.adminId });
    const blocker = await insertTask({ pid, status: "In progress" });
    const blocked = await insertTask({ pid, status: "In progress" });
    await testDb.db
      .insert(ticketLinks)
      .values({ sourceTicketId: blocker.id, targetTicketId: blocked.id, kind: "blocks" });
    const unassigned = await insertTask({ pid, status: "In progress", assigneeId: null });
    const idle = await insertTask({ pid, status: "In progress" });
    await testDb.db
      .update(tickets)
      .set({ updatedAt: sql`now() - interval '8 days'` })
      .where(eq(tickets.id, idle.id));
    await testDb.db
      .update(tickets)
      .set({ updatedAt: sql`now() - interval '9 days'` })
      .where(eq(tickets.id, blocker.id));
    const fresh = await insertTask({ pid, status: "In progress" });

    const res = await get(`/api/tasks/stalled?projectIds=${pid}`);
    expect(res.statusCode).toBe(200);
    const body = stalledTaskViewSchema.array().parse(res.json());
    const kindOf = (id: string) => body.find((s) => s.task.id === id)?.stall.reason;
    expect(kindOf(manual.id)).toEqual({ kind: "manual", reason: "Aspetta il fornitore", note: "mail" });
    expect(kindOf(decision.id)).toEqual({ kind: "decision", personId: users.adminId });
    expect(kindOf(blocked.id)).toEqual({ kind: "blocked_by", taskId: blocker.id });
    expect(kindOf(unassigned.id)).toEqual({ kind: "unassigned" });
    expect(kindOf(idle.id)).toEqual({ kind: "idle" });
    expect(kindOf(blocker.id)).toEqual({ kind: "idle" });
    expect(kindOf(fresh.id)).toBeUndefined();
    // Ordinate per `since` crescente.
    const sinces = body.map((s) => s.stall.since);
    expect([...sinces].sort()).toEqual(sinces);
    // Il filtro `stalled` dell'elenco usa la stessa regola.
    const stalledIds = taskListResponseSchema
      .parse((await get(`/api/tasks?projectIds=${pid}&stalled=true`)).json())
      .items.map((i) => i.id)
      .sort();
    expect(stalledIds).toEqual(body.map((s) => s.task.id).sort());
  });

  it("una domanda di Claude aperta ferma la task", async () => {
    const t = await insertTask({ status: "In progress" });
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId: t.id, status: "awaiting_input" })
      .returning({ id: aiJobs.id });
    await testDb.db.insert(agentQuestions).values({
      jobId: job!.id,
      ticketId: t.id,
      round: 1,
      question: "Quale?",
      options: [{ label: "A" }, { label: "B" }],
    });
    const body = stalledTaskViewSchema.array().parse((await get(`/api/tasks/stalled?projectIds=${projectId}`)).json());
    expect(body.find((s) => s.task.id === t.id)?.stall.reason).toEqual({ kind: "claude_question" });
    expect(body.find((s) => s.task.id === t.id)?.task.claude).toBe("awaiting_answer");
  });
});

describe("GET /api/tasks/:ticketId/activity", () => {
  it("activity contiene commento, cambio di stato e decisione in ordine", async () => {
    const t = await insertTask();
    await testDb.db.insert(comments).values({
      ticketId: t.id,
      authorType: "user",
      authorId: users.memberId,
      body: "Primo",
      createdAt: new Date(Date.now() - 3000),
    });
    await testDb.db.insert(ticketEvents).values({
      ticketId: t.id,
      actorId: users.memberId,
      kind: "status_changed",
      payload: { from: "open", to: "in_progress" },
      createdAt: new Date(Date.now() - 2000),
    });
    const { id: decisionId } = await seedDecisionRequest(testDb.db, {
      ticketId: t.id,
      askedOfUserId: users.adminId,
      askedByUserId: users.memberId,
    });
    const res = await get(`/api/tasks/${t.id}/activity`);
    expect(res.statusCode).toBe(200);
    const entries = taskActivityEntryViewSchema.array().parse(res.json());
    expect(entries.map((e) => e.kind)).toEqual(["comment", "field_change", "decision"]);
    expect(entries[0]).toMatchObject({ body: "Primo", authorId: users.memberId });
    // Evento vecchio (solo enum): il primo stato del progetto con quel legacy_status.
    expect(entries[1]).toMatchObject({ field: "status", from: "To do", to: "In progress" });
    expect(entries[2]).toMatchObject({ decisionRequestId: decisionId, authorId: users.memberId });
  });

  it("il cambio di stato mostra il NOME dello stato: dagli id se ci sono, se no dall'enum", async () => {
    const t = await insertTask();
    const [qa] = await testDb.db
      .insert(projectStatuses)
      .values({ projectId, name: "QA", family: "active", position: 50, legacyStatus: "in_review" })
      .returning({ id: projectStatuses.id });
    const inProgress = await statusId(projectId, "In progress");
    await testDb.db.insert(ticketEvents).values([
      {
        ticketId: t.id,
        actorId: users.memberId,
        kind: "status_changed",
        payload: { from: "in_progress", to: "in_review", fromStatusId: inProgress, toStatusId: qa!.id },
        createdAt: new Date(Date.now() - 2000),
      },
      // Uno stato che il progetto non ha più (nessun legacy `triaged`): resta l'enum.
      {
        ticketId: t.id,
        actorId: null,
        kind: "status_changed",
        payload: { from: "in_review", to: "triaged", fromStatusId: "00000000-0000-4000-8000-000000000000" },
        createdAt: new Date(Date.now() - 1000),
      },
    ]);
    const entries = taskActivityEntryViewSchema.array().parse((await get(`/api/tasks/${t.id}/activity`)).json());
    expect(entries.map((e) => [e.from, e.to])).toEqual([
      ["In progress", "QA"],
      ["In review", "triaged"],
    ]);
  });

  it("una task di un progetto non visibile → 404", async () => {
    const hidden = await insertTask({ pid: hiddenProjectId });
    expect((await get(`/api/tasks/${hidden.id}/activity`)).statusCode).toBe(404);
    expect((await get(`/api/tasks/${hidden.id}/work`)).statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:ticketId/work", () => {
  it("work: awaiting_plan_approval → awaiting_approval con webHref", async () => {
    const t = await insertTask();
    await testDb.db.insert(aiJobs).values({ ticketId: t.id, status: "awaiting_plan_approval" });
    const res = await get(`/api/tasks/${t.id}/work`);
    expect(res.statusCode).toBe(200);
    expect(taskWorkViewSchema.parse(res.json())).toEqual({
      claude: "awaiting_approval",
      pullRequests: [],
      webHref: `/tickets/${t.id}`,
    });
  });

  it("work: nessun job → none; PR del ticket con url e stato", async () => {
    const t = await insertTask();
    expect(taskWorkViewSchema.parse((await get(`/api/tasks/${t.id}/work`)).json()).claude).toBe("none");
    await testDb.db.insert(ticketRepositories).values({
      ticketId: t.id,
      repositoryId,
      branch: "stubwise/ticket-1",
      prUrl: "https://github.com/acme/shop/pull/7",
      prNumber: 7,
      prState: "merged",
    });
    await testDb.db.insert(aiJobs).values({ ticketId: t.id, status: "pr_merged" });
    const work = taskWorkViewSchema.parse((await get(`/api/tasks/${t.id}/work`)).json());
    expect(work.claude).toBe("done");
    expect(work.pullRequests).toEqual([
      { repo: "acme/shop", number: 7, url: "https://github.com/acme/shop/pull/7", state: "merged" },
    ]);
  });
});

describe("reparto di ripiego nella vista", () => {
  it("una task senza reparto mostra il ripiego", async () => {
    const t = await insertTask();
    const [general] = await testDb.db.select({ id: departments.id }).from(departments).where(eq(departments.isDefault, true));
    const items = await list("");
    expect(items.find((i) => i.id === t.id)).toMatchObject({ departmentId: general!.id });
  });
});
