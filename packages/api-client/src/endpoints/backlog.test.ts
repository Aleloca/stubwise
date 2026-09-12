import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientReturning(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(status, body));
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

/** Ultima chiamata a fetch, come coppia `[url, metodo]`. */
function lastCall(fetchImpl: ReturnType<typeof clientReturning>["fetchImpl"]): [string, string] {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return [String(url), String(init!.method)];
}

const QUESTION = {
  questionId: QUESTION_ID,
  backlogItemId: ID,
  question: "Il reso parziale può superare l'importo pagato?",
  options: [{ label: "Blocca al totale pagato" }, { label: "Consenti oltre" }],
  recommendedIndex: 0,
  allowFreeText: true,
  askedAt: "2026-09-11T09:00:00.000Z",
  answer: null,
  answeredAt: null,
  answeredBy: null,
  dismissedAt: null,
};

describe("endpoints backlog — domande a bottoni", () => {
  it("questions: legge lo storico Q&A della voce", async () => {
    const { client, fetchImpl } = clientReturning([QUESTION]);

    const questions = await client.backlog.questions(ID);

    expect(lastCall(fetchImpl)).toEqual([`/api/backlog/${ID}/questions`, "GET"]);
    expect(questions).toEqual([QUESTION]);
  });

  it("answerQuestion: POST sulla rotta con questionId nel path, non nel corpo", async () => {
    const { client, fetchImpl } = clientReturning({ backlogItemId: ID });

    await client.backlog.answerQuestion(ID, QUESTION_ID, { optionIndex: 1 });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/backlog/${ID}/questions/${QUESTION_ID}/answer`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ optionIndex: 1 });
  });

  it("answerQuestion: 404 question_not_found", async () => {
    const { client } = clientReturning({ code: "question_not_found", message: "…" }, 404);
    const error = await client.backlog.answerQuestion(ID, QUESTION_ID, { optionIndex: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe("question_not_found");
  });

  it("answerQuestion: 400 invalid_answer", async () => {
    const { client } = clientReturning({ code: "invalid_answer", message: "…" }, 400);
    const error = await client.backlog.answerQuestion(ID, QUESTION_ID, { optionIndex: 99 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("invalid_answer");
  });

  it("answerQuestion: 409 already_answered — chi perde una corsa lo scopre dal code", async () => {
    const { client } = clientReturning({ code: "already_answered", message: "…" }, 409);
    const error = await client.backlog.answerQuestion(ID, QUESTION_ID, { optionIndex: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("already_answered");
  });

  it("answerQuestion: 409 question_not_pending — la domanda non è più quella aperta", async () => {
    const { client } = clientReturning({ code: "question_not_pending", message: "…" }, 409);
    const error = await client.backlog.answerQuestion(ID, QUESTION_ID, { optionIndex: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("question_not_pending");
  });

  it("dismissQuestion: POST senza corpo sulla rotta /dismiss", async () => {
    const { client, fetchImpl } = clientReturning({ backlogItemId: ID });

    await client.backlog.dismissQuestion(ID, QUESTION_ID);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/backlog/${ID}/questions/${QUESTION_ID}/dismiss`);
    expect(init!.method).toBe("POST");
  });

  it("dismissQuestion: 409 already_answered — «non ora» arriva dopo che qualcun altro ha già risposto", async () => {
    const { client } = clientReturning({ code: "already_answered", message: "…" }, 409);
    const error = await client.backlog.dismissQuestion(ID, QUESTION_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("already_answered");
  });
});
