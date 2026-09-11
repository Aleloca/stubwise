import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient } from "../index.js";

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

/** Un client la cui unica risposta è quella data — per i test di pre-approvazione, dove il body/status conta. */
function clientReturning(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

/** Ticket minimo valido per `ticketDetailSchema`, coi soli campi che i test di pre-approvazione fanno variare. */
function ticketDetail(overrides: {
  planApprovedAt?: string | null;
  planApprovedBy?: { id: string; email: string } | null;
  planApprovalStale?: boolean;
}) {
  return {
    id: ID,
    projectId: ID,
    number: 1,
    title: "Un ticket",
    body: "Corpo",
    type: "task",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    milestoneId: null,
    effort: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    implementationPlan: null,
    originContent: null,
    planSummary: null,
    repositories: [],
    ...overrides,
  };
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
  it("preApprovePlan: POST sulla rotta, torna il ticket intero con i tre campi", async () => {
    const detail = ticketDetail({
      planApprovedAt: "2026-09-11T10:00:00.000Z",
      planApprovedBy: { id: ID, email: "maintainer@example.com" },
      planApprovalStale: false,
    });
    const { c, fetchImpl } = clientReturning(200, detail);

    const result = await c.tickets.preApprovePlan(ID);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/pre-approve-plan`);
    expect(init!.method).toBe("POST");
    expect(result.planApprovedBy).toEqual({ id: ID, email: "maintainer@example.com" });
  });

  it("preApprovePlan: 409 no_plan — nessun piano da approvare", async () => {
    const { c } = clientReturning(409, { code: "no_plan", message: "…" });
    const error = await c.tickets.preApprovePlan(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("no_plan");
  });

  it("preApprovePlan: 403 forbidden — un non-admin non passa (il divieto vero resta lato server)", async () => {
    const { c } = clientReturning(403, { code: "forbidden", message: "…" });
    const error = await c.tickets.preApprovePlan(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe("forbidden");
  });

  it("revokePlanApproval: DELETE sulla rotta, idempotente — torna 200 anche su un ticket mai approvato", async () => {
    const detail = ticketDetail({ planApprovedAt: null, planApprovedBy: null, planApprovalStale: false });
    const { c, fetchImpl } = clientReturning(200, detail);

    const result = await c.tickets.revokePlanApproval(ID);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/pre-approve-plan`);
    expect(init!.method).toBe("DELETE");
    expect(result.planApprovedAt).toBeNull();
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
