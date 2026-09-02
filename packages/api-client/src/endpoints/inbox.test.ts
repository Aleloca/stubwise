import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient, handledByFromError } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientReturning(body: unknown, status = 200) {
  // Il parametro di tipo esplicito serve: con un'implementazione a zero
  // argomenti `mock.calls` verrebbe inferito `[][]` e le asserzioni su url e
  // init non compilerebbero.
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204 ? new Response(null, { status }) : jsonResponse(status, body),
  );
  const client = createStubwiseClient({
    baseUrl: "",
    getAuthHeader: () => null,
    fetch: fetchImpl,
  });
  return { client, fetchImpl };
}

/** Ultima chiamata a fetch, come coppia `[url, metodo]`. */
function lastCall(fetchImpl: ReturnType<typeof clientReturning>["fetchImpl"]): [string, string] {
  const [url, init] = fetchImpl.mock.calls.at(-1)!;
  return [String(url), String(init!.method)];
}

describe("endpoints inbox", () => {
  it("list: costruisce la querystring dai filtri e omette i campi assenti", async () => {
    const { client, fetchImpl } = clientReturning({ items: [], nextCursor: null });

    await client.inbox.list({ status: "open", projectId: ID }, "cur", 10);
    expect(lastCall(fetchImpl)).toEqual([
      `/api/inbox?status=open&projectId=${ID}&cursor=cur&limit=10`,
      "GET",
    ]);

    await client.inbox.list();
    expect(lastCall(fetchImpl)).toEqual(["/api/inbox", "GET"]);
  });

  it("read/handled: POST sulle rotte dedicate, 204 senza corpo", async () => {
    const { client, fetchImpl } = clientReturning(null, 204);

    await expect(client.inbox.read(ID)).resolves.toBeUndefined();
    expect(lastCall(fetchImpl)).toEqual([`/api/inbox/${ID}/read`, "POST"]);

    await expect(client.inbox.handled(ID)).resolves.toBeUndefined();
    expect(lastCall(fetchImpl)).toEqual([`/api/inbox/${ID}/handled`, "POST"]);
  });

  it("snooze: manda `until` nel corpo e restituisce la scadenza validata", async () => {
    const { client, fetchImpl } = clientReturning({ snoozedUntil: "2026-09-02T10:00:00.000Z" });

    await expect(client.inbox.snooze(ID, "1h")).resolves.toEqual({
      snoozedUntil: "2026-09-02T10:00:00.000Z",
    });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/inbox/${ID}/snooze`);
    expect(init!.body).toBe(JSON.stringify({ until: "1h" }));
  });

  it("act: l'azione decisionale è un segmento del path, non un campo del corpo", async () => {
    const { client, fetchImpl } = clientReturning({
      kind: "job.plan_review",
      changedNotificationIds: [ID],
    });

    await expect(client.inbox.act(ID, "reject_plan", { instructions: "rifai" })).resolves.toEqual({
      kind: "job.plan_review",
      changedNotificationIds: [ID],
    });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/inbox/${ID}/actions/reject_plan`);
    expect(init!.body).toBe(JSON.stringify({ instructions: "rifai" }));
  });

  it("answer: passa dalla stessa rotta azione con il corpo della risposta", async () => {
    const { client, fetchImpl } = clientReturning({
      kind: "job.awaiting_input",
      changedNotificationIds: [],
    });

    await client.inbox.answer(ID, { optionIndex: 1 });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/inbox/${ID}/actions/answer`);
    expect(init!.body).toBe(JSON.stringify({ optionIndex: 1 }));
  });

  it("handledByFromError: legge `handledBy` solo dal 409 already_handled", async () => {
    const handledBy = { id: ID, email: "ada@example.com" };
    const { client } = clientReturning({ code: "already_handled", message: "…", handledBy }, 409);

    const error = await client.inbox.act(ID, "approve_plan").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(handledByFromError(error)).toEqual(handledBy);

    // Qualunque altro errore (o un body senza `handledBy`) → undefined.
    expect(handledByFromError(new ApiError(409, "…", "job_in_flight"))).toBeUndefined();
    expect(handledByFromError(new Error("boom"))).toBeUndefined();
    expect(
      handledByFromError(new ApiError(409, "…", "already_handled", { details: { message: "…" } })),
    ).toBeUndefined();
  });
});
