import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptStep } from "../types";

// Le schede di scelta nella conversazione libera (area 10b, Task 4): a una
// richiesta a cui manca un pezzo Claude risponde con una domanda; la
// risposta la dà solo chi ha aperto la conversazione e riprende la stessa
// richiesta. Non è una domanda `ask_user` di un lavoro: nel registro
// decisioni non entra nulla. Al massimo due domande per richiesta.

// Il motore si può trattenere: una ripresa calcolata dopo «Ferma» non
// entra nel flusso (P24, come `freeTurn`).
const gate = vi.hoisted(() => ({
  hold: null as null | { release: (steps: ScriptStep[]) => void; promise: Promise<ScriptStep[]> },
}));
vi.mock("../../domain/claude/intents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../domain/claude/intents")>();
  return {
    ...original,
    respond: vi.fn((...args: Parameters<typeof original.respond>) =>
      gate.hold ? gate.hold.promise : original.respond(...args),
    ),
  };
});

import {
  answerQuestion,
  archiveConversation,
  createConversation,
  createTask,
  getConversation,
  resetApi,
  sendMessage,
  setLatency,
  setVisibility,
  stop,
  whenIdle,
} from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { ConversationEvent } from "../types";

const GIULIA = "p-giulia";
const CHIARA = "p-chiara";
const MKX = "prj-mkx";

const as = (personId: string) => setSessionPersonId(personId);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await whenIdle(id);
    await tick();
  }
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

type Question = Extract<ConversationEvent, { type: "question" }>;
const log = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
const questions = (id: string) => log(id).filter((e): e is Question => e.type === "question");
const users = (id: string) => log(id).filter((e) => e.type === "user");
const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;
const optionOf = (q: Question, name: string) => q.options.findIndex((o) => o.label === name);

function holdRespond() {
  let release!: (steps: ScriptStep[]) => void;
  const promise = new Promise<ScriptStep[]>((resolve) => {
    release = resolve;
  });
  gate.hold = { release, promise };
  return release;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  gate.hold = null;
  as(GIULIA);
});

/** Una task di Giulia in MKX senza assegnatario e una libera che chiede «assegna». */
async function asked(): Promise<{ id: string; taskId: string; code: string }> {
  const task = await createTask({ projectId: MKX, title: "Prova" });
  const c = await createConversation({ contextProjectId: MKX });
  await sendMessage(c.id, { text: `assegna ${task.code}` });
  await settle(c.id);
  return { id: c.id, taskId: task.id, code: task.code };
}

describe("la domanda nella libera", () => {
  it("«assegna MKX-…» senza a chi: una domanda con le persone di MKX, nessuna proposta", async () => {
    const { id, code } = await asked();
    const [q, ...more] = questions(id);
    expect(more).toEqual([]);
    expect(q).toMatchObject({ answer: null, resume: `assegna ${code}` });
    const members = state.projectsById.get(MKX)!.memberIds.map(nameOf);
    expect(q!.options.length).toBeGreaterThan(0);
    for (const o of q!.options) expect(members).toContain(o.label);
    expect(q!.options.map((o) => o.label)).toContain("Giulia Ferri");
    expect(q!.options.map((o) => o.label)).not.toContain("Claude");
    expect(log(id).some((e) => e.type === "proposal" || e.type === "executed")).toBe(false);
    // La libera non resta in attesa: la domanda è una scheda, non un lavoro fermo.
    expect(state.conversations.find((c) => c.id === id)!.state).toBe("idle");
  });

  it("risponde Giulia: la stessa richiesta riprende, eseguita, senza un messaggio in più né il registro", async () => {
    const { id, taskId } = await asked();
    const decisions = structuredClone(state.decisionLog);
    const before = users(id).length;
    const q = questions(id)[0]!;
    expect((await getConversation(id))!.canAnswer).toBe(true);

    await answerQuestion(id, q.questionId, {
      optionIndex: optionOf(q, "Giulia Ferri"),
      text: null,
    });
    await settle(id);

    expect(questions(id)[0]).toMatchObject({ answer: { byId: GIULIA } });
    expect(state.tasksById.get(taskId)!.assigneeId).toBe(GIULIA);
    const executed = log(id).filter((e) => e.type === "executed");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ status: "done" });
    expect(users(id)).toHaveLength(before);
    expect(state.decisionLog).toEqual(decisions);
    expect(state.conversations.find((c) => c.id === id)!.state).toBe("idle");
  });

  it("una seconda risposta è already_answered, con chi ha risposto", async () => {
    const { id } = await asked();
    const q = questions(id)[0]!;
    await answerQuestion(id, q.questionId, { optionIndex: 0, text: null });
    await settle(id);
    const after = structuredClone(log(id));
    const second = answerQuestion(id, q.questionId, { optionIndex: 1, text: null });
    await expect(second).rejects.toThrow("already_answered");
    await expect(second).rejects.toMatchObject({ byId: GIULIA });
    expect(log(id)).toEqual(after);
  });

  it("resa pubblica, un'altra persona la vede ma non risponde (forbidden)", async () => {
    const { id } = await asked();
    await setVisibility(id, "public", { confirmedProjectIds: [MKX] });
    const q = questions(id)[0]!;
    const decisions = structuredClone(state.decisionLog);
    as(CHIARA);
    expect((await getConversation(id))!.canAnswer).toBe(false);
    const before = structuredClone(log(id));
    await expect(answerQuestion(id, q.questionId, { optionIndex: 0, text: null })).rejects.toThrow(
      "forbidden",
    );
    expect(log(id)).toEqual(before);
    expect(state.decisionLog).toEqual(decisions);
  });

  it("archiviata, nemmeno chi l'ha aperta risponde: canAnswer segue canWrite", async () => {
    const { id } = await asked();
    const q = questions(id)[0]!;
    await archiveConversation(id);
    expect((await getConversation(id))!.canAnswer).toBe(false);
    await expect(answerQuestion(id, q.questionId, { optionIndex: 0, text: null })).rejects.toThrow(
      "forbidden",
    );
    expect(questions(id)[0]!.answer).toBeNull();
  });

  it("al massimo due domande per richiesta: la terza volta Claude lo dice a parole", async () => {
    const { id, taskId, code } = await asked();
    // Una risposta libera che non nomina nessuno: Claude chiede di nuovo.
    await answerQuestion(id, questions(id)[0]!.questionId, { optionIndex: null, text: "boh" });
    await settle(id);
    const [, second, ...more] = questions(id);
    expect(more).toEqual([]);
    expect(second).toMatchObject({ answer: null, resume: `assegna ${code} boh` });
    await answerQuestion(id, second!.questionId, { optionIndex: null, text: "nessuno" });
    await settle(id);
    expect(questions(id)).toHaveLength(2);
    expect(log(id).at(-1)).toMatchObject({ type: "assistant" });
    expect(state.tasksById.get(taskId)!.assigneeId).toBeNull();
  });

  it("un messaggio nuovo è una richiesta nuova: di nuovo una domanda", async () => {
    const { id, code } = await asked();
    await answerQuestion(id, questions(id)[0]!.questionId, { optionIndex: null, text: "boh" });
    await settle(id);
    await answerQuestion(id, questions(id)[1]!.questionId, { optionIndex: null, text: "nessuno" });
    await settle(id);
    await sendMessage(id, { text: `assegna ${code}` });
    await settle(id);
    expect(questions(id)).toHaveLength(3);
    expect(questions(id)[2]).toMatchObject({ answer: null, resume: `assegna ${code}` });
  });
});

describe("«Ferma» e la ripresa (P24)", () => {
  it("fermata mentre Claude pensa alla ripresa: nulla entra nel flusso, nulla si esegue", async () => {
    const { id, taskId } = await asked();
    const q = questions(id)[0]!;
    const release = holdRespond();
    const answering = answerQuestion(id, q.questionId, {
      optionIndex: optionOf(q, "Giulia Ferri"),
      text: null,
    });
    await until(() => state.conversations.find((c) => c.id === id)!.state === "working");
    const before = log(id).length;
    const stopping = stop(id);
    await tick();
    release([
      {
        step: "event",
        event: {
          type: "executed",
          groupId: "",
          status: "pending",
          actions: [
            {
              fn: "updateTask",
              args: { id: taskId, patch: { assigneeId: GIULIA } },
              summary: "LATE",
            },
          ],
        },
      },
    ]);
    await Promise.all([answering, stopping]);
    await settle(id);
    expect(
      log(id)
        .slice(before)
        .map((e) => e.type),
    ).toEqual(["phase"]);
    expect(log(id).at(-1)).toMatchObject({ type: "phase", outcome: "stopped" });
    expect(state.tasksById.get(taskId)!.assigneeId).toBeNull();
    expect(users(id)).toHaveLength(1);
  });

  it("una ripresa in coda dietro un turno fermato non risponde", async () => {
    const { id, taskId } = await asked();
    const q = questions(id)[0]!;
    const release = holdRespond();
    const sending = sendMessage(id, { text: "What should I do today?" });
    await until(() => users(id).length === 2);
    const answering = answerQuestion(id, q.questionId, {
      optionIndex: optionOf(q, "Giulia Ferri"),
      text: null,
    });
    // La ripresa è in coda (la scheda è già risposta) PRIMA di «Ferma».
    await until(() => questions(id)[0]!.answer !== null);
    await tick();
    const stopping = stop(id);
    await tick();
    release([{ step: "say", text: "LATE" }]);
    await Promise.all([sending, answering, stopping]);
    await settle(id);
    expect(questions(id)[0]).toMatchObject({ answer: { byId: GIULIA } });
    expect(log(id).some((e) => e.type === "assistant" && e.text.includes("LATE"))).toBe(false);
    expect(log(id).some((e) => e.type === "executed")).toBe(false);
    expect(state.tasksById.get(taskId)!.assigneeId).toBeNull();
    expect(log(id).at(-1)).toMatchObject({ type: "phase", outcome: "stopped" });
  });
});
