import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessionInputs, agentSessions, comments, users } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import type { DeliveryMeta } from "../agent/streaming-cli.js";
import { SessionInputRelay, resetLiveSegmentsAtStartup } from "./relay.js";
import { ensureAgentSession } from "./store.js";

let t: TestDb;
let userId: string;
let ticketId: string;
beforeAll(async () => {
  t = await startTestDb();
  // `users` non ha una colonna `name`: email, hash e ruolo bastano (language ha un default).
  const [u] = await t.db
    .insert(users)
    .values({ email: "m@x.test", passwordHash: "x", role: "admin" })
    .returning();
  userId = u!.id;
  ({ ticketId } = await seedTicket(t.db));
}, 120_000);
afterAll(async () => t.stop());

async function newSession(owner: string) {
  return (await ensureAgentSession(t.db, { ownerKey: owner, kind: "ai_job", title: "t", ticketId }))!;
}
async function addInput(sessionId: string, text: string) {
  const [row] = await t.db.insert(agentSessionInputs).values({ sessionId, text, authorUserId: userId }).returning();
  return row!.id;
}
const rowOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const commentsWith = async (needle: string) =>
  (await t.db.select().from(comments).where(eq(comments.ticketId, ticketId))).filter((c) => c.body.includes(needle));

describe("SessionInputRelay", () => {
  let relay: SessionInputRelay;
  beforeEach(() => {
    relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
  });

  it("consegna un input pending con l'autore, lo marca delivered e scrive il commento sul ticket", async () => {
    const sessionId = await newSession("ai_job:relay-1");
    const got: Array<[string, boolean, DeliveryMeta]> = [];
    relay.register(sessionId, { deliver: (text, i, meta) => (got.push([text, i, meta]), true) });
    const id = await addInput(sessionId, "guarda anche X");
    await relay.deliverPending(sessionId);
    expect(got).toEqual([["guarda anche X", false, { inputId: id, authorUserId: userId }]]);
    const row = await rowOf(id);
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).not.toBeNull();
    const c = await commentsWith("guarda anche X");
    expect(c).toHaveLength(1);
    expect(c[0]!.authorId).toBe(userId);
    expect(c[0]!.authorType).toBe("user");
  });

  it("due sveglie insieme: l'agente riceve l'input UNA volta e c'è un solo commento (claim prima di deliver)", async () => {
    const sessionId = await newSession("ai_job:relay-race");
    const got: string[] = [];
    relay.register(sessionId, { deliver: (text) => (got.push(text), true) });
    await addInput(sessionId, "una-volta-sola");
    await Promise.all([relay.deliverPending(sessionId), relay.deliverPending(sessionId), relay.deliverPending()]);
    expect(got).toEqual(["una-volta-sola"]);
    expect(await commentsWith("una-volta-sola")).toHaveLength(1);
  });

  it("nessun processo registrato → undelivered/session_not_live, niente commento, e notifica gli eventi", async () => {
    const sessionId = await newSession("ai_job:relay-2");
    const notified: string[] = [];
    await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => notified.push(p));
    const id = await addInput(sessionId, "orfano");
    await relay.deliverPending(sessionId);
    const row = await rowOf(id);
    expect(row.status).toBe("undelivered");
    expect(row.reason).toBe("session_not_live");
    expect(await commentsWith("orfano")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(sessionId);
  });

  it("deliver che restituisce false (stdin chiuso) → undelivered/stdin_closed, niente commento", async () => {
    const sessionId = await newSession("ai_job:relay-3");
    relay.register(sessionId, { deliver: () => false });
    const id = await addInput(sessionId, "tardi");
    await relay.deliverPending(sessionId);
    const row = await rowOf(id);
    expect(row.status).toBe("undelivered");
    expect(row.reason).toBe("stdin_closed");
    expect(row.deliveredAt).toBeNull();
    expect(await commentsWith("tardi")).toHaveLength(0);
  });

  it("dopo la deregistrazione il processo non riceve più niente", async () => {
    const sessionId = await newSession("ai_job:relay-4");
    const got: string[] = [];
    const off = relay.register(sessionId, { deliver: (text) => (got.push(text), true) });
    off();
    await addInput(sessionId, "dopo");
    await relay.deliverPending(sessionId);
    expect(got).toEqual([]);
  });

  it("due processi registrati sulla stessa sessione: va al più recente, e dopo la sua fine al precedente", async () => {
    const sessionId = await newSession("ai_job:relay-5");
    const a: string[] = [];
    const b: string[] = [];
    relay.register(sessionId, { deliver: (text) => (a.push(text), true) });
    const offB = relay.register(sessionId, { deliver: (text) => (b.push(text), true) });
    await addInput(sessionId, "primo");
    await relay.deliverPending(sessionId);
    offB();
    await addInput(sessionId, "secondo");
    await relay.deliverPending(sessionId);
    expect(b).toEqual(["primo"]);
    expect(a).toEqual(["secondo"]);
  });
});

describe("resetLiveSegmentsAtStartup", () => {
  it("un errore del database non blocca l'avvio: si logga e dà 0", async () => {
    const lines: string[] = [];
    const n = await resetLiveSegmentsAtStartup(t.db, {
      reset: async () => {
        throw new Error('relation "agent_sessions" does not exist');
      },
      log: (m) => lines.push(m),
    });
    expect(n).toBe(0);
    expect(lines).toEqual([expect.stringContaining('relation "agent_sessions" does not exist')]);
  });

  it("azzera davvero i segmenti rimasti vivi da un riavvio", async () => {
    const sessionId = await newSession("ai_job:relay-reset");
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["seg-orfano"], activeSegmentId: "seg-orfano" })
      .where(eq(agentSessions.id, sessionId));
    const n = await resetLiveSegmentsAtStartup(t.db, { log: () => undefined });
    expect(n).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(row!.liveSegmentIds).toEqual([]);
    expect(row!.activeSegmentId).toBeNull();
  });
});
