import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { claudePageOutcomes, issueChatToolToken } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

// Lotto 7, voce 1: l'esito delle azioni del renderer salvato dal server, per
// indice (`POST /api/claude/proposals/:id/actions/:index/outcome`), con le
// mosse del prototipo per fn; `pageOutcomes` nella vista della proposta.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let projectId: string;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let lead: U;
let other: U;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  ({ projectId } = await seedRepository(t.db));
  lead = await createUserWithSession(app, "lead-po@example.com");
  other = await createUserWithSession(app, "other-po@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, other.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: U, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: u.headers.cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
async function conversation(): Promise<string> {
  return ((await as(lead, "POST", "/api/claude/conversations", {})).json() as { id: string }).id;
}
async function propose(sessionId: string, actions: unknown[]): Promise<string> {
  const tok = await issueChatToolToken(t.db, { sessionId, userId: lead.id, ttlMs: 60_000 });
  const res = await app.inject({
    method: "POST",
    url: `/api/claude/conversations/${sessionId}/proposals`,
    headers: { authorization: `Bearer ${tok}` },
    payload: { toolUseId: `po-${++n}`, actions },
  });
  return (res.json() as { proposalId: string }).proposalId;
}
async function task(): Promise<string> {
  return ((await as(lead, "POST", "/api/tasks", { projectId, title: `Esiti ${++n}`, type: "bug" })).json() as { id: string }).id;
}
const outcome = (u: U, id: string, index: number, status: string) => as(u, "POST", `/api/claude/proposals/${id}/actions/${index}/outcome`, { status });
const view = async (sid: string, id: string) =>
  ((await as(lead, "GET", `/api/claude/conversations/${sid}/proposals`)).json() as { id: string; pageOutcomes: { index: number; status: string }[] }[]).find((p) => p.id === id)!;
const theme = { fn: "pageAction", args: { kind: "theme", to: "dark" } };

describe("l'esito delle azioni della pagina (lotto 7, voce 1)", () => {
  it("pageAction: pending → done → undone, salvato e letto dalla vista; la stessa mossa ripetuta è idempotente", async () => {
    const sid = await conversation();
    const id = await propose(sid, [theme]);
    expect((await view(sid, id)).pageOutcomes).toEqual([]);
    const done = await outcome(lead, id, 0, "done");
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ index: 0, status: "done" });
    const again = await outcome(lead, id, 0, "done");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(done.json());
    expect((await outcome(lead, id, 0, "undone")).statusCode).toBe(200);
    expect((await view(sid, id)).pageOutcomes).toMatchObject([{ index: 0, status: "undone" }]);
  });

  it("una mossa fuori elenco è 409 `invalid_move` col `current`, e l'esito non cambia", async () => {
    const sid = await conversation();
    const id = await propose(sid, [theme]);
    expect((await outcome(lead, id, 0, "undone")).json()).toMatchObject({ code: "invalid_move", current: "pending" });
    // `placed` è delle bozze, non delle azioni della pagina.
    expect((await outcome(lead, id, 0, "placed")).json()).toMatchObject({ code: "invalid_move", current: "pending" });
    expect((await outcome(lead, id, 0, "failed")).statusCode).toBe(200);
    expect((await outcome(lead, id, 0, "done")).json()).toMatchObject({ code: "invalid_move", current: "failed" });
    expect(await t.db.select({ status: claudePageOutcomes.status }).from(claudePageOutcomes).where(eq(claudePageOutcomes.proposalId, id))).toEqual([{ status: "failed" }]);
  });

  it("fillField: le mosse delle bozze (pending → waiting → placed → changed_after); `done` non è loro", async () => {
    const sid = await conversation();
    const taskId = await task();
    const id = await propose(sid, [{ fn: "fillField", args: { field: "task.description", taskId, text: "La bozza" } }]);
    expect((await outcome(lead, id, 0, "done")).statusCode).toBe(409);
    for (const s of ["waiting", "placed", "changed_after"]) expect((await outcome(lead, id, 0, s)).statusCode).toBe(200);
    expect((await view(sid, id)).pageOutcomes).toMatchObject([{ index: 0, status: "changed_after" }]);
  });

  it("solo chi ha chiesto la proposta (gli altri 404, come confermare); un indice o un'azione che non è della pagina è 422", async () => {
    const sid = await conversation();
    const id = await propose(sid, [theme]);
    expect((await outcome(other, id, 0, "done")).statusCode).toBe(404);
    expect((await outcome(lead, id, 3, "done")).json()).toMatchObject({ code: "not_a_page_action" });
    const comment = await propose(sid, [{ fn: "addComment", args: { taskId: await task(), body: "no" } }]);
    expect((await outcome(lead, comment, 0, "done")).statusCode).toBe(422);
    expect(await t.db.select().from(claudePageOutcomes).where(eq(claudePageOutcomes.proposalId, id))).toEqual([]);
  });
});
