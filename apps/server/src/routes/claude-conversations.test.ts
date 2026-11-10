import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { agentRuns, agentSessionInputs, agentSessions, claudeConversations, instanceSettings } from "@stubwise/db";
import { buildApp } from "../app.js";
import { createUserWithSession, seedUsers } from "../test/fixtures.js";

// La conversazione libera con Claude (chat, fetta 1): una sessione `free`
// PRIVATA del suo autore — nemmeno un full admin la vede —, a turni come il
// refinement; il budget del mese finito non fa partire niente.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let other: Awaited<ReturnType<typeof createUserWithSession>>;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  other = await createUserWithSession(app, "other@example.com");
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

const asMember = { cookie: () => u.memberCookie };
const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) =>
  payload === undefined
    ? app.inject({ method, url, headers: { cookie } })
    : app.inject({ method, url, headers: { cookie }, payload });

async function create(cookie: string, payload: Record<string, unknown> = { message: "Come va il progetto AUD?" }) {
  const res = await inject("POST", "/api/claude/conversations", cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; title: string; state: string };
}

describe("conversazioni libere con Claude", () => {
  it("creare: una sessione free col titolo dalla prima domanda e il primo messaggio in attesa del turno", async () => {
    const c = await create(asMember.cookie(), { message: "  Come va il progetto AUD?\nE il resto?", context: { kind: "project", id: "p1" } });
    expect(c.title).toBe("Come va il progetto AUD?");
    expect(c.state).toBe("queued");
    const [session] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, c.id));
    expect(session).toMatchObject({ kind: "free", projectId: null });
    const [conv] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, c.id));
    expect(conv).toMatchObject({ ownerId: u.memberId, contextRef: { kind: "project", id: "p1" } });
    const inputs = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, c.id));
    expect(inputs).toMatchObject([{ text: "Come va il progetto AUD?\nE il resto?", status: "pending", authorUserId: u.memberId }]);
  });

  it("privata: l'elenco ha solo le proprie; un altro, anche full admin, riceve 404 su conversazione, sessione ed eventi", async () => {
    const mine = await create(asMember.cookie(), { message: "Solo mia" });
    const list = (await inject("GET", "/api/claude/conversations?scope=mine", u.memberCookie)).json() as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toContain(mine.id);
    const adminList = (await inject("GET", "/api/claude/conversations", u.adminCookie)).json() as { items: { id: string }[] };
    expect(adminList.items.map((i) => i.id)).not.toContain(mine.id);
    for (const cookie of [u.adminCookie, other.headers.cookie]) {
      expect((await inject("GET", `/api/claude/conversations/${mine.id}`, cookie)).statusCode).toBe(404);
      expect((await inject("GET", `/api/agent-sessions/${mine.id}`, cookie)).statusCode).toBe(404);
      expect((await inject("GET", `/api/agent-sessions/${mine.id}/events`, cookie)).statusCode).toBe(404);
      expect((await inject("PATCH", `/api/claude/conversations/${mine.id}`, cookie, { title: "x" })).statusCode).toBe(404);
      expect((await inject("DELETE", `/api/claude/conversations/${mine.id}`, cookie)).statusCode).toBe(404);
      const msg = await inject("POST", `/api/agent-sessions/${mine.id}/messages`, cookie, { text: "intrusione" });
      expect(msg.statusCode).toBe(404);
    }
    // Nessun messaggio dell'intruso è nato.
    const inputs = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, mine.id));
    expect(inputs.map((i) => i.text)).toEqual(["Solo mia"]);
    // Le sessioni libere non stanno nell'elenco delle sessioni di lavoro.
    const sessions = (await inject("GET", "/api/agent-sessions", u.memberCookie)).json() as {
      live: { id: string }[];
      recent: { id: string }[];
    };
    expect([...sessions.live, ...sessions.recent].map((s) => s.id)).not.toContain(mine.id);
  });

  it("il dettaglio: la sessione con canWrite per l'autore; scrivere è un turno nuovo", async () => {
    const c = await create(asMember.cookie(), { message: "Primo" });
    const detail = (await inject("GET", `/api/claude/conversations/${c.id}`, u.memberCookie)).json() as {
      title: string;
      session: { kind: string; canWrite: boolean; canClose: boolean };
    };
    expect(detail).toMatchObject({ title: "Primo", session: { kind: "free", canWrite: true, canClose: false } });
    const msg = await inject("POST", `/api/agent-sessions/${c.id}/messages`, u.memberCookie, { text: "Secondo" });
    expect(msg.statusCode).toBe(202);
  });

  it("nata vuota: il primo messaggio le dà il titolo (template), i successivi non lo cambiano", async () => {
    const c = await create(asMember.cookie(), {});
    expect(c.title).toBe("");
    await inject("POST", `/api/agent-sessions/${c.id}/messages`, u.memberCookie, { text: "  Chi segue AUD-12?\nGrazie" });
    await inject("POST", `/api/agent-sessions/${c.id}/messages`, u.memberCookie, { text: "E AUD-13?" });
    const detail = (await inject("GET", `/api/claude/conversations/${c.id}`, u.memberCookie)).json() as { title: string };
    expect(detail.title).toBe("Chi segue AUD-12?");
    const [session] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, c.id));
    expect(session!.title).toBe("Chi segue AUD-12?");
  });

  it("rinomina, contesto, archivia (non si scrive più), elimina", async () => {
    const c = await create(asMember.cookie(), { message: "Da rinominare" });
    const patched = await inject("PATCH", `/api/claude/conversations/${c.id}`, u.memberCookie, {
      title: "Rinominata",
      context: null,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ title: "Rinominata", context: null, archived: false });
    expect(
      (await inject("PATCH", `/api/claude/conversations/${c.id}`, u.memberCookie, { archived: true })).json(),
    ).toMatchObject({ archived: true });
    const archivedList = (await inject("GET", "/api/claude/conversations?archived=true", u.memberCookie)).json() as {
      items: { id: string }[];
    };
    expect(archivedList.items.map((i) => i.id)).toContain(c.id);
    const msg = await inject("POST", `/api/agent-sessions/${c.id}/messages`, u.memberCookie, { text: "Ancora" });
    expect(msg.statusCode).toBe(409);
    expect(msg.json()).toMatchObject({ code: "conversation_archived" });
    expect((await inject("DELETE", `/api/claude/conversations/${c.id}`, u.memberCookie)).statusCode).toBe(204);
    expect(await t.db.select().from(agentSessions).where(eq(agentSessions.id, c.id))).toEqual([]);
    expect((await inject("GET", `/api/claude/conversations/${c.id}`, u.memberCookie)).statusCode).toBe(404);
  });

  it("budget del mese finito: niente conversazione nuova né messaggio (409 budget_exhausted), nessuna riga", async () => {
    const c = await create(asMember.cookie(), { message: "Prima del budget" });
    await t.db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({
      target: instanceSettings.id,
      set: { monthlyBudgetUsd: "1" },
    });
    await t.db.insert(agentRuns).values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "2" } as typeof agentRuns.$inferInsert);
    try {
      const sessionsBefore = (await t.db.select().from(agentSessions)).length;
      const res = await inject("POST", "/api/claude/conversations", u.memberCookie, { message: "Dopo" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "budget_exhausted" });
      expect((await t.db.select().from(agentSessions)).length).toBe(sessionsBefore);
      const status = await inject("GET", "/api/claude/conversations/status", u.memberCookie);
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ budgetExhausted: true });
      const msg = await inject("POST", `/api/agent-sessions/${c.id}/messages`, u.memberCookie, { text: "Dopo" });
      expect(msg.statusCode).toBe(409);
      expect(msg.json()).toMatchObject({ code: "budget_exhausted" });
      const inputs = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, c.id));
      expect(inputs.map((i) => i.text)).toEqual(["Prima del budget"]);
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null });
    }
  });

  it("l'elenco a pagine: limit e cursore, dalla più recente, senza buchi né doppioni", async () => {
    const fresh = await createUserWithSession(app, "pages@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(fresh.headers.cookie, { message: `Domanda ${i}` })).id);
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const url = `/api/claude/conversations?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const page = (await inject("GET", url, fresh.headers.cookie)).json() as {
        items: { id: string; state: string }[];
        nextCursor: string | null;
      };
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) expect(item.state).toBe("queued");
      seen.push(...page.items.map((i) => i.id));
      before = page.nextCursor;
      if (!before) break;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it("lo stato della chat: budget non finito", async () => {
    const res = await inject("GET", "/api/claude/conversations/status", u.memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ budgetExhausted: false });
  });

  it("senza sessione: 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/claude/conversations" })).statusCode).toBe(401);
  });
});
