import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  aiJobs,
  attachments,
  backlogItems,
  claudeActionGroups,
  claudeProposals,
  comments,
  issueChatToolToken,
  ticketFollowers,
  tickets,
  users,
} from "@stubwise/db";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { executeGroup } from "./execute.js";

// Le correzioni della review della fetta 3 (server e worker), un test rosso
// per ognuna: l'azione che scavalcava `convertRequest`, l'Undo che faceva
// ripartire il lavoro senza conferma, `changed_after` cieco, la classe non
// ricontrollata dal vero, `selected`, le proposte della pagina.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let other: U;
let claudeId: string;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-rv@example.com");
  other = await createUserWithSession(app, "other-rv@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, other.id, "developer");
  const [claude] = await t.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
  claudeId = claude!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: lead.headers.cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
const token = (sessionId: string) => issueChatToolToken(t.db, { sessionId, userId: lead.id, ttlMs: 60_000 });
async function task(over: Partial<typeof tickets.$inferInsert> = {}) {
  n += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie: lead.headers.cookie },
    payload: { projectId, title: `Review ${n}`, type: "bug" },
  });
  const view = res.json() as { id: string; code: string };
  if (Object.keys(over).length > 0) await t.db.update(tickets).set(over).where(eq(tickets.id, view.id));
  return view;
}
const propose = (sessionId: string, tok: string, actions: unknown[], toolUseId = `rv-${++n}`) =>
  app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sessionId}/proposals`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { toolUseId, actions },
  });
const asLead = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: lead.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const groupsOf = async (sid: string) =>
  (await asLead("GET", `/api/claude/conversations/${sid}/groups`)).json() as { id: string; undo: string }[];

describe("1. createTask non converte una richiesta", () => {
  it("una proposta createTask con requestId è rifiutata invalid, e la richiesta resta com'era", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const { itemId } = await seedBacklogItem(t.db, { projectId, title: "Da convertire", status: "new" });
    const before = (await t.db.select().from(backlogItems).where(eq(backlogItems.id, itemId)))[0]!;
    const res = await propose(sid, tok, [{ fn: "createTask", args: { projectId, title: "Dalla richiesta", type: "feature", requestId: itemId } }]);
    expect(res.json()).toMatchObject({ status: "refused" });
    expect((res.json() as { reason: string }).reason).toMatch(/invalid/i);
    const after = (await t.db.select().from(backlogItems).where(eq(backlogItems.id, itemId)))[0]!;
    expect(after.status).toBe(before.status);
    expect(await t.db.select().from(tickets).where(eq(tickets.title, "Dalla richiesta"))).toEqual([]);
  });
});

describe("2. l'Undo che farebbe ripartire il lavoro chiede conferma", () => {
  it("togliere Claude (A), poi «Annulla» che lo riassegna: needs_confirmation, nessun job", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task({ assigneeId: claudeId });
    const res = await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { assigneeId: null } } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const [group] = await groupsOf(sid);
    const undo = await asLead("POST", `/api/claude/groups/${group!.id}/undo`);
    expect(undo.json()).toMatchObject({ kind: "needs_confirmation" });
    expect((await t.db.select().from(tickets).where(eq(tickets.id, tk.id)))[0]!.assigneeId).toBeNull();
    expect(await t.db.select().from(aiJobs).where(eq(aiJobs.ticketId, tk.id))).toEqual([]);
  });
});

describe("3. changed_after vede le scritture senza storia né commenti", () => {
  it("un collega cambia la scadenza dopo Claude: l'Undo non la sovrascrive", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    expect((await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Da Claude" } } }])).json()).toMatchObject({
      status: "executed",
    });
    // La sola esecuzione di Claude non fa sembrare la task cambiata dopo.
    expect((await groupsOf(sid))[0]).toMatchObject({ undo: "available" });
    await new Promise((r) => setTimeout(r, 15));
    await t.db.update(tickets).set({ dueDate: "2026-12-01" }).where(eq(tickets.id, tk.id));
    expect((await groupsOf(sid))[0]).toMatchObject({ undo: "changed_after" });
  });

  it("un collega allega un file alla task creata da Claude: l'Undo non la elimina", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const res = await propose(sid, tok, [{ fn: "createTask", args: { projectId, title: "Creata da Claude", type: "bug" } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const [row] = await t.db.select().from(tickets).where(eq(tickets.title, "Creata da Claude"));
    await new Promise((r) => setTimeout(r, 15));
    await t.db.insert(attachments).values({
      ticketId: row!.id,
      uploaderId: other.id,
      filename: "f.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      storageKey: `rv/${row!.id}`,
    } as typeof attachments.$inferInsert);
    const [group] = await groupsOf(sid);
    expect(group).toMatchObject({ undo: "changed_after" });
    const undo = await asLead("POST", `/api/claude/groups/${group!.id}/undo`);
    expect(undo.statusCode).toBe(409);
    expect(await t.db.select().from(tickets).where(eq(tickets.id, row!.id))).toHaveLength(1);
  });

  it("un collega si mette a seguire la task dopo Claude: changed_after", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await propose(sid, tok, [{ fn: "updateTask", args: { id: tk.id, patch: { title: "Seguita dopo" } } }]);
    await new Promise((r) => setTimeout(r, 15));
    await t.db.insert(ticketFollowers).values({ ticketId: tk.id, userId: other.id } as typeof ticketFollowers.$inferInsert);
    expect((await groupsOf(sid))[0]).toMatchObject({ undo: "changed_after" });
  });
});

describe("4. la classe si ricontrolla dentro la transazione vera", () => {
  it("expectClassA: un gruppo che avviserebbe qualcuno si ferma, e niente resta scritto", async () => {
    const sid = await conversation();
    const tk = await task();
    await t.db.insert(ticketFollowers).values({ ticketId: tk.id, userId: other.id } as typeof ticketFollowers.$inferInsert);
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: lead.headers.cookie } })).json() as {
      user: { id: string; email: string; role: "admin" | "member" };
      instancePermissions: string[];
    };
    const user = { ...me.user, instancePermissions: new Set(me.instancePermissions) } as never;
    const result = await executeGroup(t.db, user, {
      sessionId: sid,
      actions: [{ fn: "addComment", args: { taskId: tk.id, body: "non doveva partire da solo" } }],
      expectClassA: true,
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "conflict", message: "reclassified" } });
    expect(await t.db.select().from(comments).where(eq(comments.ticketId, tk.id))).toEqual([]);
    expect(await t.db.select().from(claudeActionGroups).where(eq(claudeActionGroups.sessionId, sid))).toEqual([]);
  });
});

describe("5. «Conferma le selezionate»", () => {
  async function bProposal() {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await t.db.insert(ticketFollowers).values({ ticketId: tk.id, userId: other.id } as typeof ticketFollowers.$inferInsert);
    const res = await propose(sid, tok, [{ fn: "addComment", args: { taskId: tk.id, body: `Uno ${n}` } }]);
    expect(res.json()).toMatchObject({ status: "awaiting_confirmation" });
    return { tk, proposalId: (res.json() as { proposalId: string }).proposalId };
  }

  it("indici duplicati: l'azione gira una volta", async () => {
    const { tk, proposalId } = await bProposal();
    const ok = await asLead("POST", `/api/claude/proposals/${proposalId}/confirm`, { selected: [0, 0] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await t.db.select().from(comments).where(eq(comments.ticketId, tk.id))).toHaveLength(1);
  });

  it("un elenco vuoto è 400 e la proposta resta aperta", async () => {
    const { proposalId } = await bProposal();
    const res = await asLead("POST", `/api/claude/proposals/${proposalId}/confirm`, { selected: [] });
    expect(res.statusCode).toBe(400);
    const [row] = await t.db.select().from(claudeProposals).where(eq(claudeProposals.id, proposalId));
    expect(row!.status).toBe("open");
  });
});

describe("6. proposte della pagina, esiti", () => {
  it("una pageAction non resta aperta né confermabile", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const res = await propose(sid, tok, [{ fn: "pageAction", args: { kind: "theme", to: "dark" } }]);
    expect(res.json()).toMatchObject({ status: "executed" });
    const [view] = (await asLead("GET", `/api/claude/conversations/${sid}/proposals`)).json() as { status: string; canConfirm: boolean }[];
    expect(view!.status).not.toBe("open");
    expect(view!.canConfirm).toBe(false);
  });

  it("una proposta annullata, richiesta di nuovo con lo stesso toolUseId: non è «in attesa»", async () => {
    const sid = await conversation();
    const tok = await token(sid);
    const tk = await task();
    await t.db.insert(ticketFollowers).values({ ticketId: tk.id, userId: other.id } as typeof ticketFollowers.$inferInsert);
    const action = [{ fn: "addComment", args: { taskId: tk.id, body: "annullata" } }];
    const first = await propose(sid, tok, action, "rv-cancel");
    const proposalId = (first.json() as { proposalId: string }).proposalId;
    expect((await asLead("POST", `/api/claude/proposals/${proposalId}/cancel`)).statusCode).toBe(200);
    const again = await propose(sid, tok, action, "rv-cancel");
    expect(again.json()).toMatchObject({ status: "refused" });
    expect(await t.db.select().from(comments).where(and(eq(comments.ticketId, tk.id)))).toEqual([]);
  });
});
