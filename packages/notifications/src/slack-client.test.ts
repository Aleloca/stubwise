import { describe, expect, it, vi } from "vitest";
import {
  createSlackClient,
  isFatalSlackError,
  SlackApiError,
  type FetchImpl,
} from "./slack-client.js";

/**
 * Test dei metodi di MESSAGGISTICA del client Slack (`chat.postMessage` /
 * `chat.update`), i due aggiunti per il DM d'inbox. Il resto della superficie
 * (`views.open`, `users.info`, `users.list`) è coperto dai test storici in
 * `apps/server/src/slack/api.test.ts`, che ora esercitano questo stesso modulo
 * attraverso il ri-export.
 *
 * Differenza di contratto rispetto ai metodi storici: quelli sono best-effort e
 * inghiottono gli errori, questi LANCIANO — è il poller delle consegne a dover
 * distinguere "ritenta" da "non ritentare mai", e per farlo gli serve il codice
 * d'errore di Slack.
 */

function fakeFetch(json: unknown): FetchImpl {
  return vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })) as FetchImpl;
}

/** Init della chiamata `index` al fetch mock. */
function callInit(fetchImpl: FetchImpl, index = 0): RequestInit {
  return (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[index]![1] as RequestInit;
}

/** URL della chiamata `index` al fetch mock. */
function callUrl(fetchImpl: FetchImpl, index = 0): string {
  return (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[index]![0] as string;
}

describe("createSlackClient.postMessage", () => {
  it("posta in JSON col bot token e ritorna ts e canale risolto", async () => {
    const fetchImpl = fakeFetch({ ok: true, ts: "1723.4567", channel: "D0123" });
    const client = createSlackClient("xoxb-abc", fetchImpl);

    const result = await client.postMessage({
      channel: "U0123",
      text: "Piano da approvare",
      blocks: [{ type: "section" }],
    });

    expect(result).toEqual({ ts: "1723.4567", channel: "D0123" });
    expect(callUrl(fetchImpl)).toBe("https://slack.com/api/chat.postMessage");
    const init = callInit(fetchImpl);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-abc");
    expect(headers["Content-Type"]).toContain("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      channel: "U0123",
      text: "Piano da approvare",
      blocks: [{ type: "section" }],
    });
  });

  it("senza blocchi manda solo il testo (niente chiave blocks nulla)", async () => {
    const fetchImpl = fakeFetch({ ok: true, ts: "1.2", channel: "D1" });
    const client = createSlackClient("t", fetchImpl);
    await client.postMessage({ channel: "U1", text: "ciao" });
    expect(JSON.parse(callInit(fetchImpl).body as string)).toEqual({
      channel: "U1",
      text: "ciao",
    });
  });

  it("ok:false → SlackApiError col codice di Slack", async () => {
    const client = createSlackClient(
      "xoxb-super-segreto",
      fakeFetch({ ok: false, error: "channel_not_found" }),
    );
    await expect(client.postMessage({ channel: "U1", text: "x" })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    await client.postMessage({ channel: "U1", text: "x" }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as SlackApiError).code).toBe("channel_not_found");
      expect((err as SlackApiError).message).toContain("chat.postMessage");
      // Il token non deve MAI finire nel messaggio d'errore (che viene persistito).
      expect((err as SlackApiError).message).not.toContain("xoxb-super-segreto");
    });
  });

  it("ok:true senza ts → errore (non si può salvare un external_ref vuoto)", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: true }));
    await expect(client.postMessage({ channel: "U1", text: "x" })).rejects.toThrow();
  });

  it("errore di rete → errore NON tipizzato (ritentabile), non SlackApiError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as FetchImpl;
    const client = createSlackClient("t", fetchImpl);
    const err = await client.postMessage({ channel: "U1", text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SlackApiError);
    expect((err as Error).message).toContain("ECONNRESET");
  });
});

describe("createSlackClient.updateMessage", () => {
  it("chiama chat.update con canale e ts", async () => {
    const fetchImpl = fakeFetch({ ok: true, ts: "1.2", channel: "D1" });
    const client = createSlackClient("xoxb-abc", fetchImpl);

    await client.updateMessage({
      channel: "D1",
      ts: "1.2",
      text: "aggiornato",
      blocks: [{ type: "section" }],
    });

    expect(callUrl(fetchImpl)).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(callInit(fetchImpl).body as string)).toEqual({
      channel: "D1",
      ts: "1.2",
      text: "aggiornato",
      blocks: [{ type: "section" }],
    });
  });

  it("ok:false → SlackApiError col codice", async () => {
    const client = createSlackClient("t", fakeFetch({ ok: false, error: "message_not_found" }));
    const err = await client
      .updateMessage({ channel: "D1", ts: "1.2", text: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe("message_not_found");
  });
});

describe("isFatalSlackError", () => {
  it("classifica come definitivi gli errori di configurazione/destinatario", () => {
    for (const code of [
      "invalid_auth",
      "account_inactive",
      "token_revoked",
      "missing_scope",
      "channel_not_found",
      "user_not_found",
      "message_not_found",
    ]) {
      expect(isFatalSlackError(new SlackApiError("chat.postMessage", code))).toBe(true);
    }
  });

  it("ratelimited, errori interni di Slack e errori di rete sono ritentabili", () => {
    for (const code of ["ratelimited", "internal_error", "service_unavailable", "unknown"]) {
      expect(isFatalSlackError(new SlackApiError("chat.postMessage", code))).toBe(false);
    }
    expect(isFatalSlackError(new Error("ECONNRESET"))).toBe(false);
  });
});
