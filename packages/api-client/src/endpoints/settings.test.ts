import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Area 9, F3, Task 8: i webhook in uscita e i modelli nel client — url, verbo,
 * corpo — e il parse SENZA i facoltativi (un server più vecchio, un rollback).
 */
const W1 = "50000000-0000-4000-8000-000000000001";

function clientWith(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof clientWith>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url: String(url), method: String(init!.method), body: init!.body ? JSON.parse(String(init!.body)) : undefined };
};
const view = { id: W1, name: "W", url: "https://h.example.com", format: "generic", enabled: true, events: ["job.failed"], secretSet: true, createdAt: "2026-11-18T10:00:00.000Z" };

describe("webhooks nel client", () => {
  it("list: senza secretRotatedAt, e un evento ignoto è __unknown__", async () => {
    const { client, fetchImpl } = clientWith([{ ...view, events: ["job.failed", "evento.futuro"] }]);
    const [row] = await client.webhooks.list();
    expect(last(fetchImpl)).toMatchObject({ method: "GET", url: "/api/settings/webhooks" });
    expect(row).toMatchObject({ secretRotatedAt: null, events: ["job.failed", "__unknown__"] });
  });

  it("create, rotateSecret: il segreto una volta; update, remove, test, preview: verbi e path", async () => {
    const created = clientWith({ ...view, secret: "s3cr3t" }, 201);
    expect(await created.client.webhooks.create({ name: "W", url: "https://h.example.com", format: "generic" })).toMatchObject({ secret: "s3cr3t" });
    expect(last(created.fetchImpl)).toEqual({ method: "POST", url: "/api/settings/webhooks", body: { name: "W", url: "https://h.example.com", format: "generic" } });
    await created.client.webhooks.rotateSecret("a/b");
    expect(last(created.fetchImpl)).toMatchObject({ method: "POST", url: "/api/settings/webhooks/a%2Fb/secret" });

    const patched = clientWith(view);
    await patched.client.webhooks.update(W1, { name: "Nuovo" });
    expect(last(patched.fetchImpl)).toEqual({ method: "PATCH", url: `/api/settings/webhooks/${W1}`, body: { name: "Nuovo" } });

    const gone = clientWith(null, 204);
    await gone.client.webhooks.remove(W1);
    expect(last(gone.fetchImpl)).toMatchObject({ method: "DELETE", url: `/api/settings/webhooks/${W1}` });

    const tested = clientWith({ ok: false });
    expect(await tested.client.webhooks.test(W1)).toEqual({ ok: false, status: null, error: null });
    expect(last(tested.fetchImpl)).toMatchObject({ method: "POST", url: `/api/settings/webhooks/${W1}/test` });

    const preview = clientWith({ format: "slack", event: "job.failed", body: { text: "x" } });
    await preview.client.webhooks.preview("slack", "job.failed");
    expect(last(preview.fetchImpl).url).toBe("/api/settings/webhooks/preview?format=slack&event=job.failed");
  });
});

describe("settings.models nel client", () => {
  it("senza `source` (un server di prima) vale default; setModels manda la patch", async () => {
    const { client, fetchImpl } = clientWith({ operations: [{ operation: "fix_plan", configurable: true, model: null, workerDefault: "opus" }], choices: ["opus"] });
    const res = await client.settings.models();
    expect(res.operations[0]).toMatchObject({ source: "default", fallbackSource: "default" });
    await client.settings.setModels({ fix_plan: "opus", pr_review: null });
    expect(last(fetchImpl)).toEqual({ method: "PATCH", url: "/api/settings/models", body: { models: { fix_plan: "opus", pr_review: null } } });
  });
});
