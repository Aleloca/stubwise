// apps/worker/src/sessions/store.test.ts
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { agentSessionEvents, agentSessionInputs, agentSessions, createDb } from "@stubwise/db";
import { AGENT_SESSION_EVENTS_CHANNEL, AGENT_SESSION_PARTIAL_CHANNEL } from "@stubwise/shared";
import { StreamingClaudeRunner, type SessionHooks } from "../agent/streaming-cli.js";
import {
  createSegmentSink,
  ensureAgentSession,
  MAX_PENDING_EVENTS,
  pruneAgentSessions,
  resetLiveSegments,
} from "./store.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

/** Attende che `read()` restituisca un valore vero, o fallisce con un messaggio chiaro. */
async function waitUntil<T>(
  read: () => Promise<T | false | undefined> | T | false | undefined,
  what: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout in attesa di: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Attende (polling sul DB) che la condizione sulla riga sia vera, o fallisce. */
async function waitForRow(
  id: string,
  cond: (row: Awaited<ReturnType<typeof rowOf>>) => boolean,
  what: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await rowOf(id);
    if (cond(row)) return row;
    if (Date.now() > deadline)
      throw new Error(
        `timeout in attesa di: ${what} (liveSegmentIds=${JSON.stringify(row.liveSegmentIds)}, active=${row.activeSegmentId})`,
      );
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rowOf = async (id: string) =>
  (await t.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]!;

describe("ensureAgentSession", () => {
  it("è idempotente sull'owner_key e restituisce sempre lo stesso id", async () => {
    const a = await ensureAgentSession(t.db, {
      ownerKey: "pr_review:1",
      kind: "pr_review",
      title: "PR #1",
    });
    const b = await ensureAgentSession(t.db, {
      ownerKey: "pr_review:1",
      kind: "pr_review",
      title: "PR #1 bis",
    });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it("su errore DB restituisce null e non lancia", async () => {
    const broken = {
      insert: () => {
        throw new Error("db down");
      },
    } as never;
    expect(
      await ensureAgentSession(
        broken,
        { ownerKey: "x", kind: "ai_job", title: "x" },
        () => undefined,
      ),
    ).toBeNull();
  });

  it("una sessione di posta senza proprietario fallisce sul CHECK e restituisce null", async () => {
    expect(
      await ensureAgentSession(
        t.db,
        { ownerKey: "email_message:x", kind: "email_message", title: "x" },
        () => undefined,
      ),
    ).toBeNull();
  });
});

describe("createSegmentSink", () => {
  it("scrive segment_start, eventi e segment_end, apre e chiude il segmento e notifica", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:sink",
      kind: "ai_job",
      title: "t",
    }))!;
    const notified: string[] = [];
    await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (payload) => notified.push(payload));
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-1", true, {
      flushMs: 10,
    });
    sink.onStart(["interrupt_receipt_v1"]);
    sink.onEvents([{ type: "assistant_text", data: { text: "ciao" } }]);
    let row = await waitForRow(
      id,
      (r) => r.liveSegmentIds.length === 1 && r.heartbeatAt !== null,
      "segmento aperto",
    );
    expect(row.activeSegmentId).toBe("seg-1");
    expect(row.activeSegmentInteractive).toBe(true);
    expect(row.liveSegmentIds).toEqual(["seg-1"]);
    expect(row.heartbeatAt).not.toBeNull();
    await sink.onEnd({ exitCode: 0, timedOut: false });
    const events = await t.db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, id))
      .orderBy(agentSessionEvents.id);
    expect(events.map((e) => e.type)).toEqual(["segment_start", "assistant_text", "segment_end"]);
    row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual([]);
    expect(row.activeSegmentId).toBeNull();
    expect(row.capabilities).toEqual(["interrupt_receipt_v1"]);
    await waitUntil(
      () => notified.some((p) => JSON.parse(p).sessionId === id),
      "NOTIFY degli eventi",
    );
  });

  it("due segmenti in parallelo (nodi Docs): la fine del primo NON spegne la sessione", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "doc_generation:par",
      kind: "doc_generation",
      title: "d",
    }))!;
    const a = createSegmentSink(t.db, { sessionId: id, label: "docs" }, "seg-A", false, {
      flushMs: 5,
    });
    const b = createSegmentSink(t.db, { sessionId: id, label: "docs" }, "seg-B", false, {
      flushMs: 5,
    });
    a.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentId === "seg-A", "A attivo"); // A apre per primo: B sarà l'attivo
    b.onStart([]);
    await waitForRow(id, (r) => r.liveSegmentIds.length === 2, "A e B vivi");
    expect((await rowOf(id)).liveSegmentIds.sort()).toEqual(["seg-A", "seg-B"]);
    // B è l'ultimo partito, quindi è il segmento attivo; finisce PRIMA A.
    await a.onEnd({ exitCode: 0, timedOut: false });
    let row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual(["seg-B"]);
    expect(row.activeSegmentId).toBe("seg-B");
    // Ora finisce anche B, che era l'attivo: elenco vuoto → attivo svuotato.
    await b.onEnd({ exitCode: 0, timedOut: false });
    row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual([]);
    expect(row.activeSegmentId).toBeNull();
  });

  it("finisce l'ATTIVO mentre un altro è aperto: l'attivo resta (l'elenco non è vuoto)", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "doc_generation:par2",
      kind: "doc_generation",
      title: "d",
    }))!;
    const a = createSegmentSink(t.db, { sessionId: id, label: "docs" }, "seg-A", false, {
      flushMs: 5,
    });
    const b = createSegmentSink(t.db, { sessionId: id, label: "docs" }, "seg-B", false, {
      flushMs: 5,
    });
    a.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentId === "seg-A", "A attivo");
    b.onStart([]);
    await waitForRow(id, (r) => r.liveSegmentIds.length === 2, "A e B vivi");
    await b.onEnd({ exitCode: 0, timedOut: false });
    const row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual(["seg-A"]);
    expect(row.activeSegmentId).not.toBeNull();
    await a.onEnd({ exitCode: 0, timedOut: false });
  });

  it("un DB che fallisce non lancia da nessun metodo", async () => {
    const broken = {
      insert: () => {
        throw new Error("db down");
      },
      update: () => {
        throw new Error("db down");
      },
      execute: () => {
        throw new Error("db down");
      },
    } as never;
    const sink = createSegmentSink(broken, { sessionId: "s", label: "execute" }, "g", true, {
      flushMs: 5,
      log: () => undefined,
    });
    expect(() => sink.onStart([])).not.toThrow();
    expect(() => sink.onEvents([{ type: "assistant_text", data: {} }])).not.toThrow();
    expect(() => sink.onPartial("x")).not.toThrow();
    await expect(sink.onEnd({ exitCode: 0, timedOut: false })).resolves.toBeUndefined();
  });
});

describe("createSegmentSink — interventi chiusi (onInputsClosed)", () => {
  it("abbassa SUBITO active_segment_interactive del segmento (senza aspettare il flush) e notifica la sessione", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:inputs-closed",
      kind: "ai_job",
      title: "t",
    }))!;
    const sink = createSegmentSink(t.db, { sessionId: id, label: "plan" }, "seg-p", true, {
      flushMs: 60_000,
    });
    sink.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentInteractive, "segmento interattivo aperto");
    const notified: string[] = [];
    const sub = await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => notified.push(p));
    try {
      sink.onInputsClosed!();
      const row = await waitForRow(id, (r) => !r.activeSegmentInteractive, "flag abbassato", 2000);
      // Il segmento resta vivo e attivo: è cambiato solo il permesso di scrivere.
      expect(row.liveSegmentIds).toEqual(["seg-p"]);
      expect(row.activeSegmentId).toBe("seg-p");
      expect(row.activeSegmentLabel).toBe("plan");
      await waitUntil(
        () => notified.some((p) => JSON.parse(p).sessionId === id),
        "NOTIFY della sessione",
        2000,
      );
    } finally {
      await sub.unlisten();
      await sink.onEnd({ exitCode: 0, timedOut: false });
    }
  });

  it("tocca SOLO il proprio segmento: se l'attivo è un altro, il flag resta", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:inputs-closed-other",
      kind: "ai_job",
      title: "t",
    }))!;
    const a = createSegmentSink(t.db, { sessionId: id, label: "plan" }, "seg-A", true, {
      flushMs: 5,
    });
    const b = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-B", true, {
      flushMs: 5,
    });
    a.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentId === "seg-A", "A attivo");
    b.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentId === "seg-B", "B attivo");
    a.onInputsClosed!();
    // A scrive qualcos'altro DOPO il segnale: quando l'evento c'è, il segnale è già passato.
    a.onEvents([{ type: "assistant_text", data: { text: "dopo" } }]);
    await waitUntil(
      async () =>
        (
          await t.db
            .select()
            .from(agentSessionEvents)
            .where(eq(agentSessionEvents.sessionId, id))
        ).some((e) => e.type === "assistant_text"),
      "evento di A scritto",
    );
    const row = await rowOf(id);
    expect(row.activeSegmentId).toBe("seg-B");
    expect(row.activeSegmentInteractive).toBe(true);
    await a.onEnd({ exitCode: 0, timedOut: false });
    await b.onEnd({ exitCode: 0, timedOut: false });
  });

  it("il segmento successivo riporta l'interattività come sempre", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:inputs-closed-next",
      kind: "ai_job",
      title: "t",
    }))!;
    const plan = createSegmentSink(t.db, { sessionId: id, label: "plan" }, "seg-1", true, {
      flushMs: 5,
    });
    plan.onStart([]);
    await waitForRow(id, (r) => r.activeSegmentInteractive, "piano interattivo");
    plan.onInputsClosed!();
    await waitForRow(id, (r) => !r.activeSegmentInteractive, "piano chiuso agli interventi");
    await plan.onEnd({ exitCode: 0, timedOut: false });
    const exec = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-2", true, {
      flushMs: 5,
    });
    exec.onStart([]);
    const row = await waitForRow(
      id,
      (r) => r.activeSegmentId === "seg-2",
      "esecuzione aperta",
    );
    expect(row.activeSegmentInteractive).toBe(true);
    await exec.onEnd({ exitCode: 0, timedOut: false });
  });

  it("dopo onEnd è un no-op, e con il DB giù non lancia", async () => {
    const broken = {
      insert: () => {
        throw new Error("db down");
      },
      update: () => {
        throw new Error("db down");
      },
      execute: () => {
        throw new Error("db down");
      },
    } as never;
    const logs: string[] = [];
    const sink = createSegmentSink(broken, { sessionId: "s", label: "plan" }, "g", true, {
      flushMs: 1,
      log: (m) => logs.push(m),
    });
    sink.onStart([]);
    expect(() => sink.onInputsClosed!()).not.toThrow();
    await sink.onEnd({ exitCode: 0, timedOut: false });
    expect(() => sink.onInputsClosed!()).not.toThrow();
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("createSegmentSink — logger che lancia", () => {
  it("con il DB giù e un logger che lancia: segment_end è comunque tentato e nessuna unhandledRejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const inserted: string[] = [];
      const db = {
        insert: () => ({
          values: (rows: { type: string }[]) => {
            inserted.push(...rows.map((r) => r.type));
            return Promise.reject(new Error("db down"));
          },
        }),
        update: () => {
          throw new Error("db down");
        },
        execute: () => Promise.reject(new Error("db down")),
      } as never;
      const sink = createSegmentSink(db, { sessionId: "s-log", label: "execute" }, "g", true, {
        flushMs: 1,
        log: () => {
          throw new Error("logger rotto");
        },
      });
      sink.onStart([]);
      await new Promise((r) => setTimeout(r, 20));
      sink.onEvents([{ type: "assistant_text", data: {} }]);
      await sink.onEnd({ exitCode: 0, timedOut: false });
      await new Promise((r) => setTimeout(r, 20));
      expect(inserted).toContain("segment_end");
      expect(sink.pendingEvents()).toBe(0);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("createSegmentSink — DB appeso", () => {
  it("la coda di scrittura è limitata: oltre il tetto scarta i più vecchi, UNA riga di log col conteggio", async () => {
    const hang = () => new Promise<never>(() => undefined);
    const hung = {
      insert: () => ({ values: hang }),
      update: () => ({ set: () => ({ where: hang }) }),
      execute: hang,
    } as never;
    const lines: string[] = [];
    const sink = createSegmentSink(hung, { sessionId: "s-hung", label: "execute" }, "g", true, {
      flushMs: 1,
      heartbeatMs: 2,
      log: (m) => lines.push(m),
    });
    sink.onStart([]);
    const total = MAX_PENDING_EVENTS + 3000;
    let max = 0;
    for (let i = 0; i < total; i++) {
      sink.onEvents([{ type: "assistant_text", data: { i } }]);
      sink.onPartial("x".repeat(100));
      max = Math.max(max, sink.pendingEvents());
      if (i % 1000 === 0) await new Promise((r) => setTimeout(r, 5)); // flush e heartbeat girano
    }
    expect(max).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
    expect(sink.pendingEvents()).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
    await sink.onEnd({ exitCode: 0, timedOut: false });
    expect(sink.pendingEvents()).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
    const drops = lines.filter((l) => l.includes("eventi scartati, DB lento"));
    expect(drops).toHaveLength(1);
    // 1 segment_start + total eventi + 1 segment_end, meno quelli rimasti/in volo.
    const n = Number(/(\d+) eventi scartati/.exec(drops[0]!)![1]);
    expect(drops[0]).toBe(`sessione s-hung: ${n} eventi scartati, DB lento`);
    expect(n).toBeGreaterThanOrEqual(total + 2 - MAX_PENDING_EVENTS - MAX_PENDING_EVENTS);
    expect(n).toBeLessThanOrEqual(total + 2);
  }, 20_000);
});

describe("createSegmentSink — scrittore", () => {
  const instantDb = (onLast: () => void, inserted: string[]) =>
    ({
      insert: () => ({
        values: (rows: { type: string }[]) => {
          inserted.push(...rows.map((r) => r.type));
          return Promise.resolve();
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      execute: () => {
        onLast();
        return Promise.resolve();
      },
    }) as never;

  // Lost wakeup: onEnd che arriva nella finestra in cui lo scrittore ha già
  // verificato di non avere più niente. Si prova a ogni distanza (in
  // microtask) dall'ultima scrittura, così la finestra viene colpita.
  it.each([0, 1, 2, 3, 4, 5, 6, 8])(
    "onEnd a %i microtask dall'ultima scrittura scrive comunque segment_end",
    async (hops) => {
      const inserted: string[] = [];
      // eslint-disable-next-line prefer-const
      let sink!: ReturnType<typeof createSegmentSink>;
      let endP: Promise<void> | undefined;
      let fired = false;
      const db = instantDb(() => {
        if (fired) return;
        fired = true;
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < hops; i++) p = p.then(() => undefined);
        endP = p.then(() => sink.onEnd({ exitCode: 0, timedOut: false }));
      }, inserted);
      sink = createSegmentSink(db, { sessionId: "s", label: "execute" }, "g", true, {
        flushMs: 1,
        log: () => undefined,
      });
      sink.onStart([]);
      await waitUntil(() => endP !== undefined, "onEnd partito");
      await endP;
      expect(inserted).toContain("segment_end");
    },
  );

  it("onStart apre il segmento subito, senza aspettare il timer di flush", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:start-now",
      kind: "ai_job",
      title: "t",
    }))!;
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-n", true, {
      flushMs: 60_000,
    });
    sink.onStart([]);
    await waitForRow(id, (r) => r.liveSegmentIds.length === 1, "segmento aperto", 2000);
    await sink.onEnd({ exitCode: 0, timedOut: false });
  });

  it("sotto scarto segment_start non si perde: si scartano gli eventi dopo di lui", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((r) => (releaseStart = r));
    const batches: string[][] = [];
    const db = {
      insert: () => ({
        values: (rows: { type: string }[]) => {
          batches.push(rows.map((r) => r.type));
          return Promise.resolve();
        },
      }),
      update: () => ({ set: () => ({ where: () => gate }) }),
      execute: () => Promise.resolve(),
    } as never;
    const sink = createSegmentSink(db, { sessionId: "s", label: "execute" }, "g", true, {
      flushMs: 1,
      log: () => undefined,
    });
    sink.onStart([]); // l'update di apertura resta in attesa: segment_start in coda
    for (let i = 0; i < MAX_PENDING_EVENTS + 50; i++)
      sink.onEvents([{ type: "assistant_text", data: { i } }]);
    expect(sink.pendingEvents()).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
    releaseStart();
    await sink.onEnd({ exitCode: 0, timedOut: false });
    expect(batches[0]![0]).toBe("segment_start");
    expect(batches.flat().at(-1)).toBe("segment_end");
  });
});

describe("createSegmentSink — scarto e recupero", () => {
  it("oltre il tetto con il DB appeso che poi si riprende: segment_start e segment_end ci sono, il segmento si chiude", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:cap-recover",
      kind: "ai_job",
      title: "t",
    }))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = {
      insert: (tbl: never) => ({
        values: (v: never) => gate.then(() => t.db.insert(tbl).values(v)),
      }),
      update: (tbl: never) => ({
        set: (s: never) => ({
          where: (w: never) => gate.then(() => t.db.update(tbl).set(s).where(w)),
        }),
      }),
      execute: (q: never) => gate.then(() => t.db.execute(q)),
    } as never;
    const lines: string[] = [];
    const sink = createSegmentSink(gated, { sessionId: id, label: "execute" }, "seg-cap", true, {
      flushMs: 1,
      log: (m) => lines.push(m),
    });
    sink.onStart([]);
    for (let i = 0; i < MAX_PENDING_EVENTS + 500; i++)
      sink.onEvents([{ type: "assistant_text", data: { i } }]);
    release();
    await sink.onEnd({ exitCode: 0, timedOut: false });
    const types = (
      await t.db
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, id))
        .orderBy(agentSessionEvents.id)
    ).map((e) => e.type);
    expect(types[0]).toBe("segment_start");
    expect(types.at(-1)).toBe("segment_end");
    expect(types.length).toBeLessThanOrEqual(MAX_PENDING_EVENTS);
    expect(lines.filter((l) => l.includes("eventi scartati"))).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual([]);
    expect(row.activeSegmentId).toBeNull();
  }, 20_000);
});

describe("createSegmentSink — casi limite", () => {
  it("un secondo init dello stesso segmento non duplica né l'elenco né segment_start", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:reinit",
      kind: "ai_job",
      title: "t",
    }))!;
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-r", true, {
      flushMs: 5,
    });
    sink.onStart(["a"]);
    sink.onStart(["a"]);
    await waitForRow(id, (r) => r.liveSegmentIds.length === 1, "segmento aperto");
    expect((await rowOf(id)).liveSegmentIds).toEqual(["seg-r"]);
    await sink.onEnd({ exitCode: 0, timedOut: false });
    const types = (
      await t.db
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, id))
        .orderBy(agentSessionEvents.id)
    ).map((e) => e.type);
    expect(types).toEqual(["segment_start", "segment_end"]);
  });

  it("dopo onEnd il sink non scrive più niente", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:late",
      kind: "ai_job",
      title: "t",
    }))!;
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-l", true, {
      flushMs: 5,
    });
    sink.onStart([]);
    await sink.onEnd({ exitCode: 0, timedOut: false });
    sink.onStart([]);
    sink.onEvents([{ type: "assistant_text", data: { text: "tardi" } }]);
    // Niente da attendere: dopo onEnd i metodi non accodano nulla.
    const types = (
      await t.db
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, id))
        .orderBy(agentSessionEvents.id)
    ).map((e) => e.type);
    expect(types).toEqual(["segment_start", "segment_end"]);
    expect((await rowOf(id)).liveSegmentIds).toEqual([]);
  });

  it("un parziale in attesa viene scartato quando arriva assistant_text o turn_end (nessun frammento dopo il messaggio completo)", async () => {
    for (const type of ["assistant_text", "turn_end"] as const) {
      const id = (await ensureAgentSession(t.db, {
        ownerKey: `ai_job:drop-${type}`,
        kind: "ai_job",
        title: "t",
      }))!;
      const got: string[] = [];
      await t.client.listen(AGENT_SESSION_PARTIAL_CHANNEL, (p) => got.push(p));
      const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, `seg-${type}`, true, {
        flushMs: 20,
        log: () => {},
      });
      sink.onPartial("frammento vecchio");
      sink.onEvents([{ type, data: { text: "completo" } }]);
      await sink.onEnd({ exitCode: 0, timedOut: false });
      // Marcatore: le notifiche della stessa connessione sono ordinate, quindi
      // quando arriva lui un eventuale parziale tardivo sarebbe gia' arrivato.
      await t.db.execute(
        sql`select pg_notify(${AGENT_SESSION_PARTIAL_CHANNEL}, ${JSON.stringify({ sessionId: id, marker: true })})`,
      );
      await waitUntil(
        () => got.some((p) => JSON.parse(p).marker === true && JSON.parse(p).sessionId === id),
        "marcatore",
      );
      const mine = got
        .map((p) => JSON.parse(p) as { sessionId: string; text?: string; marker?: boolean })
        .filter((p) => p.sessionId === id && !p.marker);
      expect(mine).toEqual([]);
    }
  });

  it("un parziale successivo all'evento completo viene notificato (lo scarto avviene a onEvents, non al flush)", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:after-event",
      kind: "ai_job",
      title: "t",
    }))!;
    const got: string[] = [];
    await t.client.listen(AGENT_SESSION_PARTIAL_CHANNEL, (p) => got.push(p));
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-after", true, {
      flushMs: 5,
      log: () => {},
    });
    sink.onEvents([{ type: "assistant_text", data: { text: "completo" } }]);
    sink.onPartial("successivo");
    await waitUntil(
      () => got.some((p) => JSON.parse(p).sessionId === id && JSON.parse(p).text === "successivo"),
      "NOTIFY del parziale successivo",
    );
    await sink.onEnd({ exitCode: 0, timedOut: false });
  });

  it("un parziale lungo di caratteri multibyte arriva comunque (payload di NOTIFY sotto gli 8000 byte)", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:mb",
      kind: "ai_job",
      title: "t",
    }))!;
    const got: string[] = [];
    await t.client.listen(AGENT_SESSION_PARTIAL_CHANNEL, (p) => got.push(p));
    const logs: string[] = [];
    const sink = createSegmentSink(t.db, { sessionId: id, label: "execute" }, "seg-mb", true, {
      flushMs: 5,
      log: (m) => logs.push(m),
    });
    sink.onPartial("€".repeat(5000) + "fine");
    await waitUntil(() => got.some((p) => JSON.parse(p).sessionId === id), "NOTIFY del parziale");
    await sink.onEnd({ exitCode: 0, timedOut: false });
    const mine = got
      .map((p) => JSON.parse(p) as { sessionId: string; text: string })
      .filter((p) => p.sessionId === id);
    expect(logs).toEqual([]);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text.endsWith("fine")).toBe(true);
  });
});

// Finto CLI stream-json: al primo messaggio scrive init, un parziale, un
// assistant con testo e tool_use, un tool_result e un result — ognuno con il
// valore segreto dentro. Esce alla chiusura di stdin.
const SECRET = "s3cr3t-env-value-42";
const FAKE_CLI = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const S = ${JSON.stringify(SECRET)};
let done = false;
rl.on("line", () => {
  if (done) return;
  done = true;
  out({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "token=" + S } } });
  // Cancello (solo se il test ha creato il file wait): il resto parte quando il test
  // crea il file go, cioe' dopo aver visto il NOTIFY del parziale. Il messaggio
  // completo scarta un parziale ancora in attesa, quindi senza cancello il
  // parziale non sarebbe verificabile.
  const fs = require("node:fs");
  const start = () => {
  out({ type: "assistant", message: { content: [
    { type: "text", text: "uso " + S },
    { type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo " + S } },
  ] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: S + "\\n" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "x" });
  };
  if (!fs.existsSync("wait")) start();
  else {
    const poll = setInterval(() => {
      if (fs.existsSync("go")) { clearInterval(poll); start(); }
    }, 10);
  }
});
rl.on("close", () => process.exit(0));
`;

async function fakeCli(gated = false): Promise<{
  bin: string;
  cwd: string;
  open: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "stw-store-"));
  if (gated) await writeFile(join(root, "wait"), "", "utf8");
  const bin = join(root, "claude");
  await writeFile(bin, FAKE_CLI, "utf8");
  await chmod(bin, 0o755);
  return { bin, cwd: root, open: () => writeFile(join(root, "go"), "", "utf8"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const hooksFor = (
  db: Parameters<typeof createSegmentSink>[0],
  log?: (m: string) => void,
): SessionHooks => ({
  openSegment: (session, segmentId, interactive) =>
    createSegmentSink(db, session, segmentId, interactive, {
      flushMs: 10,
      ...(log ? { log } : {}),
    }),
  register: () => () => undefined,
});

describe("runner + recorder (design §10)", () => {
  it("un valore d'ambiente materializzato non arriva MAI in agent_session_events né nei payload di NOTIFY", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:secret",
      kind: "ai_job",
      title: "t",
    }))!;
    const payloads: string[] = [];
    await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => payloads.push(p));
    await t.client.listen(AGENT_SESSION_PARTIAL_CHANNEL, (p) => payloads.push(p));
    const { bin, cwd, open, cleanup } = await fakeCli(true);
    try {
      const runner = new StreamingClaudeRunner({
        claudePath: bin,
        hooks: hooksFor(t.db),
        resultGraceMs: 50,
      });
      const run = runner.run({
        cwd,
        prompt: "vai",
        maxTurns: 3,
        timeoutMs: 10_000,
        session: { sessionId: id, label: "execute", secrets: [SECRET] },
      });
      // Se l'attesa qui sotto va in timeout il run resta appeso al cancello e
      // finisce rifiutato più tardi: mai una promise rifiutata senza gestore.
      run.catch(() => {});
      await waitUntil(
        () => payloads.some((x) => x.includes(id) && x.includes("token=")),
        "NOTIFY del parziale",
      );
      await open();
      await run;
    } finally {
      await cleanup();
    }
    await waitUntil(async () => {
      const r = await t.db
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, id));
      return r.some((e) => e.type === "segment_end");
    }, "segment_end scritto");
    const rows = await t.db
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, id));
    // Non vacuo: gli eventi col valore oscurato ci sono, e anche il parziale.
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining([
        "segment_start",
        "assistant_text",
        "tool_use",
        "tool_result",
        "turn_end",
        "segment_end",
      ]),
    );
    const stored = JSON.stringify(rows.map((r) => r.data));
    expect(stored).toContain("•••");
    expect(stored).not.toContain(SECRET);
    const [leakRow] = (await t.db.execute(
      sql`select count(*)::int as leaks from agent_session_events where session_id = ${id} and data::text like ${"%" + SECRET + "%"}`,
    )) as unknown as Array<{ leaks: number }>;
    expect(leakRow?.leaks).toBe(0);
    const mine = payloads.filter((p) => p.includes(id));
    // Il parziale notificato c'è ED è oscurato (non solo «non contiene il segreto»).
    expect(mine.some((p) => p.includes("token=•••"))).toBe(true);
    expect(payloads.join("\n")).not.toContain(SECRET);
  });

  it("DB giù: il run finisce identico, UNA riga di log, nessuna eccezione", async () => {
    // Porta 1 su loopback: connessione rifiutata a ogni query.
    const down = createDb("postgres://u:p@127.0.0.1:1/x");
    const { bin, cwd, cleanup } = await fakeCli();
    const opts = { cwd, prompt: "vai", maxTurns: 3, timeoutMs: 10_000 };
    try {
      const baseline = await new StreamingClaudeRunner({ claudePath: bin, resultGraceMs: 50 }).run(
        opts,
      );
      const logs: string[] = [];
      const runnerLogs: string[] = [];
      const withDown = await new StreamingClaudeRunner({
        claudePath: bin,
        hooks: hooksFor(down.db, (m) => logs.push(m)),
        resultGraceMs: 50,
        log: (m) => runnerLogs.push(m),
      }).run({
        ...opts,
        session: { sessionId: "00000000-0000-4000-8000-000000000000", label: "execute" },
      });
      expect(withDown.exitCode).toBe(baseline.exitCode);
      expect(withDown.output).toBe(baseline.output);
      expect(withDown.usage).toEqual(baseline.usage);
      expect(logs).toHaveLength(1);
      expect(runnerLogs).toEqual([]);
    } finally {
      await cleanup();
      await down.client.end({ timeout: 0 });
    }
  });
});

describe("resetLiveSegments", () => {
  it("all'avvio del worker nessun segmento resta aperto", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "ai_job:crash",
      kind: "ai_job",
      title: "t",
    }))!;
    await t.db
      .update(agentSessions)
      .set({ liveSegmentIds: ["orfano"], activeSegmentId: "orfano", activeSegmentLabel: "execute" })
      .where(eq(agentSessions.id, id));
    expect(await resetLiveSegments(t.db)).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row.liveSegmentIds).toEqual([]);
    expect(row.activeSegmentId).toBeNull();
  });
});

describe("pruneAgentSessions", () => {
  it("cancella le sessioni ferme da più di 14 giorni (in cascata), tiene le recenti", async () => {
    const oldId = (await ensureAgentSession(t.db, {
      ownerKey: "old",
      kind: "ai_job",
      title: "t",
    }))!;
    const newId = (await ensureAgentSession(t.db, {
      ownerKey: "new",
      kind: "ai_job",
      title: "t",
    }))!;
    await t.db
      .update(agentSessions)
      .set({
        startedAt: sql`now() - interval '20 days'`,
        lastEventAt: sql`now() - interval '15 days'`,
      })
      .where(eq(agentSessions.id, oldId));
    const pruned = await pruneAgentSessions(t.db);
    expect(pruned.sessions).toBeGreaterThanOrEqual(1);
    const ids = (await t.db.select({ id: agentSessions.id }).from(agentSessions)).map((r) => r.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it("in una sessione che vive a lungo (voce di backlog) pota gli eventi e gli interventi vecchi, non la sessione", async () => {
    const id = (await ensureAgentSession(t.db, {
      ownerKey: "backlog_item:long",
      kind: "backlog_item",
      title: "t",
    }))!;
    await t.db.insert(agentSessionEvents).values([
      {
        sessionId: id,
        segmentId: "s",
        type: "assistant_text",
        data: { text: "vecchio" },
        createdAt: sql`now() - interval '20 days'`,
      },
      { sessionId: id, segmentId: "s", type: "assistant_text", data: { text: "nuovo" } },
    ]);
    await t.db.insert(agentSessionInputs).values({
      sessionId: id,
      text: "vecchio",
      status: "delivered",
      createdAt: sql`now() - interval '20 days'`,
    });
    await t.db
      .update(agentSessions)
      .set({ lastEventAt: sql`now()` })
      .where(eq(agentSessions.id, id));
    const pruned = await pruneAgentSessions(t.db);
    expect(pruned.events).toBeGreaterThanOrEqual(1);
    expect(pruned.inputs).toBeGreaterThanOrEqual(1);
    const texts = (
      await t.db
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, id))
        .orderBy(agentSessionEvents.id)
    ).map((e) => e.data["text"]);
    expect(texts).toEqual(["nuovo"]);
    expect(await rowOf(id)).toBeDefined();
  });
});
