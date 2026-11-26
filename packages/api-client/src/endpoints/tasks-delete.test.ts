import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

const T = "7f1c2a1e-0000-4000-8000-0000000000b1";

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

describe("tasks: elimina", () => {
  it("deletion: l'anteprima, con i default per figlie e ragioni assenti", async () => {
    const { c, fetchImpl } = client({
      taskId: T,
      code: "AUD-12",
      title: "Export",
      canDelete: false,
      whoAction: "deleteTasks",
      busy: [{ kind: "open_pr", repo: "web", number: 4 }],
    });
    const p = await c.tasks.deletion(T);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tasks/${T}/deletion`);
    expect(p).toMatchObject({ canDelete: false, whoAction: "deleteTasks", children: [] });
  });

  it("remove: DELETE sulla task", async () => {
    const { c, fetchImpl } = client(null, 204);
    await c.tasks.remove(T);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect([url, init!.method]).toEqual([`/api/tasks/${T}`, "DELETE"]);
  });
});
