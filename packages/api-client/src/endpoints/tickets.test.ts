import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";

function client() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints tickets", () => {
  it("list: unisce `statuses` con la virgola", async () => {
    const { c, fetchImpl } = client();
    await c.tickets.list({ statuses: ["open", "in_progress"] });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/tickets?statuses=open%2Cin_progress");
  });

  it("list: una lista di stati VUOTA non manda il parametro affatto", async () => {
    // Il server risponde 400 a `statuses=` vuoto: mandarlo comunque
    // trasformerebbe "nessun filtro" in un errore.
    const { c, fetchImpl } = client();
    await c.tickets.list({ statuses: [], projectId: ID });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets?projectId=${ID}`);
  });

  it("answerQuestion: fonde la risposta con `questionId` in un corpo solo", async () => {
    const { c, fetchImpl } = client();
    await c.tickets.answerQuestion(ID, ID, { optionIndex: 2 }).catch(() => undefined);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/questions/answer`);
    expect(JSON.parse(String(init!.body))).toEqual({ optionIndex: 2, questionId: ID });
  });
  it("activity: chiama il feed del ticket e legge le voci senza chiudere i tipi", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify([
          {
            kind: "event",
            id: ID,
            eventKind: "status_changed",
            actorId: null,
            payload: { from: "triaged", to: "in_progress" },
            createdAt: "2026-09-01T10:00:00.000Z",
          },
          // Una variante che questa build non conosce: il feed resta leggibile.
          { kind: "deploy", id: ID, createdAt: "2026-09-01T11:00:00.000Z" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const c = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const items = await c.tickets.activity(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets/${ID}/activity`);
    expect(items.map((entry) => entry.kind)).toEqual(["event", "deploy"]);
    expect(items[0]!.payload?.to).toBe("in_progress");
  });
});
