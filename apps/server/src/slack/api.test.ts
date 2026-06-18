import { describe, expect, it, vi } from "vitest";
import { createSlackClient, type FetchImpl } from "./api.js";

/** Costruisce un fetch fake che ritorna il JSON dato con status 200. */
function fakeFetch(json: unknown): FetchImpl {
  return vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })) as FetchImpl;
}

/**
 * Costruisce un fetch fake che ritorna in sequenza i JSON dati (una Response
 * per ogni chiamata), per testare la paginazione di `users.list`.
 */
function fakeFetchSeq(jsons: unknown[]): FetchImpl {
  let i = 0;
  return vi.fn(async () => {
    const json = jsons[Math.min(i, jsons.length - 1)];
    i += 1;
    return new Response(JSON.stringify(json), { status: 200 });
  }) as FetchImpl;
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

describe("createSlackClient.getUserProfile", () => {
  it("ritorna email, displayName e avatar (image_192) dal profilo completo", async () => {
    const client = createSlackClient(
      "t",
      fakeFetch({
        ok: true,
        user: {
          profile: {
            email: "a@b.com",
            display_name: "Ada",
            real_name: "Ada Lovelace",
            image_72: "https://img/72.png",
            image_192: "https://img/192.png",
            image_512: "https://img/512.png",
          },
        },
      }),
    );
    expect(await client.getUserProfile("U1")).toEqual({
      email: "a@b.com",
      displayName: "Ada",
      avatarUrl: "https://img/192.png",
    });
  });

  it("fallback a real_name quando display_name manca/è vuoto", async () => {
    const client = createSlackClient(
      "t",
      fakeFetch({
        ok: true,
        user: { profile: { display_name: "", real_name: "Ada Lovelace" } },
      }),
    );
    const p = await client.getUserProfile("U1");
    expect(p?.displayName).toBe("Ada Lovelace");
  });

  it("fallback avatar a image_512 poi image_72 quando 192 manca", async () => {
    const client512 = createSlackClient(
      "t",
      fakeFetch({ ok: true, user: { profile: { image_512: "https://img/512.png" } } }),
    );
    expect((await client512.getUserProfile("U1"))?.avatarUrl).toBe("https://img/512.png");

    const client72 = createSlackClient(
      "t",
      fakeFetch({ ok: true, user: { profile: { image_72: "https://img/72.png" } } }),
    );
    expect((await client72.getUserProfile("U1"))?.avatarUrl).toBe("https://img/72.png");
  });

  it("campi mancanti → null per ciascun campo", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: true, user: { profile: {} } }));
    expect(await client.getUserProfile("U1")).toEqual({
      email: null,
      displayName: null,
      avatarUrl: null,
    });
  });

  it("ok=false → null (best-effort, non lancia)", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: false, error: "user_not_found" }));
    expect(await client.getUserProfile("U1")).toBeNull();
  });
});

describe("createSlackClient.listWorkspaceUsers", () => {
  it("aggrega più pagine seguendo next_cursor", async () => {
    const fetchImpl = fakeFetchSeq([
      {
        ok: true,
        members: [
          { id: "U1", profile: { display_name: "Uno", email: "u1@x.com", image_192: "i1" } },
        ],
        response_metadata: { next_cursor: "CUR2" },
      },
      {
        ok: true,
        members: [
          { id: "U2", profile: { real_name: "Due", email: "u2@x.com", image_512: "i2" } },
        ],
        response_metadata: { next_cursor: "" },
      },
    ]);
    const client = createSlackClient("t", fetchImpl);
    const users = await client.listWorkspaceUsers();
    expect(users).toEqual([
      { id: "U1", displayName: "Uno", email: "u1@x.com", avatarUrl: "i1" },
      { id: "U2", displayName: "Due", email: "u2@x.com", avatarUrl: "i2" },
    ]);
    // Seconda chiamata deve passare il cursor.
    const secondInit = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(secondInit.body as string)).toMatchObject({ cursor: "CUR2" });
  });

  it("esclude bot, deleted e USLACKBOT", async () => {
    const client = createSlackClient(
      "t",
      fakeFetch({
        ok: true,
        members: [
          { id: "U1", profile: { display_name: "Vero" } },
          { id: "B1", is_bot: true, profile: { display_name: "Bot" } },
          { id: "D1", deleted: true, profile: { display_name: "Cancellato" } },
          { id: "USLACKBOT", profile: { display_name: "Slackbot" } },
        ],
        response_metadata: { next_cursor: "" },
      }),
    );
    const users = await client.listWorkspaceUsers();
    expect(users.map((u) => u.id)).toEqual(["U1"]);
  });

  it("rispetta il tetto di pagine (non itera all'infinito su cursor non vuoto)", async () => {
    // Ogni pagina ritorna sempre un next_cursor non vuoto: senza tetto andrebbe in loop.
    const fetchImpl = fakeFetch({
      ok: true,
      members: [{ id: "U1", profile: {} }],
      response_metadata: { next_cursor: "ALWAYS" },
    });
    const client = createSlackClient("t", fetchImpl);
    const users = await client.listWorkspaceUsers();
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeLessThanOrEqual(5);
    expect(users.length).toBeGreaterThan(0);
  });

  it("ok=false sulla prima pagina → lancia", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: false, error: "invalid_auth" }));
    await expect(client.listWorkspaceUsers()).rejects.toThrow();
  });

  it("ok=false su pagina successiva → ritorna quanto raccolto finora", async () => {
    const fetchImpl = fakeFetchSeq([
      {
        ok: true,
        members: [{ id: "U1", profile: { display_name: "Uno" } }],
        response_metadata: { next_cursor: "CUR2" },
      },
      { ok: false, error: "ratelimited" },
    ]);
    const client = createSlackClient("t", fetchImpl);
    const users = await client.listWorkspaceUsers();
    expect(users.map((u) => u.id)).toEqual(["U1"]);
  });
});
