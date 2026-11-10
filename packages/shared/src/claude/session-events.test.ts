import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionInput, AgentSessionQuestion } from "../schemas/agent-session.js";
import { openQuestion, pendingPlan, toConversationEvents } from "./session-events.js";
import { phaseOf } from "./task-work.js";

const AT = (m: number) => `2026-11-10T10:${String(m).padStart(2, "0")}:00.000Z`;
let seq = 0;
const ev = (type: AgentSessionEvent["type"], data: Record<string, unknown>, m: number, segmentId = "s1"): AgentSessionEvent => {
  seq += 1;
  return { id: String(seq), type, segmentId, at: AT(m), data };
};
const USER = "00000000-0000-4000-8000-0000000000b1";
const input = (over: Partial<AgentSessionInput>): AgentSessionInput => ({
  id: "00000000-0000-4000-8000-0000000000c1",
  text: "Usa Postgres",
  status: "delivered",
  reason: null,
  authorUserId: USER,
  authorName: "a@example.com",
  interrupt: false,
  createdAt: AT(3),
  ...over,
});
const question = (over: Partial<AgentSessionQuestion> = {}): AgentSessionQuestion => ({
  id: "00000000-0000-4000-8000-0000000000d1",
  source: "agent",
  question: "Quale database?",
  askedAt: AT(4),
  answered: false,
  options: [{ label: "Postgres", consequence: "come oggi" }, { label: "SQLite" }],
  recommendedIndex: 0,
  allowFreeText: false,
  canAnswer: true,
  ticketId: null,
  answer: null,
  cancelled: false,
  ...over,
});
const base = { partials: {}, inputs: [] as AgentSessionInput[], questions: [] as AgentSessionQuestion[], live: false };

describe("toConversationEvents: dagli eventi del server a quelli del prototipo", () => {
  it("fase (aperta e poi chiusa con l'esito), testo, azione col risultato", () => {
    const events = [
      ev("segment_start", { label: "plan", interactive: true }, 1),
      ev("assistant_text", { text: "Leggo il codice" }, 2),
      ev("tool_use", { toolUseId: "t1", name: "Read", input: { file_path: "a.ts" } }, 2),
      ev("tool_result", { toolUseId: "t1", isError: false, content: "ok", truncated: false }, 3),
      ev("segment_end", { exitCode: 0, timedOut: false }, 5),
    ];
    const out = toConversationEvents({ ...base, events });
    expect(out.map((e) => e.type)).toEqual(["phase", "assistant", "action"]);
    expect(out[0]).toMatchObject({ type: "phase", phase: "plan", outcome: "ok" });
    expect(out[1]).toMatchObject({ type: "assistant", text: "Leggo il codice", done: true });
    expect(out[2]).toMatchObject({ type: "action", tool: "Read", state: "done", result: "ok", input: JSON.stringify({ file_path: "a.ts" }) });
    expect(phaseOf(out)).toBe("plan");
  });

  it("esiti della fase: ancora aperta null, scaduta timed_out, errore failed", () => {
    const open = toConversationEvents({ ...base, events: [ev("segment_start", { label: "execute" }, 1)] });
    expect(open[0]).toMatchObject({ outcome: null });
    const timedOut = toConversationEvents({
      ...base,
      events: [ev("segment_start", { label: "execute" }, 1), ev("segment_end", { exitCode: 1, timedOut: true }, 2)],
    });
    expect(timedOut[0]).toMatchObject({ outcome: "timed_out" });
    const failed = toConversationEvents({
      ...base,
      events: [ev("segment_start", { label: "execute" }, 1), ev("segment_end", { exitCode: 2, timedOut: false }, 2)],
    });
    expect(failed[0]).toMatchObject({ outcome: "failed" });
  });

  it("il testo dal vivo (parziale) è un assistant non finito; un'azione senza risultato è running, con errore failed", () => {
    const out = toConversationEvents({
      ...base,
      live: true,
      events: [ev("segment_start", { label: "execute" }, 1), ev("tool_use", { toolUseId: "t9", name: "Bash", input: "ls" }, 2)],
      partials: { s1: "Sto scriv" },
    });
    expect(out.find((e) => e.type === "action")).toMatchObject({ state: "running", input: "ls" });
    expect(out.find((e) => e.type === "assistant")).toMatchObject({ text: "Sto scriv", done: false });
    const failed = toConversationEvents({
      ...base,
      events: [
        ev("tool_use", { toolUseId: "t2", name: "Bash", input: "x" }, 1),
        ev("tool_result", { toolUseId: "t2", isError: true, content: "boom" }, 2),
      ],
    });
    expect(failed[0]).toMatchObject({ state: "failed", result: "boom" });
  });

  it("un intervento è un messaggio user con chi l'ha scritto e la consegna; «Ferma» senza testo non è un messaggio", () => {
    const delivered = input({ id: "00000000-0000-4000-8000-0000000000c2" });
    const stop = input({ id: "00000000-0000-4000-8000-0000000000c3", text: "", interrupt: true, createdAt: AT(6) });
    const failedInput = input({ id: "00000000-0000-4000-8000-0000000000c4", status: "undelivered", reason: "stdin_closed", createdAt: AT(7), authorUserId: null });
    const out = toConversationEvents({
      ...base,
      inputs: [delivered, stop, failedInput],
      events: [ev("input", { text: "Usa Postgres", interrupt: false, inputId: delivered.id, authorUserId: USER }, 3)],
    });
    const users = out.filter((e) => e.type === "user");
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ authorId: USER, text: "Usa Postgres", delivery: "delivered", attachments: [] });
    expect(users[1]).toMatchObject({ authorId: "", delivery: "undelivered", undeliveredReason: "stdin_closed" });
  });

  it("le domande vengono da detail.questions: opzioni, consigliata, risposta; openQuestion trova quella aperta", () => {
    const answered = question({ id: "00000000-0000-4000-8000-0000000000d2", answered: true, answer: { optionIndex: 1 }, askedAt: AT(2) });
    const open = question();
    const out = toConversationEvents({
      ...base,
      questions: [answered, open],
      events: [
        ev("tool_use", { toolUseId: "q1", name: "mcp__stubwise__ask_user", input: {} }, 2),
        ev("tool_use", { toolUseId: "q2", name: "mcp__stubwise__ask_user", input: {} }, 4),
      ],
    });
    const qs = out.filter((e) => e.type === "question");
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ questionId: answered.id, answer: { optionIndex: 1, text: null } });
    expect(qs[1]).toMatchObject({
      questionId: open.id,
      text: "Quale database?",
      options: [{ label: "Postgres", consequence: "come oggi", recommended: true }, { label: "SQLite", recommended: false }],
      answer: null,
    });
    expect(openQuestion(out)?.questionId).toBe(open.id);
    expect(out.some((e) => e.type === "action")).toBe(false);
  });

  it("il piano viene dal ticket: un evento plan al suo posto nel tempo; pendingPlan lo trova finché aspetta", () => {
    const events = [ev("segment_start", { label: "plan" }, 1), ev("assistant_text", { text: "Ecco il piano" }, 5)];
    const plan = { text: "## Piano", summary: "Tre passi", status: "pending" as const, at: AT(3) };
    const out = toConversationEvents({ ...base, events, plan });
    expect(out.map((e) => e.type)).toEqual(["phase", "plan", "assistant"]);
    expect(out[1]).toMatchObject({ planText: "## Piano", summary: "Tre passi", status: "pending" });
    expect(pendingPlan(out)?.planText).toBe("## Piano");
    const decided = toConversationEvents({ ...base, events, plan: { ...plan, status: "approved", decidedById: USER } });
    expect(pendingPlan(decided)).toBeNull();
    expect(decided[1]).toMatchObject({ status: "approved", decidedById: USER });
  });

  it("un tipo di evento ignoto (server più nuovo) si salta, non rompe", () => {
    const out = toConversationEvents({
      ...base,
      events: [{ id: "900", type: "nuovo" as AgentSessionEvent["type"], segmentId: "s1", at: AT(1), data: {} }],
    });
    expect(out).toEqual([]);
  });
});
