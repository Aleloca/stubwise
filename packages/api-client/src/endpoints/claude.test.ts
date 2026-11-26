import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../client.js";

const ID = "7f1c2a1e-0000-4000-8000-000000000001";
const conversation = {
  id: ID,
  title: "Come va AUD?",
  archived: false,
  context: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  state: "queued",
  lastEventAt: null,
};

function client(body: unknown = conversation, status = 200) {
  const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints claude", () => {
  it("proposte e gruppi: i percorsi; conferma col corpo; «Annulla»", async () => {
    const { c, fetchImpl } = client([]);
    await c.claude.conversations.proposals(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/conversations/${ID}/proposals`);
    await c.claude.conversations.groups(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/conversations/${ID}/groups`);
    const undone = client({ kind: "undone" });
    expect(await undone.c.claude.groups.undo(ID)).toEqual({ kind: "undone" });
    expect(undone.fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/groups/${ID}/undo`);
  });

  it("lotto 4, §5: «Riprova» del seguito: POST per indice; un server di prima senza `canRetryEffect` vale false", async () => {
    const group = { id: ID, sessionId: null, proposalId: null, actions: [{ fn: "fillMailBody", args: { text: "x" }, codes: [], effectFailure: null }], executedAt: "2026-11-23T10:00:00.000Z", undo: "not_undoable", changedBy: null, undoneAt: null, undoReauth: false };
    const { c, fetchImpl } = client(group);
    const out = await c.claude.groups.retryEffect(ID, 2);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([url, init!.method]).toEqual([`/api/claude/groups/${ID}/actions/2/retry`, "POST"]);
    expect(out.actions[0]!.canRetryEffect).toBe(false);
  });


  it("area 10, F2: le domande (percorso e parse, anche senza `answer` da un server che non lo manda) e la risposta col corpo", async () => {
    const q = { id: ID, text: "Quale reparto?", options: [{ label: "Vendite" }, { label: "Supporto", description: "Il team" }] };
    const { c, fetchImpl } = client([q]);
    expect(await c.claude.conversations.questions(ID)).toEqual([{ ...q, answer: null }]);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/conversations/${ID}/questions`);
    const answered = client({ inputId: ID, status: "pending" }, 202);
    expect(await answered.c.claude.conversations.answerQuestion(ID, ID, { index: 1 })).toEqual({ inputId: ID, status: "pending" });
    const [url, init] = answered.fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/claude/conversations/${ID}/questions/${ID}/answer`);
    expect(JSON.parse(String(init!.body))).toEqual({ index: 1 });
  });

  it("status: il budget finito; senza il campo (server più vecchio) vale false", async () => {
    const { c, fetchImpl } = client({ budgetExhausted: true });
    expect(await c.claude.status()).toEqual({ budgetExhausted: true });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations/status");
    expect(await client({}).c.claude.status()).toEqual({ budgetExhausted: false });
  });


  it("list: solo le proprie, archiviate a richiesta", async () => {
    const { c, fetchImpl } = client({ items: [conversation] });
    await c.claude.conversations.list();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations?scope=mine");
    await c.claude.conversations.list({ archived: true });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations?scope=mine&archived=true");
    await c.claude.conversations.list({ limit: 20, before: "2026-11-10T10:00:00.000Z|x" });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(
      "/api/claude/conversations?scope=mine&limit=20&before=2026-11-10T10%3A00%3A00.000Z%7Cx",
    );
  });

  it("list delle pubbliche (fetta 5): scope=public", async () => {
    const { c, fetchImpl } = client({ items: [{ ...conversation, visibility: "public" }] });
    const page = await c.claude.conversations.list({ scope: "public" });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations?scope=public");
    expect(page.items[0]).toMatchObject({ visibility: "public", privateTail: false, canContinue: false });
  });

  it("visibilità e continuazione (fetta 5): percorsi e corpi", async () => {
    const { c, fetchImpl } = client({ ...conversation, visibility: "public" });
    expect(await c.claude.conversations.setVisibility(ID, { visibility: "public", confirmedProjectIds: [ID] })).toMatchObject({
      visibility: "public",
    });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/conversations/${ID}/visibility`);
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)![1]!.body))).toEqual({ visibility: "public", confirmedProjectIds: [ID] });
    await c.claude.conversations.continue(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/claude/conversations/${ID}/continue`);
    expect(fetchImpl.mock.calls.at(-1)![1]!.method).toBe("POST");
  });

  it("create e update: il corpo così com'è; uno stato ignoto si legge UNKNOWN", async () => {
    const { c, fetchImpl } = client({ ...conversation, state: "__nuovo__" });
    const created = await c.claude.conversations.create({ message: "Ciao" });
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)![1]!.body))).toEqual({ message: "Ciao" });
    expect(created.state).toBe("__unknown__");
    await c.claude.conversations.update(ID, { archived: true });
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([url, init!.method]).toEqual([`/api/claude/conversations/${ID}`, "PATCH"]);
  });

  it("remove: DELETE, nessun corpo", async () => {
    const { c, fetchImpl } = client(undefined, 204);
    await c.claude.conversations.remove(ID);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([url, init!.method]).toEqual([`/api/claude/conversations/${ID}`, "DELETE"]);
  });
});
