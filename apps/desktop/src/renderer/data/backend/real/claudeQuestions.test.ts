import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { answerFreeQuestion, questionEventsOf, readQuestions } from "./claudeQuestions";
import { installFakeServer } from "./fakeServer";

// Le domande a scelta della conversazione libera nella build app (area 10,
// F2, Task 3 di 72): l'evento `question` della sessione porta solo
// `{ questionId }`; testo, opzioni e risposta li dà la lettura a sé
// (`GET …/questions`, filtrata per chi legge come le proposte). Ne nasce la
// scheda del prototipo (`QuestionCard`); la risposta va su `POST …/answer`.

const CONV = "cccccccc-0000-4000-8000-000000000001";
const Q1 = "dddddddd-0000-4000-8000-000000000001";
const Q2 = "dddddddd-0000-4000-8000-000000000002";
const LAURA = "11111111-1111-4111-8111-111111111111";

const question = (over: Record<string, unknown> = {}) => ({
  id: Q1,
  text: "Which department should be alerted?",
  options: [
    { label: "Support", description: "Every urgent request from support" },
    { label: "Sales" },
  ],
  answer: null,
  ...over,
});
const raw = (id: string, questionId: string, at = "2026-11-19T10:00:00.000Z") =>
  ({ id, at, type: "question", data: { questionId } }) as never;

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

describe("le domande della libera nella build app", () => {
  it("l'evento della sessione diventa la scheda del prototipo, coi dati della lista; `description` è la conseguenza", () => {
    const events = questionEventsOf([raw("e1", Q1)], [question()]);
    expect(events).toEqual([
      {
        id: `question:${Q1}`,
        at: "2026-11-19T10:00:00.000Z",
        type: "question",
        questionId: Q1,
        text: "Which department should be alerted?",
        options: [
          { label: "Support", consequence: "Every urgent request from support" },
          { label: "Sales" },
        ],
        answer: null,
      },
    ]);
  });

  it("una domanda risposta: indice o testo, chi e quando", () => {
    const [byIndex] = questionEventsOf(
      [raw("e1", Q1)],
      [
        question({
          answer: {
            index: 0,
            text: null,
            by: { id: LAURA, name: "Laura" },
            at: "2026-11-19T10:01:00.000Z",
          },
        }),
      ],
    );
    expect(byIndex).toMatchObject({
      answer: { optionIndex: 0, text: null, byId: LAURA, at: "2026-11-19T10:01:00.000Z" },
    });
    const [byText] = questionEventsOf(
      [raw("e1", Q1)],
      [
        question({
          answer: { index: null, text: "Both", by: null, at: "2026-11-19T10:01:00.000Z" },
        }),
      ],
    );
    expect(byText).toMatchObject({ answer: { optionIndex: null, text: "Both", byId: "" } });
  });

  it("un evento la cui domanda la lista non dà (il seguito privato di una pubblica) non c'è; un evento ripetuto, una volta", () => {
    expect(
      questionEventsOf([raw("e1", Q2), raw("e2", Q1), raw("e3", Q1)], [question()]),
    ).toHaveLength(1);
  });

  it("la lista dal server; un server senza la rotta (404): nessuna domanda", async () => {
    installFakeServer({
      [`GET /api/claude/conversations/${CONV}/questions`]: { body: [question()] },
    });
    expect((await readQuestions(CONV)).map((q) => q.id)).toEqual([Q1]);
    installFakeServer({});
    expect(await readQuestions(CONV)).toEqual([]);
  });

  it("la risposta: un'opzione per indice o un testo, sulla rotta della conversazione", async () => {
    const { seen } = installFakeServer({
      [`POST /api/claude/conversations/${CONV}/questions/${Q1}/answer`]: {
        status: 202,
        body: { inputId: "eeeeeeee-0000-4000-8000-000000000001", status: "pending" },
      },
    });
    await answerFreeQuestion(CONV, Q1, { optionIndex: 1, text: null });
    await answerFreeQuestion(CONV, Q1, { optionIndex: null, text: "  Both  " });
    expect(seen.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { index: 1 },
      { text: "Both" },
    ]);
  });

  it("gli errori nella forma del prototipo: già risposta, archiviata, budget, opzione fuori", async () => {
    const route = `POST /api/claude/conversations/${CONV}/questions/${Q1}/answer`;
    installFakeServer({ [route]: { status: 409, body: { code: "answered", message: "x" } } });
    await expect(answerFreeQuestion(CONV, Q1, { optionIndex: 0, text: null })).rejects.toThrow(
      "already_answered",
    );
    installFakeServer({
      [route]: { status: 409, body: { code: "conversation_archived", message: "x" } },
    });
    await expect(answerFreeQuestion(CONV, Q1, { optionIndex: 0, text: null })).rejects.toThrow(
      "forbidden",
    );
    installFakeServer({
      [route]: { status: 409, body: { code: "budget_exhausted", message: "x" } },
    });
    await expect(
      answerFreeQuestion(CONV, Q1, { optionIndex: 0, text: null }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/budget/),
    });
    installFakeServer({ [route]: { status: 422, body: { code: "invalid_option", message: "x" } } });
    await expect(answerFreeQuestion(CONV, Q1, { optionIndex: 4, text: null })).rejects.toThrow(
      "invalid: option",
    );
  });
});
