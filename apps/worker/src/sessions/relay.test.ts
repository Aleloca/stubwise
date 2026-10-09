import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  comments,
  users,
  type Db,
} from "@stubwise/db";
import { t as tr } from "@stubwise/i18n";
import { AGENT_SESSION_EVENTS_CHANNEL } from "@stubwise/shared";
import {
  StreamingClaudeRunner,
  type DeliveryMeta,
  type SessionHooks,
} from "../agent/streaming-cli.js";
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

/**
 * Per isolare la NOTIFY dei soli interventi chiusi (e non quella di un batch
 * di eventi): gli hook del relay con gli eventi del runner RITARDATI di
 * `EVENTS_DELAY_MS` (la loro NOTIFY arriva quindi molto dopo) e l'istante in
 * cui il runner chiama `onInputsClosed`. In più l'istante di ogni NOTIFY
 * degli eventi della sessione.
 */
const EVENTS_DELAY_MS = 3000;
/** La finestra dopo `onInputsClosed` in cui la NOTIFY deve arrivare. */
const CLOSE_WINDOW_MS = 1000;
async function isolatedInputsClosed(relay: SessionInputRelay, sessionId: string) {
  let closedAt: number | null = null;
  const notifyTimes: number[] = [];
  const sub = await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => {
    if ((JSON.parse(p) as { sessionId: string }).sessionId === sessionId) notifyTimes.push(Date.now());
  });
  const hooks: SessionHooks = {
    openSegment: (...a) => {
      const sink = relay.openSegment(...a);
      return {
        ...sink,
        onEvents: (e) => {
          setTimeout(() => sink.onEvents(e), EVENTS_DELAY_MS);
        },
        onInputsClosed: () => {
          closedAt = Date.now();
          sink.onInputsClosed?.();
        },
      };
    },
    register: (id, h) => relay.register(id, h),
  };
  return {
    hooks,
    /** NOTIFY arrivate dopo `onInputsClosed` e prima che possa arrivare quella di un evento. */
    notifiesRightAfterClose: () =>
      closedAt === null
        ? []
        : notifyTimes.filter((at) => at >= closedAt! && at < closedAt! + CLOSE_WINDOW_MS),
    closed: () => closedAt !== null,
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
    relay.register(sessionId, { deliver: () => true, label: "self_repair" });
    await addInput(sessionId, "etichetta-self-repair");
    await relay.deliverPending(sessionId);
    const lang = await getContentLanguage(t.db);
    const [c] = await commentsWith("etichetta-self-repair");
    expect(c!.body).toBe(
      tr(lang, "comment.agentIntervention", {
        segment: tr(lang, "agentSegment.self_repair"),
        text: "etichetta-self-repair",
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

describe("SessionInputRelay — logger che lancia", () => {
  it("con il DB giù e un logger che lancia: nessuna unhandledRejection, deliverPending risolve", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const broken = {
        select: () => {
          throw new Error("db down");
        },
      } as never;
      const relay = new SessionInputRelay({
        db: broken,
        pollMs: 60_000,
        log: () => {
          throw new Error("logger rotto");
        },
      });
      // register/unregister chiamano `void deliverPending(...)`: sveglie senza attesa.
      const unregister = relay.register("s-log", { deliver: () => true });
      await expect(relay.deliverPending()).resolves.toBeUndefined();
      unregister();
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
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

// Finto CLI: al primo messaggio risponde con un piano e resta vivo finché
// stdin non si chiude; a ogni messaggio successivo risponderebbe «ok» (che
// diventerebbe l'output, se arrivasse).
const ONE_SHOT_CLI = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let turns = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  const text = turns++ === 0 ? "## Piano" : "ok";
  if (turns === 1) out({ type: "system", subtype: "init", capabilities: [] });
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "x" });
}).on("close", () => process.exit(0));
`;

/**
 * Come ONE_SHOT_CLI, ma il primo `result` arriva 500 ms dopo l'init: così la
 * NOTIFY del primo batch (segment_start, al flush dopo onStart) cade PRIMA
 * della chiusura degli interventi, fuori dalla finestra osservata.
 * `lingerMs`: quanto resta vivo dopo la chiusura di stdin.
 */
const slowFirstCli = (lingerMs: number) => `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let turns = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  const text = turns++ === 0 ? "## Piano" : "ok";
  if (turns === 1) out({ type: "system", subtype: "init", capabilities: [] });
  setTimeout(() => {
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "x" });
  }, turns === 1 ? 500 : 0);
}).on("close", () => setTimeout(() => process.exit(0), ${lingerMs}));
`;

describe("SessionInputRelay + runner: deliverable nell'output", () => {
  it("un intervento che arriva nella grazia di un segmento `plan` resta undelivered (stdin_closed) e l'output è il piano", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-relay-plan-"));
    const bin = join(root, "claude");
    await writeFile(bin, ONE_SHOT_CLI, "utf8");
    await chmod(bin, 0o755);
    const relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
    const sessionId = await newSession("ai_job:relay-plan-grace");
    try {
      // Grazia lunga: l'intervento arriva a processo VIVO, dopo il primo result.
      const runner = new StreamingClaudeRunner({
        claudePath: bin,
        hooks: relay,
        resultGraceMs: 3000,
      });
      const run = runner.run({
        cwd: root,
        prompt: "pianifica",
        maxTurns: 3,
        timeoutMs: 20_000,
        session: { sessionId, label: "plan" },
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        const ends = await t.db
          .select()
          .from(agentSessionEvents)
          .where(
            and(
              eq(agentSessionEvents.sessionId, sessionId),
              eq(agentSessionEvents.type, "turn_end"),
            ),
          );
        if (ends.length > 0) break;
        if (Date.now() > deadline) throw new Error("timeout in attesa del primo result");
        await new Promise((r) => setTimeout(r, 20));
      }
      const id = await addInput(sessionId, "rispondimi solo ok");
      await relay.deliverPending(sessionId);
      const row = await rowOf(id);
      expect(row.status).toBe("undelivered");
      expect(row.reason).toBe("stdin_closed");
      const result = await run;
      expect(result.output).toBe("## Piano");
      expect(result.inputsDelivered).toBeUndefined();
      expect(await commentsWith("rispondimi solo ok")).toHaveLength(0);
    } finally {
      relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("la finestra persa si chiude: dopo il primo result il server vede SUBITO il segmento non interattivo, e un input reclamato dopo resta undelivered (stdin_closed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-relay-closed-"));
    const bin = join(root, "claude");
    await writeFile(bin, slowFirstCli(0), "utf8");
    await chmod(bin, 0o755);
    const relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
    const sessionId = await newSession("ai_job:relay-plan-closed");
    const events = await listenEvents();
    const iso = await isolatedInputsClosed(relay, sessionId);
    try {
      // Grazia lunga: tutto quello che segue avviene a processo VIVO.
      const runner = new StreamingClaudeRunner({
        claudePath: bin,
        hooks: iso.hooks,
        resultGraceMs: 5000,
      });
      let finished = false;
      const run = runner
        .run({
          cwd: root,
          prompt: "pianifica",
          maxTurns: 3,
          timeoutMs: 20_000,
          session: { sessionId, label: "plan" },
        })
        .finally(() => {
          finished = true;
        });
      const sessionRow = async () =>
        (await t.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0]!;
      // Il segmento `plan` si apre interattivo (onStart); il CLI finto risponde
      // subito, quindi apertura e chiusura possono cadere nello stesso giro
      // dello scrittore: si aspetta «segmento aperto E non interattivo», che
      // senza il segnale non succede prima della fine della grazia (5 s).
      const deadline = Date.now() + 4000;
      for (;;) {
        const row = await sessionRow();
        if (row.activeSegmentId !== null && !row.activeSegmentInteractive) break;
        if (Date.now() > deadline) throw new Error("il flag interattivo non è mai sceso");
        await new Promise((r) => setTimeout(r, 10));
      }
      // Il segmento è ancora vivo (la grazia non è finita): è il segnale, non la fine.
      const row = await sessionRow();
      expect(finished).toBe(false);
      expect(row.liveSegmentIds).toHaveLength(1);
      expect(row.activeSegmentId).toBe(row.liveSegmentIds[0]);
      expect(events.sessionIds()).toContain(sessionId);
      // La NOTIFY è proprio quella dei interventi chiusi: gli eventi sono
      // ritardati, quindi nessun batch di eventi può averla prodotta.
      expect(iso.closed()).toBe(true);
      for (let i = 0; i < 100 && iso.notifiesRightAfterClose().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(iso.notifiesRightAfterClose().length).toBeGreaterThanOrEqual(1);
      // La corsa: un input scritto prima che il server vedesse il flag viene reclamato ora.
      const id = await addInput(sessionId, "arrivato in corsa");
      await relay.deliverPending(sessionId);
      const input = await rowOf(id);
      expect(input.status).toBe("undelivered");
      expect(input.reason).toBe("stdin_closed");
      const result = await run;
      expect(result.output).toBe("## Piano");
      expect(result.inputsDelivered).toBeUndefined();
    } finally {
      await events.stop();
      await iso.stop();
      relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("deliverable nei file (execute): alla fine della grazia il server vede SUBITO il segmento non interattivo, e un input reclamato dopo resta undelivered (stdin_closed)", async () => {
    // Il CLI resta vivo 2 s dopo la chiusura di stdin (come uno che finisce di
    // scrivere): è la finestra in cui, prima, il server diceva ancora canWrite.
    const LINGERING_CLI = slowFirstCli(2000);
    const root = await mkdtemp(join(tmpdir(), "stw-relay-exec-closed-"));
    const bin = join(root, "claude");
    await writeFile(bin, LINGERING_CLI, "utf8");
    await chmod(bin, 0o755);
    const relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
    const sessionId = await newSession("ai_job:relay-exec-closed");
    const events = await listenEvents();
    const iso = await isolatedInputsClosed(relay, sessionId);
    try {
      const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: iso.hooks, resultGraceMs: 200 });
      let finished = false;
      const run = runner
        .run({
          cwd: root,
          prompt: "esegui",
          maxTurns: 3,
          timeoutMs: 20_000,
          session: { sessionId, label: "execute" },
        })
        .finally(() => {
          finished = true;
        });
      const sessionRow = async () =>
        (await t.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0]!;
      const deadline = Date.now() + 2400;
      for (;;) {
        const row = await sessionRow();
        if (row.activeSegmentId !== null && !row.activeSegmentInteractive) break;
        if (Date.now() > deadline) throw new Error("il flag interattivo non è sceso prima dell'uscita");
        await new Promise((r) => setTimeout(r, 10));
      }
      const row = await sessionRow();
      expect(finished).toBe(false);
      expect(row.liveSegmentIds).toHaveLength(1);
      expect(events.sessionIds()).toContain(sessionId);
      // La NOTIFY è proprio quella dei interventi chiusi: gli eventi sono
      // ritardati, quindi nessun batch di eventi può averla prodotta.
      expect(iso.closed()).toBe(true);
      for (let i = 0; i < 100 && iso.notifiesRightAfterClose().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(iso.notifiesRightAfterClose().length).toBeGreaterThanOrEqual(1);
      const id = await addInput(sessionId, "arrivato in corsa sull'esecuzione");
      await relay.deliverPending(sessionId);
      const input = await rowOf(id);
      expect(input.status).toBe("undelivered");
      expect(input.reason).toBe("stdin_closed");
      const result = await run;
      expect(result.inputsDelivered).toBeUndefined();
    } finally {
      await events.stop();
      await iso.stop();
      relay.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
