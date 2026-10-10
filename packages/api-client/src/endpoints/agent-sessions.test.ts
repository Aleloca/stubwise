import { isUnknown } from "@stubwise/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient, isAgentSessionsUnavailable } from "../index.js";

const ID = "7f1c2a1e-0000-4000-8000-000000000001";
const OTHER = "7f1c2a1e-0000-4000-8000-000000000002";

/** Un dettaglio come lo manderebbe un server PIÙ VECCHIO: senza nessun campo additivo. */
const OLD_DETAIL = {
  id: ID,
  kind: "ai_job",
  title: "t",
  projectId: null,
  projectName: null,
  ticketId: null,
  ticketNumber: null,
  startedAt: "2026-10-08T10:00:00.000Z",
  lastEventAt: null,
  state: "working",
};

function clientReturning(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  const client = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
  return { client, fetchImpl };
}

describe("endpoints agentSessions", () => {
  it("parsa un dettaglio di un server più vecchio senza i campi additivi", async () => {
    const { client, fetchImpl } = clientReturning(OLD_DETAIL);
    const detail = await client.agentSessions.get(ID);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`/api/agent-sessions/${ID}`);
    expect(detail.canWrite).toBe(false);
    expect(detail.canInterrupt).toBe(false);
    expect(detail.questions).toEqual([]);
    expect(detail.inputs).toEqual([]);
    expect(detail.paused).toBe(false);
    expect(detail.aiJobId).toBeNull();
    expect(detail.outcome).toBeNull();
    expect(detail.activeSegment).toBeNull();
    expect(detail.lastActivity).toBeNull();
  });

  it("parsa un elenco di un server più vecchio: i campi additivi delle voci prendono il default", async () => {
    const { client } = clientReturning({ live: [OLD_DETAIL], recent: [] });
    const list = await client.agentSessions.list();
    expect(list.live).toHaveLength(1);
    expect(list.live[0]!.aiJobId).toBeNull();
    expect(list.live[0]!.outcome).toBeNull();
    expect(list.live[0]!.activeSegment).toBeNull();
  });

  it("un intervento senza authorName (server più vecchio) si legge null", async () => {
    const { client } = clientReturning({
      ...OLD_DETAIL,
      inputs: [
        {
          id: OTHER,
          text: "chiamala add",
          status: "delivered",
          reason: null,
          authorUserId: null,
          createdAt: "2026-10-08T10:01:00.000Z",
        },
      ],
    });
    const detail = await client.agentSessions.get(ID);
    expect(detail.inputs[0]!.authorName).toBeNull();
  });

  it("un kind e uno stato sconosciuti non rompono il parse (readerSchema)", async () => {
    const { client } = clientReturning({
      ...OLD_DETAIL,
      kind: "future_kind",
      state: "future_state",
      outcome: "future_outcome",
    });
    const detail = await client.agentSessions.get(ID);
    expect(isUnknown(detail.kind)).toBe(true);
    expect(isUnknown(detail.state)).toBe(true);
    expect(isUnknown(detail.outcome)).toBe(true);
    expect(detail.title).toBe("t");
  });

  it("un tipo di evento sconosciuto non rompe la pagina di eventi", async () => {
    const { client, fetchImpl } = clientReturning({
      events: [{ id: "42", type: "future_event", segmentId: "s1", at: "2026-10-08T10:00:00.000Z", data: {} }],
      before: null,
    });
    const page = await client.agentSessions.events(ID, { before: "100", limit: 50 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`/api/agent-sessions/${ID}/events?before=100&limit=50`);
    expect(page.events).toHaveLength(1);
    expect(isUnknown(page.events[0]!.type)).toBe(true);
  });

  it("list: i filtri finiscono nella query, e senza filtri il path è nudo", async () => {
    const { client, fetchImpl } = clientReturning({ live: [], recent: [] });
    await client.agentSessions.list();
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("/api/agent-sessions");
    await client.agentSessions.list({ aiJobId: ID });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(`/api/agent-sessions?aiJobId=${ID}`);
    await client.agentSessions.list({ projectId: ID, ticketId: OTHER });
    expect(String(fetchImpl.mock.calls[2]![0])).toBe(`/api/agent-sessions?projectId=${ID}&ticketId=${OTHER}`);
  });

  it("send: POST sul path dei messaggi col body così com'è", async () => {
    const { client, fetchImpl } = clientReturning({ inputId: OTHER, status: "pending" });
    const result = await client.agentSessions.send(ID, { text: "chiamala add", interrupt: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`/api/agent-sessions/${ID}/messages`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ text: "chiamala add", interrupt: true });
    expect(result).toEqual({ inputId: OTHER, status: "pending" });
  });

  it("send: «Ferma» senza testo manda il solo interrupt (il tipo d'ingresso lo permette)", async () => {
    const { client, fetchImpl } = clientReturning({ inputId: OTHER, status: "pending" });
    await client.agentSessions.send(ID, { interrupt: true });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({ interrupt: true });
  });

  it("streamPath: path relativo, col cursore se c'è", () => {
    const { client } = clientReturning({});
    expect(client.agentSessions.streamPath(ID)).toBe(`/api/agent-sessions/${ID}/stream`);
    expect(client.agentSessions.streamPath(ID, "42")).toBe(`/api/agent-sessions/${ID}/stream?after=42`);
  });
});

describe("isAgentSessionsUnavailable — un server senza le rotte", () => {
  it("il 404 di Fastify per una rotta che non esiste è «non disponibile su questa istanza»", async () => {
    // Forma della risposta di Fastify per una rotta non registrata: niente `code`.
    const { client } = clientReturning(
      { message: "Route GET:/api/agent-sessions not found", error: "Not Found", statusCode: 404 },
      404,
    );
    const error = await client.agentSessions.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isAgentSessionsUnavailable(error)).toBe(true);
  });

  it("il 404 di una sessione che non esiste (o non è visibile) NON è «non disponibile»", async () => {
    const { client } = clientReturning({ code: "not_found", message: "Session not found" }, 404);
    const error = await client.agentSessions.get(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isAgentSessionsUnavailable(error)).toBe(false);
  });

  it("altri errori (rete, 500, valori non ApiError) non sono «non disponibile»", () => {
    expect(isAgentSessionsUnavailable(new ApiError(0, "network"))).toBe(false);
    expect(isAgentSessionsUnavailable(new ApiError(500, "boom"))).toBe(false);
    expect(isAgentSessionsUnavailable(new Error("x"))).toBe(false);
    expect(isAgentSessionsUnavailable(undefined)).toBe(false);
  });
});
