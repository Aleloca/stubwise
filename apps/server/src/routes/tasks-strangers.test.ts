import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automationRunLog, automationRuns, automations, automationVersions, backlogItemRequesters, claudeActionGroups, claudeActions, comments, decisionRequests, projects, ticketEvents, tickets, users } from "@stubwise/db";
import { seedBacklogItem, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Registro, A11 r.1414: nelle task chi guarda non riceve l'id di chi non
 * conosce (uno sconosciuto VERO: nessun progetto in comune, presente o passato,
 * nessun canale). Qui l'assegnatario è messo a mano nel DB.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

describe("le task senza gli sconosciuti", () => {
  it("un assegnatario che chi legge non conosce: `assigneeId` è `hidden-<n>`, e il suo id non esce; il proprio id resta vero", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-ts-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-ts-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.update(tickets).set({ assigneeId: stranger!.id, createdByUserId: reader.id } as never).where(eq(tickets.id, ticketId));
    const [ticket] = await t.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId));
    const [project] = await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const res = await app.inject({ method: "GET", url: `/api/tasks/by-code/${project!.code}-${ticket!.number}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { assigneeId: string | null };
    expect(view.assigneeId).toBe("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
  });

  it("revisione del lotto 2, C1: una task ferma a mano da uno sconosciuto — GET /api/tasks risponde 200 (il serializer accetta il segnaposto) e `manualStall.byId` è `hidden-<n>`", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-ms-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-ms-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db
      .update(tickets)
      .set({ manualStallReason: "waiting_client", manualStallNote: "", manualStallSince: new Date(), manualStallByUserId: stranger!.id } as never)
      .where(eq(tickets.id, ticketId));
    const res = await app.inject({ method: "GET", url: `/api/tasks?projectId=${projectId}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(stranger!.id);
    const items = (res.json() as { items: { id: string; manualStall: { byId: string | null } | null }[] }).items;
    expect(items.find((i) => i.manualStall)?.manualStall?.byId).toBe("hidden-1");
  });

  it("revisione del lotto 2, I1: nel registro della task un cambio d'assegnatario da uno sconosciuto ha `from` = il suo segnaposto (né nome né id; null resta «senza assegnatario»), lo stesso `hidden-<n>` di chi ha cancellato un commento", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-ac-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-ac-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Zeta" }).returning({ id: users.id });
    await t.db.insert(ticketEvents).values({ ticketId, actorId: reader.id, kind: "assignee_changed", payload: { from: stranger!.id, to: reader.id } } as never);
    await t.db.insert(comments).values({ ticketId, authorType: "user", authorId: reader.id, body: "", deletedAt: new Date(), deletedByUserId: stranger!.id } as never);
    // Un commento «via Claude» chiesto dallo sconosciuto: `viaClaudeRequesterId` è il segnaposto.
    const [group] = await t.db.insert(claudeActionGroups).values({ requesterId: stranger!.id }).returning({ id: claudeActionGroups.id });
    const [action] = await t.db.insert(claudeActions).values({ groupId: group!.id, seq: 1, fn: "commentTask", args: {}, cls: "A" } as never).returning({ id: claudeActions.id });
    await t.db.insert(comments).values({ ticketId, authorType: "user", authorId: reader.id, body: "via Claude", viaClaudeActionId: action!.id } as never);
    const res = await app.inject({ method: "GET", url: `/api/tasks/${ticketId}/activity`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json() as { kind: string; from?: string | null; to?: string | null; deletedById?: string; viaClaude?: boolean; viaClaudeRequesterId?: string | null }[];
    const change = entries.find((e) => e.kind === "field_change")!;
    expect(change.from).toBe("hidden-1");
    expect(change.to).not.toBeNull();
    expect(entries.find((e) => e.kind === "comment" && e.deletedById)!.deletedById).toBe("hidden-1");
    expect(entries.find((e) => e.viaClaude)!.viaClaudeRequesterId).toBe("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
    expect(res.body).not.toContain("Zeta");
  });

  it("revisione del lotto 2, I1: una task ferma per una decisione chiesta a uno sconosciuto — `stall.reason.personId` è `hidden-<n>`", async () => {
    const { projectId, ticketId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-sd-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-sd-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.insert(decisionRequests).values({ ticketId, askedByUserId: reader.id, askedOfUserId: stranger!.id, question: "Sì?", options: [] } as never);
    const res = await app.inject({ method: "GET", url: `/api/tasks/stalled?projectId=${projectId}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(stranger!.id);
    expect(res.body).toContain('"personId":"hidden-');
  });

  it("una richiesta di uno sconosciuto: `requesterIds` porta `hidden-<n>`, il suo id non esce", async () => {
    const { projectId, itemId } = await seedBacklogItem(t.db);
    const reader = await createUserWithSession(app, `reader-rq-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "developer");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-rq-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await t.db.insert(backlogItemRequesters).values({ itemId, userId: stranger!.id } as never);
    const res = await app.inject({ method: "GET", url: `/api/requests/${itemId}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { requesterIds: string[] }).requesterIds).toContain("hidden-1");
    expect(res.body).not.toContain(stranger!.id);
  });

  it("un'automazione di uno sconosciuto: `ownerId` è `hidden-1` e la persona di un passo del flusso `hidden-2`, campo per campo; nel motivo di un'esecuzione il nome del proprietario non c'è", async () => {
    const { projectId } = await seedTicket(t.db);
    const reader = await createUserWithSession(app, `reader-au-${randomUUID().slice(0, 6)}@example.com`);
    await addMember(app, projectId, reader.id, "project_lead");
    const [stranger] = await t.db.insert(users).values({ email: `stranger-au-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Zeta" }).returning({ id: users.id });
    const [other] = await t.db.insert(users).values({ email: `other-au-${randomUUID().slice(0, 6)}@x.it`, passwordHash: "x", role: "member", displayName: "Ypsilon" }).returning({ id: users.id });
    const code = `Q${randomUUID().slice(0, 5).toUpperCase()}-A1`;
    const [a] = await t.db.insert(automations).values({ code, seq: 1, name: "Di un altro", projectId, ownerId: stranger!.id } as never).returning({ id: automations.id });
    const flow = { trigger: { kind: "manual" }, steps: [{ id: "s1", kind: "createTask", title: "x", description: "", assignee: { personId: other!.id }, dueInDays: null, project: { mode: "own" }, milestoneRef: null, approval: { mode: "ask", who: { personId: other!.id } } }], titleTemplate: "t" };
    await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow } as never);
    const [run] = await t.db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "R", origin: "manual", status: "failed" } as never).returning({ id: automationRuns.id });
    await t.db.insert(automationRunLog).values({
      runId: run!.id,
      seq: 1,
      stepId: "s1",
      path: "0",
      kind: "effect",
      outcome: "failed",
      reason: "Permesso perso: il proprietario (Zeta) non vede più il progetto del passo.",
      why: { code: "permissionLost", params: { owner: "Zeta" } },
    } as never);
    const res = await app.inject({ method: "GET", url: `/api/automations/${code}`, headers: { cookie: reader.headers.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as { automation: { ownerId: string; versions: { flow: { steps: { assignee: { personId: string } }[] } }[] }; runs: { log: { reason: string | null; why: { code: string; params?: Record<string, unknown> } | null }[] }[] };
    expect(detail.automation.ownerId).toBe("hidden-1");
    expect(detail.automation.versions[0]!.flow.steps[0]!.assignee.personId).toBe("hidden-2");
    expect((detail.automation.versions[0]!.flow.steps[0] as unknown as { approval: { who: { personId: string } } }).approval.who.personId).toBe("hidden-2");
    expect(detail.runs[0]!.log[0]!.why).toEqual({ code: "permissionLost", params: {} });
    expect(detail.runs[0]!.log[0]!.reason).toBe("Permesso perso: il proprietario non vede più il progetto del passo.");
    for (const leak of [stranger!.id, other!.id, "Zeta"]) expect(res.body).not.toContain(leak);
    const runRes = await app.inject({ method: "GET", url: `/api/automations/${code}/runs/1`, headers: { cookie: reader.headers.cookie } });
    expect(runRes.statusCode, runRes.body).toBe(200);
    for (const leak of [stranger!.id, other!.id, "Zeta"]) expect(runRes.body).not.toContain(leak);
    // Un segnaposto rimandato nel flusso è un 400 (nel salvataggio e nel controllo).
    const withAssignee = (assignee: object) => ({ ...flow, steps: [{ ...flow.steps[0], assignee, approval: { mode: "ask", who: {} } }] });
    const put = (assignee: object) =>
      app.inject({ method: "PUT", url: `/api/automations/${code}/draft`, headers: { cookie: reader.headers.cookie }, payload: { flow: withAssignee(assignee), expectedRev: 1 } });
    expect((await put({ personId: "hidden-2" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/automations/${code}/check`, headers: { cookie: reader.headers.cookie }, payload: { flow: withAssignee({ personId: "hidden-2" }) } })).statusCode).toBe(400);
    // Il posto rimandato VUOTO riprende la persona di prima (che chi salva non conosce).
    const saved = await put({});
    expect(saved.statusCode, saved.body).toBe(200);
    const versions = await t.db.select({ n: automationVersions.n, flow: automationVersions.flow }).from(automationVersions).where(eq(automationVersions.automationId, a!.id));
    const latest = versions.sort((x, y) => y.n - x.n)[0]!.flow as { steps: { assignee: unknown; approval: unknown }[] };
    expect(latest.steps[0]!.assignee).toEqual({ personId: other!.id });
    expect(latest.steps[0]!.approval).toEqual({ mode: "ask", who: { personId: other!.id } });
  });
});
