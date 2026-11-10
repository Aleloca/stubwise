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
