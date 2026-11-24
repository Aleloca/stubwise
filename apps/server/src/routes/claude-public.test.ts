import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  claudeConversationProjects,
  claudeConversations,
  issueChatToolToken,
  projects,
  roles,
  tickets,
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
    // Il turno è in corso (la sessione è viva: il worker la tiene col battito).
    const { agentSessions: sessionsTable } = await import("@stubwise/db");
    await t.db.update(sessionsTable).set({ liveSegmentIds: ["s1"], heartbeatAt: new Date() }).where(eq(sessionsTable.id, sid));
    // Il lettore si ferma prima del messaggio.
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

describe("«Continua» (F5.3)", () => {
  it("review della F3: la continuazione EREDITA il segno del contenuto non fidato dell'originale", async () => {
    const marked = await conversation();
    await event(marked, "input", { text: "Leggi AUD-F4" });
    await event(marked, "assistant_text", { text: "Letto." });
    await event(marked, "turn_end", {});
    await t.db.update(claudeConversations).set({ untrustedReadAt: new Date("2026-11-11T10:00:00Z") }).where(eq(claudeConversations.sessionId, marked));
    await publish(marked);
    const cont = (await as(reader, "POST", `/api/claude/conversations/${marked}/continue`, {})).json() as { id: string };
    const [row] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, cont.id));
    expect(row!.untrustedReadAt).not.toBeNull();
    // Un originale senza segno dà una continuazione senza segno.
    const clean = await conversation();
    await event(clean, "input", { text: "Ciao" });
    await event(clean, "turn_end", {});
    await publish(clean);
    const cont2 = (await as(reader, "POST", `/api/claude/conversations/${clean}/continue`, {})).json() as { id: string };
    const [row2] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, cont2.id));
    expect(row2!.untrustedReadAt).toBeNull();
  });

  it("chi legge continua in una conversazione NUOVA e sua, con la sola prosa leggibile dell'originale", async () => {
    const sid = await conversation();
    await event(sid, "input", { text: "Com'è AUD-12?" });
    await event(sid, "tool_use", { name: "mcp__stubwise_chat__read_task", input: { code: "AUD-12" } });
    await event(sid, "tool_result", { content: "JSON letto per l'autore" });
    await event(sid, "assistant_text", { text: "In revisione." });
    await event(sid, "turn_end", {});
    await publish(sid);
    // Un turno ancora privato: non entra nella trascrizione.
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "segreto in corso" });
    await event(sid, "input", { text: "segreto in corso" });

    expect((await as(author, "POST", `/api/claude/conversations/${sid}/continue`, {})).statusCode).toBe(409);
    expect((await as(outsider, "POST", `/api/claude/conversations/${sid}/continue`, {})).statusCode).toBe(404);
    const res = await as(reader, "POST", `/api/claude/conversations/${sid}/continue`, { message: "Riprendo io" });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json() as { id: string; isOwner: boolean; visibility: string; continuesFrom: unknown };
    expect(created).toMatchObject({ isOwner: true, visibility: "private", continuesFrom: { id: sid, available: true } });
    const [row] = await t.db.select().from(claudeConversations).where(eq(claudeConversations.sessionId, created.id));
    expect(row!.ownerId).toBe(reader.id);
    expect(row!.originTranscript).toEqual({
      title: expect.any(String),
      authorName: "author-pub",
      messages: [
        { role: "user", text: "Com'è AUD-12?" },
        { role: "agent", text: "In revisione." },
      ],
    });
    // Il primo messaggio è di chi continua.
    const [input] = await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, created.id));
    expect(input).toMatchObject({ authorUserId: reader.id, text: "Riprendo io" });
    // L'autore non vede la continuazione del lettore.
    expect((await as(author, "GET", `/api/claude/conversations/${created.id}`)).statusCode).toBe(404);
  });

  it("una privata non si continua; l'origine eliminata si legge «non più disponibile»", async () => {
    const sid = await conversation();
    expect((await as(reader, "POST", `/api/claude/conversations/${sid}/continue`, {})).statusCode).toBe(404);
    await publish(sid);
    const created = (await as(reader, "POST", `/api/claude/conversations/${sid}/continue`, {})).json() as { id: string };
    expect((await app.inject({ method: "DELETE", url: `/api/claude/conversations/${sid}`, headers: { cookie: author.headers.cookie } })).statusCode).toBe(204);
    const view = (await as(reader, "GET", `/api/claude/conversations/${created.id}`)).json() as { continuesFrom: unknown };
    expect(view.continuesFrom).toEqual({ id: sid, available: false });
  });
});

describe("review della fetta 5", () => {
  let hidden: { id: string; code: string };
  beforeAll(async () => {
    // Un progetto che l'autore NON vede.
    hidden = await projectOf((await seedRepository(t.db)).projectId);
  });
  const sessions = async () => (await import("@stubwise/db")).agentSessions;

  it("1/3. codici citati e contesto entrano solo se l'autore li vede: niente enumerazione, niente blocco", async () => {
    const sid = await conversation();
    await event(sid, "assistant_text", { text: `Forse ${hidden.code}-1? E ${p1.code}-2.` });
    await t.db
      .update(claudeConversations)
      .set({ contextRef: { kind: "project", id: randomUUID() } })
      .where(eq(claudeConversations.sessionId, sid));
    const first = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public" });
    const listed = (first.json() as { projects: { id: string }[] }).projects.map((p) => p.id);
    expect(listed).toEqual([p1.id]);
    const ok = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public", confirmedProjectIds: [p1.id] });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("2. pubblicare a turno in corso con un messaggio in coda: il turno aperto resta privato", async () => {
    const sid = await conversation();
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "prima" });
    await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() }).where(eq(agentSessionInputs.sessionId, sid));
    await event(sid, "input", { text: "prima" });
    await event(sid, "assistant_text", { text: "a metà" });
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "seconda, in coda" });
    await publish(sid);
    expect(await eventsOf(reader, sid)).toEqual([]);
  });

  it("4. il titolo del primo messaggio di una pubblica vuota non esce finché il turno è trattenuto", async () => {
    const sid = await conversation();
    await publish(sid);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "Titolo segreto del progetto" });
    const forReader = (await as(reader, "GET", `/api/claude/conversations/${sid}`)).json() as { title: string };
    expect(forReader.title).not.toContain("segreto");
    const list = (await as(reader, "GET", "/api/claude/conversations?scope=public")).json() as { items: { id: string; title: string }[] };
    expect(list.items.find((c) => c.id === sid)?.title ?? "").not.toContain("segreto");
    const cont = (await as(reader, "POST", `/api/claude/conversations/${sid}/continue`, {})).json() as { id: string; title: string };
    expect(cont.title).not.toContain("segreto");
    await finishTurn(sid, "Risposta.");
    expect(((await as(reader, "GET", `/api/claude/conversations/${sid}`)).json() as { title: string }).title).toContain("segreto");
  });

  it("5. «Public» si ordina per ciò che i lettori vedono, non per il seguito privato", async () => {
    const a = await conversation();
    await event(a, "assistant_text", { text: "vecchia" });
    await publish(a);
    await new Promise((r) => setTimeout(r, 20));
    const b = await conversation();
    await event(b, "assistant_text", { text: "nuova" });
    await publish(b);
    await new Promise((r) => setTimeout(r, 20));
    await as(author, "POST", `/api/agent-sessions/${a}/messages`, { text: "trattenuto" });
    const ids = ((await as(reader, "GET", "/api/claude/conversations?scope=public")).json() as { items: { id: string }[] }).items.map((c) => c.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });

  it("6. l'attività in corso del turno trattenuto non arriva ai lettori", async () => {
    const sid = await conversation();
    await publish(sid);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "lavora" });
    await event(sid, "input", { text: "lavora" });
    await event(sid, "tool_use", { name: "mcp__stubwise_chat__read_task", input: { code: "AUD-1" } });
    await t.db.update(await sessions()).set({ liveSegmentIds: ["s1"], heartbeatAt: new Date() }).where(eq((await sessions()).id, sid));
    const own = (await as(author, "GET", `/api/claude/conversations/${sid}`)).json() as { session: { lastActivity: unknown } };
    expect(own.session.lastActivity).not.toBeNull();
    const forReader = (await as(reader, "GET", `/api/claude/conversations/${sid}`)).json() as { session: { lastActivity: unknown; activeSegment: unknown } };
    expect(forReader.session.lastActivity).toBeNull();
  });

  it("7. un turno morto senza turn_end (segment_end, o sessione non più viva) si considera finito", async () => {
    const sid = await conversation();
    await publish(sid);
    await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "muore" });
    await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() }).where(eq(agentSessionInputs.sessionId, sid));
    await event(sid, "input", { text: "muore" });
    await event(sid, "assistant_text", { text: "parziale" });
    // Nessun turn_end, sessione non viva (nessun heartbeat): il turno è finito male.
    expect((await eventsOf(reader, sid)).map((e) => e.type)).toEqual(["input", "assistant_text"]);
  });
});

describe("lotto 8, voce 3: i contesti accumulati e chi li legge", () => {
  it("NEGATIVO: in una pubblica il lettore non riceve i contesti di un progetto che non vede, né nel gruppo né sotto il messaggio", async () => {
    const sid = await conversation();
    const contexts = [
      { kind: "project", id: p2.id },
      { kind: "task", id: `${p2.code}-1` },
      // Senza progetto: la posta dell'autore resta a lui solo.
      { kind: "mail", id: "casella-ada/thread-segreto" },
      { kind: "project", id: p1.id },
    ];
    const patched = await app.inject({ method: "PATCH", url: `/api/claude/conversations/${sid}`, headers: { cookie: author.headers.cookie }, payload: { contexts } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as { contexts: unknown[]; context: unknown }).contexts).toEqual(contexts);
    const sent = await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "guarda queste" });
    const { inputId } = sent.json() as { inputId: string };
    await t.db.update(agentSessionInputs).set({ status: "delivered", deliveredAt: new Date() }).where(eq(agentSessionInputs.sessionId, sid));
    await event(sid, "input", { text: "guarda queste", inputId, authorUserId: author.id });
    await event(sid, "assistant_text", { text: "Fatto." });
    await event(sid, "turn_end", {});
    await publish(sid);

    // L'autore: tutti e tre, nel gruppo e sotto il messaggio.
    const mine = (await as(author, "GET", `/api/agent-sessions/${sid}/events?limit=200`)).json() as { events: { type: string; data: { contexts?: unknown[] } }[] };
    expect(mine.events.find((e) => e.type === "input")!.data.contexts).toEqual(contexts);
    // Il lettore (vede p1, non p2): solo p1, in entrambi i posti; il resto non esce da nessuna parte.
    const view = await as(reader, "GET", `/api/claude/conversations/${sid}`);
    expect(view.statusCode, view.body).toBe(200);
    expect((view.json() as { contexts: unknown[]; context: unknown })).toMatchObject({ contexts: [{ kind: "project", id: p1.id }], context: { kind: "project", id: p1.id } });
    const events = await as(reader, "GET", `/api/agent-sessions/${sid}/events?limit=200`);
    expect((events.json() as { events: { type: string; data: { contexts?: unknown[] } }[] }).events.find((e) => e.type === "input")!.data.contexts).toEqual([{ kind: "project", id: p1.id }]);
    for (const body of [view.body, events.body]) {
      expect(body).not.toContain(p2.id);
      expect(body).not.toContain(`${p2.code}-1`);
      expect(body).not.toContain("thread-segreto");
    }
  });

  it("il gruppo: `contexts` sostituisce (senza doppioni, oltre 5 è 422), il vecchio `context` aggiunge in fondo e toglie il più vecchio", async () => {
    const sid = await conversation();
    const patch = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/claude/conversations/${sid}`, headers: { cookie: author.headers.cookie }, payload });
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "task", id: `${p1.code}-${i + 1}` }));
    const tooMany = await patch({ contexts: six });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json()).toMatchObject({ code: "too_many_contexts" });
    const deduped = await patch({ contexts: [six[0], six[1], six[0]] });
    expect((deduped.json() as { contexts: unknown[] }).contexts).toEqual([six[1], six[0]]);
    // Il client di prima: aggiunge, fino a 5, poi esce il più vecchio.
    let last: { contexts: unknown[]; context: unknown } | null = null;
    for (const c of six.slice(2)) last = (await patch({ context: c })).json() as { contexts: unknown[]; context: unknown };
    expect(last!.contexts).toEqual([six[0], six[2], six[3], six[4], six[5]]);
    expect(last!.context).toEqual(six[5]);
    // `context: null` non cambia niente.
    expect(((await patch({ context: null })).json() as { contexts: unknown[] }).contexts).toHaveLength(5);
  });
});

describe("lotto 9, voce 1: le citazioni dei messaggi di Claude", () => {
  let seq = 900;
  const task = async (projectId: string, code: string) => {
    const n = ++seq;
    const [row] = await t.db.insert(tickets).values({ projectId, number: n, title: `Citata ${n}`, type: "task", priority: "medium", source: "manual" }).returning({ id: tickets.id });
    return { id: row!.id, code: `${code}-${n}` };
  };
  const turnEnd = (events: { type: string; data: { citations?: { kind: string; id: string }[] } }[]) => events.filter((e) => e.type === "turn_end").map((e) => e.data.citations);

  it("si registra ciò che Claude ha LETTO; sul `turn_end` del turno, e chi legge una pubblica vede solo ciò che vede (NEGATIVO)", async () => {
    const sid = await conversation();
    const a = await task(p1.id, p1.code);
    const b = await task(p2.id, p2.code);
    const c = await task(p1.id, p1.code);
    const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
    await event(sid, "input", { text: "dimmi" });
    for (const code of [a.code, b.code]) {
      const read = await app.inject({ method: "GET", url: `/api/tasks/by-code/${code}`, headers: { authorization: `Bearer ${tok}` } });
      expect(read.statusCode, read.body).toBe(200);
    }
    // Un codice nella prosa (r.60): non letto, ma nominato.
    await event(sid, "assistant_text", { text: `Ho guardato, e c'è anche ${c.code}.` });
    await event(sid, "turn_end", {});
    // Un secondo turno senza letture: niente citazioni.
    await event(sid, "input", { text: "grazie" });
    await event(sid, "assistant_text", { text: "Prego." });
    await event(sid, "turn_end", {});
    await publish(sid);

    expect(turnEnd((await as(author, "GET", `/api/agent-sessions/${sid}/events?limit=200`)).json().events)).toEqual([
      [{ kind: "task", id: a.id }, { kind: "task", id: b.id }, { kind: "task", id: c.id }],
      [],
    ]);
    const forReader = await as(reader, "GET", `/api/agent-sessions/${sid}/events?limit=200`);
    expect(turnEnd(forReader.json().events)).toEqual([[{ kind: "task", id: a.id }, { kind: "task", id: c.id }], []]);
    expect(forReader.body).not.toContain(b.id);
    // La risoluzione: solo ciò che chi chiede vede.
    const resolved = await as(reader, "POST", "/api/claude/citations/resolve", { refs: [{ kind: "task", id: a.id }, { kind: "task", id: b.id }] });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((resolved.json() as { items: { id: string; label: string }[] }).items.map((i) => i.id)).toEqual([a.id]);
  });

  it("FAIL-OPEN: se la registrazione non riesce, la lettura risponde lo stesso", async () => {
    const sid = await conversation();
    const a = await task(p1.id, p1.code);
    const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
    await t.db.execute(sql`alter table claude_turn_citations rename to claude_turn_citations_off`);
    try {
      const read = await app.inject({ method: "GET", url: `/api/tasks/by-code/${a.code}`, headers: { authorization: `Bearer ${tok}` } });
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      await t.db.execute(sql`alter table claude_turn_citations_off rename to claude_turn_citations`);
    }
  });
});

describe("revisione 8–9, I-1: la pubblicazione conta TUTTI i contesti, non solo il primario", () => {
  const patch = (sid: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/claude/conversations/${sid}`, headers: { cookie: author.headers.cookie }, payload });

  it("un contesto NON primario di un altro progetto si conferma pubblicando", async () => {
    const sid = await conversation();
    expect((await patch(sid, { contexts: [{ kind: "project", id: p2.id }, { kind: "project", id: p1.id }] })).statusCode).toBe(200);
    const first = await as(author, "POST", `/api/claude/conversations/${sid}/visibility`, { visibility: "public" });
    expect(first.statusCode).toBe(409);
    expect((first.json() as { projects: { id: string }[] }).projects.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
  });

  it("dopo la pubblicazione il gruppo cambia e un progetto nuovo entra come contesto NON primario: resta fermo per l'autore", async () => {
    const sid = await conversation();
    expect((await patch(sid, { contexts: [{ kind: "project", id: p1.id }] })).statusCode).toBe(200);
    await publish(sid);
    // Il primario resta p1; p2 entra nel gruppo da non primario.
    expect((await patch(sid, { contexts: [{ kind: "project", id: p2.id }, { kind: "project", id: p1.id }] })).statusCode).toBe(200);
    // Il seguito privato comincia col messaggio dell'autore dopo la pubblicazione.
    expect((await as(author, "POST", `/api/agent-sessions/${sid}/messages`, { text: "e questo?" })).statusCode).toBeLessThan(300);
    const view = (await as(author, "GET", `/api/claude/conversations/${sid}`)).json() as { heldProjects: { id: string }[] };
    expect(view.heldProjects.map((p) => p.id)).toEqual([p2.id]);
  });
});

describe("revisione 8–9, M-5: dopo un rollback alla 0232 il `context_ref` scritto da un server di prima si accoda", () => {
  it("il gruppo [p1] e un `context_ref` diverso (p2): la vista dice [p1, p2], primario p2", async () => {
    const sid = await conversation();
    await t.db.update(claudeConversations).set({ contextRefs: [{ kind: "project", id: p1.id }], contextRef: { kind: "project", id: p2.id } }).where(eq(claudeConversations.sessionId, sid));
    const view = (await as(author, "GET", `/api/claude/conversations/${sid}`)).json() as { contexts: unknown[]; context: unknown };
    expect(view.contexts).toEqual([{ kind: "project", id: p1.id }, { kind: "project", id: p2.id }]);
    expect(view.context).toEqual({ kind: "project", id: p2.id });
  });
});
