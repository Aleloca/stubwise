import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "./api";
import { CONVERSATION_EVENTS, SCRIPTS } from "./seed/conversations";
import { setSessionPersonId } from "./session";
import { canSeeConversation, state } from "./store";
import {
  mergeStreamEvent,
  runScript,
  simulateDisconnect,
  subscribe,
  whenIdle,
  type StreamConnection,
} from "./stream";
import type { ConversationEvent, ScriptStep } from "./types";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

afterEach(() => {
  vi.useRealTimers();
});

type Received = { e: ConversationEvent; mode: "append" | "update" };

function as(personId: string, conversationId: string): void {
  setSessionPersonId(personId);
  const c = state.conversations.find((x) => x.id === conversationId)!;
  expect(canSeeConversation(personId, c)).toBe(true);
}

/** Il testo dei messaggi `say` di uno script, nell'ordine. */
const sayTexts = (steps: ScriptStep[]) => steps.flatMap((s) => (s.step === "say" ? [s.text] : []));

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("subscribe", () => {
  it("rimanda gli eventi già accaduti, nell'ordine e come `append`", () => {
    as("p-laura", "cv-run-stw-1");
    const got: Received[] = [];
    const unsubscribe = subscribe("cv-run-stw-1", (e, mode) => got.push({ e, mode }));
    unsubscribe();
    expect(got.map((g) => g.mode)).toEqual(got.map(() => "append"));
    expect(got.map((g) => g.e)).toEqual(CONVERSATION_EVENTS["cv-run-stw-1"]);
  });

  it("i pezzi di un messaggio compongono il testo intero una sola volta (3–12 parole ciascuno)", async () => {
    as("p-stefano", "cv-run-aud-5");
    const seeded = new Set(CONVERSATION_EVENTS["cv-run-aud-5"]!.map((e) => e.id));
    const got: Received[] = [];
    subscribe("cv-run-aud-5", (e, mode) => got.push({ e, mode }));
    await whenIdle("cv-run-aud-5");

    const live = got.filter((g) => !seeded.has(g.e.id));
    const assistantIds = [
      ...new Set(live.filter((g) => g.e.type === "assistant").map((g) => g.e.id)),
    ];
    expect(assistantIds).toHaveLength(sayTexts(SCRIPTS["cv-run-aud-5"]!).length);

    assistantIds.forEach((id, i) => {
      const seq = live.filter((g) => g.e.id === id);
      expect(seq[0]!.mode).toBe("append");
      expect(seq.slice(1).every((g) => g.mode === "update")).toBe(true);
      expect(seq.length).toBeGreaterThan(2);
      // Ogni pezzo allunga il testo di prima: i delta, uniti, sono il testo intero.
      let previous = "";
      const deltas: string[] = [];
      for (const { e } of seq) {
        if (e.type !== "assistant") throw new Error("type");
        expect(e.text.startsWith(previous)).toBe(true);
        deltas.push(e.text.slice(previous.length));
        previous = e.text;
      }
      expect(deltas.join("")).toBe(sayTexts(SCRIPTS["cv-run-aud-5"]!)[i]);
      for (const d of deltas) {
        expect(words(d)).toBeGreaterThanOrEqual(3);
        expect(words(d)).toBeLessThanOrEqual(12);
      }
      // `done` solo sull'ultimo pezzo.
      expect(seq.map((g) => (g.e.type === "assistant" ? g.e.done : null))).toEqual(
        seq.map((_, k) => k === seq.length - 1),
      );
    });

    // Nel flusso salvato c'è un solo evento per id, col testo intero.
    const log = state.conversationEvents.get("cv-run-aud-5")!;
    expect(new Set(log.map((e) => e.id)).size).toBe(log.length);
  });

  it("le azioni passano da `running` a `done`, anche quella lasciata in corso dal seed", async () => {
    as("p-stefano", "cv-run-aud-5");
    const runningId = CONVERSATION_EVENTS["cv-run-aud-5"]!.at(-1)!.id;
    const got: Received[] = [];
    subscribe("cv-run-aud-5", (e, mode) => got.push({ e, mode }));
    await whenIdle("cv-run-aud-5");

    const finished = got.filter((g) => g.e.id === runningId).at(-1)!.e;
    expect(finished.type === "action" && finished.state).toBe("done");

    const seeded = new Set(CONVERSATION_EVENTS["cv-run-aud-5"]!.map((e) => e.id));
    const actionIds = [
      ...new Set(
        got.filter((g) => !seeded.has(g.e.id) && g.e.type === "action").map((g) => g.e.id),
      ),
    ];
    expect(actionIds.length).toBe(
      SCRIPTS["cv-run-aud-5"]!.filter((s) => s.step === "action").length,
    );
    for (const id of actionIds) {
      const states = got
        .filter((g) => g.e.id === id)
        .map((g) => (g.e.type === "action" ? g.e.state : null));
      expect(states).toEqual(["running", "done"]);
    }
  });

  it("consegna il messaggio rimasto in attesa", async () => {
    as("p-laura", "cv-run-stw-3");
    subscribe("cv-run-stw-3", () => {});
    await whenIdle("cv-run-stw-3");
    const log = state.conversationEvents.get("cv-run-stw-3")!;
    expect(log.filter((e) => e.type === "user" && e.delivery === "pending")).toEqual([]);
  });

  it("dopo la disiscrizione non arriva più niente", async () => {
    as("p-stefano", "cv-run-aud-5");
    let count = 0;
    const unsubscribe = subscribe("cv-run-aud-5", () => (count += 1));
    const replayed = count;
    unsubscribe();
    await whenIdle("cv-run-aud-5");
    expect(count).toBe(replayed);
    expect(state.conversationEvents.get("cv-run-aud-5")!.length).toBeGreaterThan(replayed);
  });

  it("una conversazione invisibile o inesistente non si apre (`not_found`)", () => {
    setSessionPersonId("p-sara");
    expect(() => subscribe("cv-mail-giulia", () => {})).toThrow("not_found");
    expect(() => subscribe("cv-giulia-week", () => {})).toThrow("not_found");
    expect(() => subscribe("cv-nope", () => {})).toThrow("not_found");
    setSessionPersonId("p-giulia");
    expect(() => subscribe("cv-mail-giulia", () => {})()).not.toThrow();
  });
});

describe("riconnessione", () => {
  // Due casi: il messaggio interrotto è ancora in corso alla ripresa (i pezzi
  // successivi portano anche quelli persi), o è finito durante la caduta (solo
  // la ripresa può completarlo).
  it.each([
    ["ancora in corso", false],
    ["finito durante la caduta", true],
  ])(
    "riprende dall'ultimo evento a metà messaggio (%s): niente pezzi doppi né persi",
    async (_, finishWhileAway) => {
      vi.useFakeTimers();
      setLatency(10);
      as("p-laura", "cv-refine-stw-4");
      const id = "cv-refine-stw-4";

      let events: ConversationEvent[] = [];
      const appended: string[] = [];
      let connection: StreamConnection = "live";
      let assistantUpdates = 0;
      const onEvent = (e: ConversationEvent, mode: "append" | "update") => {
        if (mode === "append") appended.push(e.id);
        events = mergeStreamEvent(events, e);
        if (e.type === "assistant" && mode === "update") {
          assistantUpdates += 1;
          // A metà del messaggio, la connessione cade.
          if (assistantUpdates === 2) simulateDisconnect(id);
        }
      };
      const onConnection = (c: StreamConnection) => (connection = c);
      subscribe(id, onEvent, { onConnection });

      for (let ms = 0; connection === "live" && ms < 5_000; ms++) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(connection).toBe("reconnecting");
      const partial = events.at(-1)!;
      expect(partial.type === "assistant" && !partial.done).toBe(true);
      // Lo stream continua senza di noi per qualche pezzo.
      if (finishWhileAway) {
        await vi.runAllTimersAsync();
        await whenIdle(id);
      } else {
        await vi.advanceTimersByTimeAsync(35);
      }
      const stored = state.conversationEvents.get(id)!.at(-1)!;
      expect(stored.id).toBe(partial.id);
      expect(stored.type === "assistant" && stored.done).toBe(finishWhileAway);
      expect((stored as { text: string }).text.length).toBeGreaterThan(
        (partial as { text: string }).text.length,
      );

      connection = "live";
      subscribe(id, onEvent, { afterEventId: events.at(-1)!.id, onConnection });
      await vi.runAllTimersAsync();
      await whenIdle(id);

      const log = state.conversationEvents.get(id)!;
      expect(events).toEqual(log);
      expect(new Set(appended).size).toBe(appended.length);
      const last = log.at(-1)!;
      expect(last.type === "assistant" && last.done && last.text).toBe(
        sayTexts(SCRIPTS[id]!).at(-1),
      );
    },
  );
});

describe("cambio di persona", () => {
  it("a metà stream il vecchio iscritto non riceve più niente e viene chiuso", async () => {
    vi.useFakeTimers();
    setLatency(10);
    as("p-laura", "cv-refine-stw-4");
    const got: Received[] = [];
    const connections: StreamConnection[] = [];
    let switched = false;
    subscribe(
      "cv-refine-stw-4",
      (e, mode) => {
        got.push({ e, mode });
        if (!switched && e.type === "assistant" && mode === "update") {
          switched = true;
          // Laura passa a Giulia, che pure vedrebbe la sessione: conta chi si era iscritto.
          setSessionPersonId("p-giulia");
        }
      },
      { onConnection: (c) => connections.push(c) },
    );
    await vi.runAllTimersAsync();
    await whenIdle("cv-refine-stw-4");

    const afterSwitch = got.findIndex((g) => g.e.type === "assistant" && g.mode === "update");
    expect(got.slice(afterSwitch + 1)).toEqual([]);
    expect(connections).toEqual(["closed"]);
    // Lo stream è andato avanti comunque: il messaggio è intero nel flusso salvato.
    const last = state.conversationEvents.get("cv-refine-stw-4")!.at(-1)!;
    expect(last.type === "assistant" && last.done).toBe(true);
  });
});

describe("runScript", () => {
  it("accoda gli script della stessa conversazione e aggiorna lo stato", async () => {
    as("p-giulia", "cv-giulia-week");
    const before = state.conversationEvents.get("cv-giulia-week")!.length;
    void runScript("cv-giulia-week", [
      { step: "state", state: "working" },
      {
        step: "say",
        text: "One two three four five six seven eight nine ten eleven twelve thirteen.",
      },
    ]);
    void runScript("cv-giulia-week", [
      { step: "event", event: { type: "citation", refs: [{ kind: "project", id: "prj-mkx" }] } },
      { step: "state", state: "idle" },
    ]);
    await whenIdle("cv-giulia-week");
    const log = state.conversationEvents.get("cv-giulia-week")!;
    expect(log.slice(before).map((e) => e.type)).toEqual(["assistant", "citation"]);
    expect(log.at(-1)!.id).toBe(`cv-giulia-week-e${log.length}`);
    expect(state.conversations.find((c) => c.id === "cv-giulia-week")!.state).toBe("idle");
  });

  it("`resetApi` ferma gli stream in corso e rimette il seed", async () => {
    as("p-stefano", "cv-run-aud-5");
    subscribe("cv-run-aud-5", () => {});
    resetApi();
    await Promise.resolve();
    await whenIdle("cv-run-aud-5");
    expect(state.conversationEvents.get("cv-run-aud-5")).toEqual(
      CONVERSATION_EVENTS["cv-run-aud-5"],
    );
  });
});
