import { describe, expect, it, vi } from "vitest";
import { createSlackClient, type FetchImpl } from "./api.js";

/** Costruisce un fetch fake che ritorna il JSON dato con status 200. */
function fakeFetch(json: unknown): FetchImpl {
  return vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })) as FetchImpl;
}

describe("createSlackClient.openView", () => {
  it("posta su views.open col Bearer token e ritorna ok", async () => {
    const fetchImpl = fakeFetch({ ok: true });
    const client = createSlackClient("xoxb-abc", fetchImpl);
    const ok = await client.openView("TRIG", { type: "modal" });
    expect(ok).toBe(true);

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/views.open");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer xoxb-abc" });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      trigger_id: "TRIG",
      view: { type: "modal" },
    });
  });

  it("ok=false → ritorna false (non lancia)", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: false, error: "invalid_trigger_id" }));
    expect(await client.openView("X", {})).toBe(false);
  });

  it("fetch che lancia → false (best-effort)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as FetchImpl;
    const client = createSlackClient("t", fetchImpl);
    expect(await client.openView("X", {})).toBe(false);
  });
});

describe("createSlackClient.getUserEmail", () => {
  it("ritorna l'email dal profilo", async () => {
    const client = createSlackClient(
      "t",
      fakeFetch({ ok: true, user: { profile: { email: "a@b.com" } } }),
    );
    expect(await client.getUserEmail("U1")).toBe("a@b.com");
  });

  it("ok ma senza email → null", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: true, user: { profile: {} } }));
    expect(await client.getUserEmail("U1")).toBeNull();
  });

  it("ok=false → null", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: false, error: "user_not_found" }));
    expect(await client.getUserEmail("U1")).toBeNull();
  });
});
