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
  it("list: solo le proprie, archiviate a richiesta", async () => {
    const { c, fetchImpl } = client({ items: [conversation] });
    await c.claude.conversations.list();
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations?scope=mine");
    await c.claude.conversations.list({ archived: true });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/claude/conversations?scope=mine&archived=true");
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
