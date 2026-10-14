import { describe, expect, it, vi } from "vitest";
import { ApiError, createStubwiseClient, isAgentSessionsUnavailable } from "../index.js";

const ITEM = "7f1c2a1e-0000-4000-8000-000000000001";
const SESSION = "7f1c2a1e-0000-4000-8000-000000000002";

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("endpoints backlogRefine", () => {
  it("start: POST col messaggio, risposta parsata", async () => {
    const { c, fetchImpl } = client({ agentSessionId: SESSION, inputId: null });
    expect(await c.backlogRefine.start(ITEM, { message: "ciao" })).toEqual({ agentSessionId: SESSION, inputId: null });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect([String(url), init!.method, JSON.parse(String(init!.body))]).toEqual([
      `/api/backlog/${ITEM}/refine-session`,
      "POST",
      { message: "ciao" },
    ]);
  });

  it("start senza messaggio: manda comunque un corpo JSON `{}` (la rotta valida il body)", async () => {
    const { c, fetchImpl } = client({ agentSessionId: SESSION, inputId: null });
    await c.backlogRefine.start(ITEM);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toEqual({});
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("close: DELETE, 204", async () => {
    const { c, fetchImpl } = client(null, 204);
    await expect(c.backlogRefine.close(ITEM)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect([String(url), init!.method]).toEqual([`/api/backlog/${ITEM}/refine-session`, "DELETE"]);
  });

  it("server senza la funzione: 404 senza code → isAgentSessionsUnavailable", async () => {
    const { c } = client({ message: "Route POST:/api/backlog/x/refine-session not found", statusCode: 404 }, 404);
    const error = await c.backlogRefine.start(ITEM, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isAgentSessionsUnavailable(error)).toBe(true);
  });

  it("409 item_closed: ApiError col code, NON «funzione assente»", async () => {
    const { c } = client({ code: "item_closed", message: "closed" }, 409);
    const error = await c.backlogRefine.start(ITEM, {}).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("item_closed");
    expect(isAgentSessionsUnavailable(error)).toBe(false);
  });
});
