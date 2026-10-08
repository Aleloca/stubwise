import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessionInputs, agentSessions, comments, users, type Db } from "@stubwise/db";
import { t as tr } from "@stubwise/i18n";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import type { DeliveryMeta } from "../agent/streaming-cli.js";
import { SessionInputRelay, resetLiveSegmentsAtStartup } from "./relay.js";
import { getContentLanguage } from "../settings.js";
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
  return (await ensureAgentSession(t.db, {
    ownerKey: owner,
    kind: "ai_job",
    title: "t",
    ticketId,
  }))!;
}
async function addInput(sessionId: string, text: string) {
  const [row] = await t.db
    .insert(agentSessionInputs)
    .values({ sessionId, text, authorUserId: userId })
    .returning();
  return row!.id;
}
const rowOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const commentsWith = async (needle: string) =>
  (await t.db.select().from(comments).where(eq(comments.ticketId, ticketId))).filter((c) =>
    c.body.includes(needle),
  );

/** LISTEN sul canale degli eventi, da chiudere a fine test. */
async function listenEvents() {
  const notified: string[] = [];
  const sub = await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => notified.push(p));
  return {
    sessionIds: () => notified.map((p) => (JSON.parse(p) as { sessionId: string }).sessionId),
    stop: () => sub.unlisten(),
  };
}

/** Un Db che passa tutto al vero, tranne ciò che `override` ridefinisce. */
function dbWith(override: Partial<Record<"execute" | "update", (...a: unknown[]) => unknown>>): Db {
  return new Proxy(t.db, {
    get(target, prop, receiver) {
      const custom = override[prop as "execute" | "update"];
      if (custom) return custom;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Db;
}

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
    await Promise.all([
      relay.deliverPending(sessionId),
      relay.deliverPending(sessionId),
      relay.deliverPending(),
    ]);
    expect(got).toEqual(["una-volta-sola"]);
    expect(await commentsWith("una-volta-sola")).toHaveLength(1);
  });

  it("nessun processo registrato → undelivered/session_not_live, niente commento, e notifica gli eventi", async () => {
    const sessionId = await newSession("ai_job:relay-2");
    const events = await listenEvents();
    try {
      const id = await addInput(sessionId, "orfano");
      await relay.deliverPending(sessionId);
      const row = await rowOf(id);
      expect(row.status).toBe("undelivered");
      expect(row.reason).toBe("session_not_live");
      expect(await commentsWith("orfano")).toHaveLength(0);
      await vi.waitFor(() => expect(events.sessionIds()).toContain(sessionId));
    } finally {
      await events.stop();
    }
  });

  it("deliver che restituisce false (stdin chiuso) → undelivered/stdin_closed, niente commento, e notifica gli eventi", async () => {
    const sessionId = await newSession("ai_job:relay-3");
    const events = await listenEvents();
    try {
      relay.register(sessionId, { deliver: () => false });
      const id = await addInput(sessionId, "tardi");
      await relay.deliverPending(sessionId);
      const row = await rowOf(id);
      expect(row.status).toBe("undelivered");
      expect(row.reason).toBe("stdin_closed");
      expect(row.deliveredAt).toBeNull();
      expect(await commentsWith("tardi")).toHaveLength(0);
      await vi.waitFor(() => expect(events.sessionIds()).toContain(sessionId));
    } finally {
      await events.stop();
    }
  });

  it("dopo la deregistrazione il processo non riceve più niente", async () => {
    const sessionId = await newSession("ai_job:relay-4");
    const got: string[] = [];
    const off = relay.register(sessionId, { deliver: (text) => (got.push(text), true) });
    off();
    const id = await addInput(sessionId, "dopo");
    await relay.deliverPending(sessionId);
    expect(got).toEqual([]);
    const row = await rowOf(id);
    expect(row.status).toBe("undelivered");
    expect(row.reason).toBe("session_not_live");
  });

  it("pg_notify che fallisce dopo una consegna riuscita: la riga resta delivered e il commento si scrive lo stesso", async () => {
    const lines: string[] = [];
    const flaky = new SessionInputRelay({
      db: dbWith({
        execute: async () => {
          throw new Error("notify giù");
        },
      }),
      pollMs: 60_000,
      log: (m) => lines.push(m),
    });
    const sessionId = await newSession("ai_job:relay-notify");
    const got: string[] = [];
    flaky.register(sessionId, { deliver: (text) => (got.push(text), true), label: "execute" });
    const id = await addInput(sessionId, "notify-rotto");
    await flaky.deliverPending(sessionId);
    expect(got).toEqual(["notify-rotto"]);
    expect((await rowOf(id)).status).toBe("delivered");
    expect(await commentsWith("notify-rotto")).toHaveLength(1);
    expect(lines.some((l) => l.includes("notify giù"))).toBe(true);
    expect(lines.some((l) => l.includes("consegna fallita"))).toBe(false);
  });

  it("il commento nomina il segmento che ha RICEVUTO l'input, non quello attivo sulla sessione", async () => {
    const sessionId = await newSession("ai_job:relay-label");
    // Nessun segmento attivo sulla sessione (activeSegmentLabel null): prima
    // il commento ricadeva su «execute».
    relay.register(sessionId, { deliver: () => true, label: "review" });
    await addInput(sessionId, "etichetta-review");
    await relay.deliverPending(sessionId);
    const lang = await getContentLanguage(t.db);
    const [c] = await commentsWith("etichetta-review");
    expect(c!.body).toBe(
      tr(lang, "comment.agentIntervention", {
        segment: tr(lang, "agentSegment.review"),
        text: "etichetta-review",
      }),
    );
  });

  it("un'etichetta senza traduzione (o assente) non mette mai una chiave i18n grezza nel commento", async () => {
    const lang = await getContentLanguage(t.db);
    for (const [owner, label] of [
      ["ai_job:relay-label-triage", "triage"],
      ["ai_job:relay-label-none", undefined],
    ] as const) {
      const sessionId = await newSession(owner);
      relay.register(sessionId, { deliver: () => true, label });
      const text = `generico-${owner}`;
      await addInput(sessionId, text);
      await relay.deliverPending(sessionId);
      const [c] = await commentsWith(text);
      expect(c!.body).not.toContain("agentSegment.");
      expect(c!.body).toBe(tr(lang, "comment.agentInterventionGeneric", { text }));
    }
  });

  it("deliver false e rollback fallito: la riga resta delivered (at-most-once) e il log nomina l'input", async () => {
    const lines: string[] = [];
    let failUpdates = false;
    const real = t.db;
    const flaky = new SessionInputRelay({
      db: dbWith({
        update: (...a: unknown[]) => {
          if (failUpdates) throw new Error("update giù");
          return (real.update as (...x: unknown[]) => unknown)(...a);
        },
      }),
      pollMs: 60_000,
      log: (m) => lines.push(m),
    });
    const sessionId = await newSession("ai_job:relay-rollback");
    flaky.register(sessionId, {
      deliver: () => {
        failUpdates = true;
        return false;
      },
    });
    const id = await addInput(sessionId, "rollback-rotto");
    await flaky.deliverPending(sessionId);
    expect((await rowOf(id)).status).toBe("delivered");
    expect(
      lines.some((l) => l.includes(`input ${id} rimasto 'delivered' senza essere scritto`)),
    ).toBe(true);
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
