import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  agentSessionEvents,
  aiJobs,
  backlogItems,
  backlogJobs,
  claudeActionGroups,
  comments,
  milestones,
  taskFilters,
  claudeProposals,
  deletedTickets,
  instanceSettings,
  issueChatToolToken,
  notifications,
  projectMembers,
  ticketEvents,
  tickets,
  users,
} from "@stubwise/db";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { SERVER_CATALOG } from "./catalog.js";

// Le azioni di Claude (chat, fetta 3): Claude PROPONE (la sola rotta di
// scrittura del token del turno), il SERVER esegue con i servizi delle rotte,
// i permessi della persona ricontrollati e il segno «via Claude». Una A parte
// subito con «Annulla»; una B aspetta la conferma dell'autore.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let other: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  author = await createUserWithSession(app, "author-ca@example.com");
  other = await createUserWithSession(app, "other-ca@example.com");
  await addMember(app, projectId, author.id, "legacy_member");
  await addMember(app, projectId, other.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(cookie = author.headers.cookie): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
async function token(sessionId: string, userId = author.id) {
  return issueChatToolToken(t.db, { sessionId, userId, ttlMs: 60_000 });
}
async function task(over: Partial<typeof tickets.$inferInsert> = {}) {
  n += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie: author.headers.cookie },
    payload: { projectId, title: `Task ${n}`, type: "bug" },
  });
  const view = res.json() as { id: string; code: string };
  if (Object.keys(over).length > 0) await t.db.update(tickets).set(over).where(eq(tickets.id, view.id));
  return view;
}
const propose = (sessionId: string, tok: string, actions: unknown[], toolUseId = `tu-${++n}`) =>
  app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sessionId}/proposals`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { toolUseId, actions },
  });
const asAuthor = (method: "GET" | "POST", url: string, payload?: unknown) =>
  payload === undefined
    ? app.inject({ method, url, headers: { cookie: author.headers.cookie } })
    : app.inject({ method, url, headers: { cookie: author.headers.cookie }, payload: payload as Record<string, unknown> });

describe("una A parte subito, come la persona, col segno «via Claude»", () => {
  it("updateTask del titolo: eseguita, registro con l'autore come attore e il segno, evento nella conversazione", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Titolo da Claude" } } }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "executed", codes: [tk.code] });
    const [row] = await t.db.select().from(tickets).where(eq(tickets.id, tk.id));
    expect(row!.title).toBe("Titolo da Claude");
    const events = await t.db.select().from(ticketEvents).where(and(eq(ticketEvents.ticketId, tk.id), eq(ticketEvents.kind, "title_changed")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: author.id });
    expect(events[0]!.viaClaudeActionId).not.toBeNull();
    const conv = await t.db.select().from(agentSessionEvents).where(eq(agentSessionEvents.sessionId, sid));
    expect(conv.map((e) => e.type)).toContain("actions_executed");
  });

  it("idempotente per toolUseId: una seconda chiamata uguale non esegue di nuovo", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const action = [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Una volta" } } }];
    await propose(sid, tok, action, "stesso");
    const again = await propose(sid, tok, action, "stesso");
    expect(again.json()).toMatchObject({ status: "executed" });
    expect(await t.db.select().from(claudeActionGroups).where(eq(claudeActionGroups.sessionId, sid))).toHaveLength(1);
  });
});

describe("una B aspetta la conferma dell'autore", () => {
  it("assegnare a un altro avvisa qualcuno: la classe sale a B coi motivi; niente cambia fino alla conferma", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.assigneeId).toBeNull();
    // La prova a secco non lascia notifiche.
    expect(await t.db.select().from(notifications).where(eq(notifications.userId, other.id))).toHaveLength(0);
    const [view] = (await asAuthor("GET", `/api/claude/conversations/${sid}/proposals`)).json() as {
      id: string;
      cls: string;
      reasons: { kind: string; personIds?: string[] }[];
      canConfirm: boolean;
    }[];
    expect(view).toMatchObject({ cls: "B", canConfirm: true, reasons: [{ kind: "notifies", personIds: [other.id] }] });

    // Il token del turno non conferma; un altro non la vede.
    const byToken = await app.inject({ method: "POST", url: `/api/claude/proposals/${view!.id}/confirm`, headers: { authorization: `Bearer ${tok}` }, payload: {} });
    expect(byToken.statusCode).toBe(403);
    const byOther = await app.inject({ method: "POST", url: `/api/claude/proposals/${view!.id}/confirm`, headers: { cookie: other.headers.cookie }, payload: {} });
    expect(byOther.statusCode).toBe(404);

    const ok = await asAuthor("POST", `/api/claude/proposals/${view!.id}/confirm`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "confirmed" });
    expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.assigneeId).toBe(other.id);
    const cards = await t.db.select().from(notifications).where(eq(notifications.userId, other.id));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.viaClaudeActionId !== null)).toBe(true);
    // Una seconda conferma: già decisa.
    expect((await asAuthor("POST", `/api/claude/proposals/${view!.id}/confirm`, {})).statusCode).toBe(409);
  });

  it("permessi ricontrollati alla conferma: perso il ruolo nel progetto, rifiutata e nulla scritto", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } }]);
    const [p] = await t.db.select().from(claudeProposals).where(eq(claudeProposals.sessionId, sid));
    await t.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, author.id)));
    try {
      const res = await asAuthor("POST", `/api/claude/proposals/${p!.id}/confirm`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "refused", proposal: { status: "failed", failure: { code: "not_found" } } });
      expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.assigneeId).toBeNull();
    } finally {
      await addMember(app, projectId, author.id, "legacy_member");
    }
  });

  it("il permesso della ROTTA vale anche per Claude: un Viewer che vede la task non la modifica (forbidden, tickets.edit)", async () => {
    const viewer = await createUserWithSession(app, `viewer-ca-${++n}@example.com`);
    await addMember(app, projectId, viewer.id, "viewer");
    const sid = await conversation(viewer.headers.cookie);
    const tok = await token(sid, viewer.id);
    const tk = await task();
    const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Dal viewer" } } }]);
    expect(res.json()).toMatchObject({ status: "refused" });
    expect(res.json().reason).toContain("tickets.edit");
    expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.title).not.toBe("Dal viewer");
  });

  it("scade dopo 20 messaggi o 24 ore: la conferma risponde 409 expired", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } }]);
    const [p] = await t.db.select().from(claudeProposals).where(eq(claudeProposals.sessionId, sid));
    await t.db.insert(agentSessionEvents).values(
      Array.from({ length: 20 }, (_, i) => ({ sessionId: sid, segmentId: "s", type: "input" as const, data: { text: `m${i}` } })),
    );
    const views = (await asAuthor("GET", `/api/claude/conversations/${sid}/proposals`)).json() as { status: string; canConfirm: boolean }[];
    expect(views[0]).toMatchObject({ status: "expired", canConfirm: false });
    expect((await asAuthor("POST", `/api/claude/proposals/${p!.id}/confirm`, {})).json()).toMatchObject({ code: "expired" });

    const sid2 = await conversation();
    const tok2 = await token(sid2);
    await propose(sid2, tok2, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: other.id } } }]);
    await t.db
      .update(claudeProposals)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(claudeProposals.sessionId, sid2));
    const [old] = (await asAuthor("GET", `/api/claude/conversations/${sid2}/proposals`)).json() as { status: string }[];
    expect(old!.status).toBe("expired");
  });
});

describe("«Annulla»", () => {
  it("createTask (A) si annulla con l'eliminazione, una volta sola; la lapide porta il segno", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const res = await propose(sid, tok, [{ fn: "createTask", args: { projectId, title: "Creata da Claude", type: "bug" } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const [group] = (await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as { id: string; undo: string; actions: { codes: string[] }[] }[];
    expect(group).toMatchObject({ undo: "available" });
    const code = group!.actions[0]!.codes[0]!;
    const undo = await asAuthor("POST", `/api/claude/groups/${group!.id}/undo`);
    expect(undo.json()).toEqual({ kind: "undone" });
    const number = Number(code.split("-").at(-1));
    const [stone] = await t.db.select().from(deletedTickets).where(and(eq(deletedTickets.projectId, projectId), eq(deletedTickets.number, number)));
    expect(stone).toBeDefined();
    expect(stone!.viaClaudeActionId).not.toBeNull();
    expect((await asAuthor("POST", `/api/claude/groups/${group!.id}/undo`)).statusCode).toBe(409);
  });

  it("changed_after: un altro ha scritto dopo sulla stessa task, «Annulla» non parte", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Da Claude" } } }]);
    await new Promise((r) => setTimeout(r, 20));
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${tk.id}`,
      headers: { cookie: other.headers.cookie },
      payload: { title: "Dopo, da un altro" },
    });
    expect(patched.statusCode).toBe(200);
    const [group] = (await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as { id: string; undo: string; changedBy: string | null }[];
    expect(group).toMatchObject({ undo: "changed_after", changedBy: other.id });
    expect((await asAuthor("POST", `/api/claude/groups/${group!.id}/undo`)).json()).toMatchObject({ code: "changed_after" });
    expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.title).toBe("Dopo, da un altro");
  });
});

describe("ciò che non si può", () => {
  it("una persona non crea proposte (403); il token di un'altra conversazione: 404", async () => {
    const sid = await conversation();
    const other = await conversation();
    const tok = await token(other);
    const tk = await task();
    const byCookie = await asAuthor("POST", `/api/claude/conversations/${sid}/proposals`, {
      toolUseId: "x",
      actions: [{ fn: "updateTask", args: { id: tk.id, patch: { title: "no" } } }],
    });
    expect(byCookie.statusCode).toBe(403);
    expect((await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "no" } } }])).statusCode).toBe(404);
  });

  it("deleteTask (solo inverso) e una fn fuori elenco: rifiutate, niente eseguito", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const res = await propose(sid, tok, [{ fn: "deleteTask", args: { id: tk.id } }]);
    expect(res.json()).toMatchObject({ status: "refused" });
    expect(await t.db.select().from(tickets).where(eq(tickets.id, tk.id))).toHaveLength(1);
    expect((await propose(sid, tok, [{ fn: "approvePlan", args: {} }])).statusCode).toBe(400);
  });

  it("budget del mese finito: rifiutata, anche una A", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    await t.db.insert(agentRuns).values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "5" } as typeof agentRuns.$inferInsert);
    try {
      const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "no" } } }]);
      expect(res.json()).toMatchObject({ status: "refused" });
      expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.title).not.toBe("no");
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
    }
  });
});

/** Una B proposta e confermata dall'autore; ritorna il gruppo eseguito. */
async function proposeAndConfirm(sid: string, tok: string, actions: unknown[]) {
  const res = await propose(sid, tok, actions);
  expect(res.json(), JSON.stringify(res.json())).toMatchObject({ status: "awaiting_confirmation" });
  const proposalId = (res.json() as { proposalId: string }).proposalId;
  const ok = await asAuthor("POST", `/api/claude/proposals/${proposalId}/confirm`, {});
  expect(ok.statusCode, ok.body).toBe(200);
  return (ok.json() as { groupId: string }).groupId;
}
const undo = (groupId: string) => asAuthor("POST", `/api/claude/groups/${groupId}/undo`);

describe("le altre voci del catalogo", () => {
  it("addComment (B): il commento è dell'autore col segno; «Annulla» lo elimina", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const groupId = await proposeAndConfirm(sid, tok, [{ fn: "addComment", args: { taskId: tk.id, body: "Scritto da Claude" } }]);
    const [c] = await t.db.select().from(comments).where(and(eq(comments.ticketId, tk.id), eq(comments.body, "Scritto da Claude")));
    expect(c).toMatchObject({ authorId: author.id, authorType: "user" });
    expect(c!.viaClaudeActionId).not.toBeNull();
    expect((await undo(groupId)).json()).toEqual({ kind: "undone" });
    const [gone] = await t.db.select().from(comments).where(eq(comments.id, c!.id));
    expect(gone!.deletedAt).not.toBeNull();
  });

  it("assegnare Claude con updateTask: il lavoro parte come nelle rotte, quindi chiede SEMPRE conferma (starts_work) e non si annulla", async () => {
    const [claude] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect(claude).toBeDefined();
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: claude!.id } } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    // Nessun job durante la prova a secco.
    expect(await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, tk.id))).toEqual([]);
    const [view] = (await asAuthor("GET", `/api/claude/conversations/${sid}/proposals`)).json() as {
      id: string;
      cls: string;
      reasons: { kind: string }[];
    }[];
    expect(view!.cls).toBe("B");
    expect(view!.reasons.map((r) => r.kind)).toContain("starts_work");
    expect((await asAuthor("POST", `/api/claude/proposals/${view!.id}/confirm`, {})).statusCode).toBe(200);
    const [job] = await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, tk.id));
    expect(job).toBeDefined();
    expect(job!.planApprovalRequired).toBe(true);
    const [group] = (await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as { undo: string }[];
    expect(group!.undo).toBe("not_undoable");
  });

  it("deleteComment di un commento altrui senza tickets.moderate: rifiutata alla nascita", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    const [c] = await t.db
      .insert(comments)
      .values({ ticketId: tk.id, authorType: "user", authorId: other.id, body: "di un altro" } as typeof comments.$inferInsert)
      .returning();
    const res = await propose(sid, tok, [{ fn: "deleteComment", args: { id: c!.id, taskId: tk.id } }]);
    expect(res.json()).toMatchObject({ status: "refused" });
    expect((await t.db.select().from(comments).where(eq(comments.id, c!.id)))[0]!.body).toBe("di un altro");
  });

  it("archiveRequest (B): archiviata; «Annulla» la riapre; se qualcuno la cambia dopo, changed_after", async () => {
    const { itemId } = await seedBacklogItem(t.db, { projectId, status: "new" });
    const sid = await conversation();
    const tok = await token(sid);
    const groupId = await proposeAndConfirm(sid, tok, [{ fn: "archiveRequest", args: { id: itemId } }]);
    expect((await t.db.select().from(backlogItems).where(eq(backlogItems.id, itemId)))[0]!.status).toBe("archived");
    expect((await undo(groupId)).json()).toEqual({ kind: "undone" });
    expect((await t.db.select().from(backlogItems).where(eq(backlogItems.id, itemId)))[0]!.status).toBe("new");

    const again = await proposeAndConfirm(sid, tok, [{ fn: "archiveRequest", args: { id: itemId } }]);
    await new Promise((r) => setTimeout(r, 20));
    await t.db.update(backlogItems).set({ title: "Cambiata da un altro" }).where(eq(backlogItems.id, itemId));
    expect((await undo(again)).json()).toMatchObject({ code: "changed_after" });
  });

  it("startRun (B) da chi non ha plans.approve: il job passa dal gate del piano, mai approvato", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await proposeAndConfirm(sid, tok, [{ fn: "startRun", args: { taskId: tk.id } }]);
    const [job] = await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, tk.id));
    expect(job).toBeDefined();
    expect(job!.planApprovalRequired).toBe(true);
    expect(["queued", "awaiting_plan_approval"]).toContain(job!.status);
  });

  it("createMilestone (B) e il suo «Annulla»; createRequest (B) passa dall'intake e non si annulla", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    // Un Legacy Member ha tickets.edit: crea il traguardo.
    const name = `Traguardo ${++n}`;
    const groupId = await proposeAndConfirm(sid, tok, [{ fn: "createMilestone", args: { projectId, name, dueDate: null } }]);
    const [m] = await t.db.select().from(milestones).where(and(eq(milestones.projectId, projectId), eq(milestones.name, name)));
    expect(m).toBeDefined();
    expect((await undo(groupId)).json()).toEqual({ kind: "undone" });
    expect(await t.db.select().from(milestones).where(eq(milestones.id, m!.id))).toEqual([]);

    const requestGroup = await proposeAndConfirm(sid, tok, [{ fn: "createRequest", args: { projectId, title: "Export PDF", description: "Serve il PDF" } }]);
    expect((await t.db.select().from(backlogJobs)).length).toBeGreaterThan(0);
    const [view] = ((await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as { id: string; undo: string }[]).filter(
      (g) => g.id === requestGroup,
    );
    expect(view).toMatchObject({ undo: "not_undoable" });
  });

  it("saveFilter (A): sempre PERSONALE anche se chiesto pubblico; «Annulla» lo elimina", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const res = await propose(sid, tok, [
      { fn: "saveFilter", args: { name: "Le mie urgenti", visibility: "public", criteria: {}, view: "list", groupBy: "none" } },
    ]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const [f] = await t.db.select().from(taskFilters).where(and(eq(taskFilters.ownerId, author.id), eq(taskFilters.name, "Le mie urgenti")));
    expect(f).toMatchObject({ visibility: "private" });
    const [group] = (await asAuthor("GET", `/api/claude/conversations/${sid}/groups`)).json() as { id: string }[];
    expect((await undo(group!.id)).json()).toEqual({ kind: "undone" });
    expect(await t.db.select().from(taskFilters).where(eq(taskFilters.id, f!.id))).toEqual([]);
  });
});

describe("il catalogo del server (registro)", () => {
  it("ogni voce ha lo STESSO accesso della sua rotta (tipo, permesso, guardia della risorsa)", async () => {
    const routes = new Map<string, RouteOptions>();
    const probe = buildApp({
      onRoute: (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const m of methods) routes.set(`${m} ${route.url}`, route);
      },
    });
    await probe.ready();
    await probe.close();
    for (const entry of SERVER_CATALOG.values()) {
      const route = routes.get(entry.route);
      expect(route, entry.route).toBeDefined();
      const access = route!.config?.access as { kind: string; permission?: string; resource?: unknown } | undefined;
      expect(access?.kind, entry.fn).toBe(entry.access.kind);
      const mine = entry.access as { permission?: string; resource?: unknown };
      expect(access?.permission, entry.fn).toBe(mine.permission);
      expect(access?.resource !== undefined, entry.fn).toBe(mine.resource !== undefined);
    }
  });
});
