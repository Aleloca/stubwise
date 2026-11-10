import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  claudeConversationProjects,
  claudeConversations,
  issueChatToolToken,
  projects,
  roles,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

// Le conversazioni PUBBLICHE con Claude (chat, fetta 5). Le decide il server:
// chi la vede (autore; da pubblica chi ha `claude.public.view`), cosa
// l'autore conferma pubblicando (i progetti letti o toccati), e il seguito
// privato (un turno che non è finito, o che ha toccato un progetto nuovo, non
// arriva ai lettori finché l'autore non lo riconferma).

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let seeded: SeededUsers;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let reader: U;
let outsider: U;
let p1: { id: string; code: string };
let p2: { id: string; code: string };

async function projectOf(id: string) {
  const [row] = await t.db.select({ id: projects.id, code: projects.code }).from(projects).where(eq(projects.id, id));
  return { id: row!.id, code: row!.code ?? "" };
}

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  seeded = await seedUsers(app);
  p1 = await projectOf((await seedRepository(t.db)).projectId);
  p2 = await projectOf((await seedRepository(t.db)).projectId);
  author = await createUserWithSession(app, "author-pub@example.com");
  reader = await createUserWithSession(app, "reader-pub@example.com");
  outsider = await createUserWithSession(app, "outsider-pub@example.com");
  for (const u of [author, reader]) await addMember(app, p1.id, u.id, "developer");
  await addMember(app, p2.id, author.id, "developer");
  // Chi non ha `claude.public.view`: un ruolo d'istanza senza permessi.
  const [none] = await t.db
    .insert(roles)
    .values({ name: `Nessuno ${randomUUID()}`, scope: "instance", permissions: [] } as typeof roles.$inferInsert)
    .returning({ id: roles.id });
  await t.db.update(users).set({ instanceRoleId: none!.id }).where(eq(users.id, outsider.id));
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const as = (u: { headers: { cookie: string } } | SeededUsers, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie: "adminCookie" in u ? u.adminCookie : u.headers.cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function conversation(): Promise<string> {
  const res = await as(author, "POST", "/api/claude/conversations", {});
  return (res.json() as { id: string }).id;
}
async function event(sessionId: string, type: string, data: Record<string, unknown>) {
  await t.db.insert(agentSessionEvents).values({ sessionId, segmentId: "s1", type, data } as typeof agentSessionEvents.$inferInsert);
}
/** Un turno di Claude finito: il messaggio consegnato, l'evento `input`, la risposta, `turn_end`. */
async function finishTurn(sessionId: string, answer: string) {
  await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() }).where(eq(agentSessionInputs.sessionId, sessionId));
  await event(sessionId, "input", { text: "domanda" });
  await event(sessionId, "assistant_text", { text: answer });
  await event(sessionId, "turn_end", {});
}
const eventsOf = async (u: U, sessionId: string) =>
  ((await as(u, "GET", `/api/agent-sessions/${sessionId}/events?limit=200`)).json() as { events: { type: string; data: { text?: string } }[] }).events;
async function publish(sessionId: string) {
  const first = await as(author, "POST", `/api/claude/conversations/${sessionId}/visibility`, { visibility: "public" });
  expect(first.statusCode, first.body).toBe(409);
  const projectsToConfirm = (first.json() as { projects: { id: string }[] }).projects.map((p) => p.id);
  const ok = await as(author, "POST", `/api/claude/conversations/${sessionId}/visibility`, {
    visibility: "public",
    confirmedProjectIds: projectsToConfirm,
  });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok.json() as { visibility: string };
}

describe("chi vede una conversazione", () => {
  it("una privata è dell'autore: un altro, anche un full admin, riceve 404", async () => {
    const sid = await conversation();
    expect((await as(reader, "GET", `/api/claude/conversations/${sid}`)).statusCode).toBe(404);
    expect((await as(seeded, "GET", `/api/claude/conversations/${sid}`)).statusCode).toBe(404);
    expect((await as(reader, "GET", `/api/agent-sessions/${sid}/events`)).statusCode).toBe(404);
  });

  it("una pubblica la legge chi ha claude.public.view, non chi non ce l'ha; nessuno ci scrive", async () => {
    const sid = await conversation();
    await event(sid, "assistant_text", { text: `Ciao, ${p1.code}-1 è aperta.` });
    await publish(sid);
    const view = (await as(reader, "GET", `/api/claude/conversations/${sid}`)).json() as Record<string, unknown>;
    expect(view).toMatchObject({ visibility: "public", isOwner: false, canContinue: true, canPublish: false });
    expect(view["author"]).toMatchObject({ id: author.id });
    expect((await as(outsider, "GET", `/api/claude/conversations/${sid}`)).statusCode).toBe(404);
    const list = (await as(reader, "GET", "/api/claude/conversations?scope=public")).json() as { items: { id: string }[] };
    expect(list.items.map((c) => c.id)).toContain(sid);
    expect(((await as(outsider, "GET", "/api/claude/conversations?scope=public")).json() as { items: unknown[] }).items).toEqual([]);
    // Le proprie pubbliche stanno in «Mine», non in «Public».
    const mine = (await as(author, "GET", "/api/claude/conversations?scope=public")).json() as { items: { id: string }[] };
    expect(mine.items.map((c) => c.id)).not.toContain(sid);
    const write = await as(reader, "POST", `/api/agent-sessions/${sid}/messages`, { text: "scrivo anch'io" });
    expect([403, 404]).toContain(write.statusCode);
  });
});

describe("pubblicare chiede di confermare i progetti letti o toccati", () => {
  it("l'elenco viene dalle letture del token, dai codici citati e dice delle letture dei tool (D1)", async () => {
    const sid = await conversation();
    const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
    // Una lettura per id del token del turno: il progetto si registra.
    const read = await app.inject({ method: "GET", url: `/api/projects/${p2.id}/decisions`, headers: { authorization: `Bearer ${tok}` } });
    expect(read.statusCode, read.body).toBe(200);
    const recorded = await t.db.select().from(claudeConversationProjects).where(eq(claudeConversationProjects.sessionId, sid));
    expect(recorded.map((r) => r.projectId)).toEqual([p2.id]);
    await event(sid, "tool_use", { name: "mcp__stubwise_chat__read_project_overview", input: { projectId: p2.id } });
    await event(sid, "assistant_text", { text: `Vedi ${p1.code}-4.` });
    const first = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public" });
    expect(first.statusCode).toBe(409);
    const body = first.json() as { code: string; projects: { id: string; code: string }[]; includesToolReads: boolean; reconfirm: boolean };
    expect(body).toMatchObject({ code: "needs_confirmation", includesToolReads: true, reconfirm: false });
    expect(body.projects.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    // Un elenco diverso da quello di adesso non pubblica.
    const partial = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public", confirmedProjectIds: [p1.id] });
    expect(partial.statusCode).toBe(409);
    expect((await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, sid)))[0]!.visibility).toBe("private");
    expect(await publish(sid)).toMatchObject({ visibility: "public" });
  });

  it("solo l'autore; «Make private» la chiude e fa ripartire la finestra della potatura", async () => {
    const sid = await conversation();
    await publish(sid);
    expect((await as(reader, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "private" })).statusCode).toBe(404);
    const priv = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "private" });
    expect(priv.json()).toMatchObject({ visibility: "private", publishedAt: null });
    const [row] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, sid));
    expect(row!.visibilityChangedAt).not.toBeNull();
    expect((await as(reader, "GET", `/api/claude/conversations/${sid}`)).statusCode).toBe(404);
  });
});

describe("il seguito privato", () => {
  it("un turno in corso non arriva ai lettori; finito e pulito, sì — eventi dei tool compresi (D1)", async () => {
    const sid = await conversation();
    await event(sid, "assistant_text", { text: "Prima della pubblicazione." });
    await publish(sid);
    const send = await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "Com'è AUD?" });
    expect(send.statusCode, send.body).toBeLessThan(300);
    await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() }).where(eq(agentSessionInputs.sessionId, sid));
    await event(sid, "input", { text: "Com'è AUD?" });
    await event(sid, "tool_use", { name: "mcp__stubwise_chat__list_projects", input: {} });
    await event(sid, "tool_result", { content: "dati letti per l'autore" });
    // Il turno è in corso: il lettore si ferma prima del messaggio.
    const during = await eventsOf(reader, sid);
    expect(during.map((e) => e.type)).toEqual(["assistant_text"]);
    expect((await as(reader, "GET", `/api/claude/conversations/${sid}`)).json()).toMatchObject({ privateTail: true });
    await event(sid, "assistant_text", { text: "Tutto bene." });
    await event(sid, "turn_end", {});
    const after = await eventsOf(reader, sid);
    expect(after.map((e) => e.type)).toEqual(["assistant_text", "input", "tool_use", "tool_result", "assistant_text", "turn_end"]);
    expect((await as(reader, "GET", `/api/claude/conversations/${sid}`)).json()).toMatchObject({ privateTail: false });
  });

  it("un turno che tocca un progetto nuovo resta privato finché l'autore non lo riconferma", async () => {
    const sid = await conversation();
    await event(sid, "assistant_text", { text: `Su ${p1.code}-1.` });
    await publish(sid);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "E l'altro progetto?" });
    await finishTurn(sid, `${p2.code}-7 è in ritardo.`);
    expect((await eventsOf(reader, sid)).map((e) => e.data.text ?? e.type)).toEqual([`Su ${p1.code}-1.`]);
    const own = (await as(author, "GET", `/api/claude/conversations/${sid}`)).json() as { heldProjects: { id: string }[] };
    expect(own.heldProjects.map((p) => p.id)).toEqual([p2.id]);
    const ask = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public" });
    expect(ask.json()).toMatchObject({ code: "needs_confirmation", reconfirm: true });
    expect((ask.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([p2.id]);
    const ok = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public", confirmedProjectIds: [p2.id] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await eventsOf(reader, sid)).map((e) => e.type)).toEqual(["assistant_text", "input", "assistant_text", "turn_end"]);
  });

  it("il lettore non vede gli interventi dell'autore (in coda o no)", async () => {
    const sid = await conversation();
    await publish(sid);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "messaggio in coda" });
    const detail = (await as(reader, "GET", `/api/claude/conversations/${sid}`)).json() as { session: { inputs: unknown[] } };
    expect(detail.session.inputs).toEqual([]);
    const own = (await as(author, "GET", `/api/claude/conversations/${sid}`)).json() as { session: { inputs: unknown[] } };
    expect(own.session.inputs.length).toBe(1);
    expect(
      await t.db.select().from(agentSessionInputs).where(and(eq(agentSessionInputs.sessionId, sid), eq(agentSessionInputs.status, "pending"))),
    ).toHaveLength(1);
  });
});

describe("proposte e gruppi per chi legge", () => {
  it("il lettore le vede (sola lettura), tranne quelle del seguito privato", async () => {
    const sid = await conversation();
    await publish(sid);
    const { claudeProposals } = await import("@stubwise/db");
    const { nextEventId } = await import("../services/claude-public.js");
    const proposal = async (eventId: bigint) => {
      const [row] = await t.db
        .insert(claudeProposals)
        .values({
          sessionId: sid,
          requesterId: author.id,
          toolUseId: `tu-${randomUUID()}`,
          actions: [{ fn: "updateTask", args: { id: randomUUID(), patch: { title: "x" } } }],
          declaredCls: "B",
          status: "open",
          eventId,
        } as typeof claudeProposals.$inferInsert)
        .returning({ id: claudeProposals.id });
      return row!.id;
    };
    await event(sid, "proposal", {});
    const released = await proposal((await nextEventId(t.db)) - 1n);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "ancora" });
    await event(sid, "proposal", {});
    const held = await proposal((await nextEventId(t.db)) - 1n);
    const forReader = (await as(reader, "GET", `/api/claude/conversations/${sid}/proposals`)).json() as { id: string; canConfirm: boolean }[];
    expect(forReader.map((p) => p.id)).toEqual([released]);
    expect(forReader[0]!.canConfirm).toBe(false);
    const forAuthor = (await as(author, "GET", `/api/claude/conversations/${sid}/proposals`)).json() as { id: string }[];
    expect(forAuthor.map((p) => p.id).sort()).toEqual([released, held].sort());
  });
});
