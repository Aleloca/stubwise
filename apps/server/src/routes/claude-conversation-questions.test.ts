import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentSessionEvents, agentSessionInputs, claudeConversationQuestions, claudeConversations } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 10, F2, Task 3: le domande a scelta di Claude nella conversazione
 * libera, lato server. La domanda la scrive il worker (qui la si scrive come
 * lui: riga ed evento `question`); la lettura e la risposta sono del server.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let reader: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  author = await createUserWithSession(app, "author-q@example.com");
  reader = await createUserWithSession(app, "reader-q@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversation(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: author.headers.cookie }, payload: {} });
  return (res.json() as { id: string }).id;
}
/** Come `askConversationQuestion` del worker: la riga, poi l'evento, poi il legame. */
async function ask(sessionId: string, text = "Quale reparto avviso?"): Promise<{ id: string; eventId: bigint }> {
  const [q] = await t.db
    .insert(claudeConversationQuestions)
    .values({ sessionId, inputId: randomUUID(), text, options: [{ label: "Vendite" }, { label: "Supporto", description: "Il team del supporto" }] })
    .returning();
  const [e] = await t.db.insert(agentSessionEvents).values({ sessionId, segmentId: "stubwise-claude-actions", type: "question", data: { questionId: q!.id } }).returning();
  await t.db.update(claudeConversationQuestions).set({ eventId: e!.id }).where(eq(claudeConversationQuestions.id, q!.id));
  return { id: q!.id, eventId: e!.id };
}
const list = (sessionId: string, who = author) => app.inject({ method: "GET", url: `/api/claude/conversations/${sessionId}/questions`, headers: { cookie: who.headers.cookie } });
const answer = (sessionId: string, questionId: string, body: Record<string, unknown>, who = author) =>
  app.inject({ method: "POST", url: `/api/claude/conversations/${sessionId}/questions/${questionId}/answer`, headers: { cookie: who.headers.cookie }, payload: body });
const inputsOf = (sessionId: string) => t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.sessionId, sessionId));

describe("le domande di Claude nella conversazione libera", () => {
  it("l'autore legge la domanda; risponde con un'opzione: 202, la domanda è segnata e la risposta entra come un suo messaggio", async () => {
    const sid = await conversation();
    const q = await ask(sid);
    expect((await list(sid)).json()).toEqual([
      { id: q.id, text: "Quale reparto avviso?", options: [{ label: "Vendite" }, { label: "Supporto", description: "Il team del supporto" }], answer: null },
    ]);
    const before = (await inputsOf(sid)).length;
    const res = await answer(sid, q.id, { index: 1 });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "pending" });
    const inputs = await inputsOf(sid);
    expect(inputs).toHaveLength(before + 1);
    // Review di F2 (I3): la risposta porta la domanda, «domanda» → scelta.
    expect(inputs.at(-1)).toMatchObject({ text: "«Quale reparto avviso?» → Supporto", authorUserId: author.id });
    const [shown] = (await list(sid)).json() as { answer: { index: number; text: string | null; by: { id: string } } }[];
    expect(shown!.answer).toMatchObject({ index: 1, text: null, by: { id: author.id } });
  });

  it("una risposta scritta va bene; la seconda risposta è 409 `answered`; un'opzione che non c'è 422", async () => {
    const sid = await conversation();
    const q = await ask(sid);
    expect((await answer(sid, q.id, { index: 3 })).statusCode).toBe(422);
    expect((await answer(sid, q.id, { text: "Nessuno dei due: il commerciale" })).statusCode).toBe(202);
    const again = await answer(sid, q.id, { index: 0 });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "answered" });
    expect((await inputsOf(sid)).at(-1)).toMatchObject({ text: "«Quale reparto avviso?» → Nessuno dei due: il commerciale" });
  });

  it("una conversazione archiviata: 409, e la domanda NON resta segnata (la risposta e il messaggio vanno insieme)", async () => {
    const sid = await conversation();
    const q = await ask(sid);
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, sid));
    const res = await answer(sid, q.id, { index: 0 });
    expect(res.statusCode).toBe(409);
    const [row] = await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.id, q.id));
    expect(row!.answeredAt).toBeNull();
  });

  it("in una pubblica chi legge vede le domande prima del seguito privato, non quelle dopo; e non risponde (403)", async () => {
    const sid = await conversation();
    const before = await ask(sid, "Prima");
    const publish = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/visibility`, headers: { cookie: author.headers.cookie }, payload: { visibility: "public", confirmedProjectIds: [] } });
    expect(publish.statusCode).toBe(200);
    // L'autore scrive nella pubblica: il suo turno resta privato finché non è
    // finito, e la domanda di Claude arriva DENTRO quel turno.
    const sent = await app.inject({ method: "POST", url: `/api/agent-sessions/${sid}/messages`, headers: { cookie: author.headers.cookie }, payload: { text: "E poi?", interrupt: false } });
    expect(sent.statusCode).toBe(202);
    await t.db.insert(agentSessionEvents).values({ sessionId: sid, segmentId: "s", type: "input", data: { text: "E poi?" } });
    const after = await ask(sid, "Dopo");
    const seen = (await list(sid, reader)).json() as { id: string }[];
    expect(seen.map((q) => q.id)).toEqual([before.id]);
    expect(((await list(sid)).json() as { id: string }[]).map((q) => q.id)).toEqual([before.id, after.id]);
    const res = await answer(sid, before.id, { index: 0 }, reader);
    expect(res.statusCode).toBe(403);
    const [row] = await t.db.select().from(claudeConversationQuestions).where(and(eq(claudeConversationQuestions.id, before.id)));
    expect(row!.answeredAt).toBeNull();
  });

  it("una privata di un altro: 404 sulla lettura e sulla risposta", async () => {
    const sid = await conversation();
    const q = await ask(sid);
    expect((await list(sid, reader)).statusCode).toBe(404);
    expect((await answer(sid, q.id, { index: 0 }, reader)).statusCode).toBe(404);
  });

  it("review di F2, M4: se dopo la domanda la persona ha già scritto altro, la risposta è 409 `stale` e niente si segna", async () => {
    const sid = await conversation();
    const first = await app.inject({ method: "POST", url: `/api/agent-sessions/${sid}/messages`, headers: { cookie: author.headers.cookie }, payload: { text: "Avvisa un reparto", interrupt: false } });
    const inputId = (first.json() as { inputId: string }).inputId;
    const [q] = await t.db.insert(claudeConversationQuestions).values({ sessionId: sid, inputId, text: "Quale?", options: [{ label: "A" }, { label: "B" }] }).returning();
    await app.inject({ method: "POST", url: `/api/agent-sessions/${sid}/messages`, headers: { cookie: author.headers.cookie }, payload: { text: "Lascia stare", interrupt: false } });
    const res = await answer(sid, q!.id, { index: 0 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "stale" });
    const [row] = await t.db.select().from(claudeConversationQuestions).where(eq(claudeConversationQuestions.id, q!.id));
    expect(row!.answeredAt).toBeNull();
  });

  it("review di F2, M4: la domanda del turno che è ancora l'ultimo si risponde", async () => {
    const sid = await conversation();
    const first = await app.inject({ method: "POST", url: `/api/agent-sessions/${sid}/messages`, headers: { cookie: author.headers.cookie }, payload: { text: "Avvisa un reparto", interrupt: false } });
    const inputId = (first.json() as { inputId: string }).inputId;
    const [q] = await t.db.insert(claudeConversationQuestions).values({ sessionId: sid, inputId, text: "Quale?", options: [{ label: "A" }, { label: "B" }] }).returning();
    expect((await answer(sid, q!.id, { index: 1 })).statusCode).toBe(202);
  });
});
