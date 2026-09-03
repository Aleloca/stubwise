import {
  PUSH_RELAY_MAX_TOKENS,
  pushRelaySendRequestSchema,
  type PushPayload,
  type PushRelayToken,
} from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import {
  createPushRelayClient,
  PushRelayRejected,
  PushRelayUnavailable,
} from "./relay-client.js";

const URL_BASE = "https://push.stubwise.test";
const TOKEN = "fD8kQ2n1TZyR:APA91bE-esempio-di-token-fcm";

const PAYLOAD: PushPayload = {
  title: "Una domanda ti aspetta",
  body: "L'AI ha bisogno di una decisione su #131.",
  category: "job.awaiting_input",
  data: {
    notificationId: "11111111-1111-4111-8111-111111111111",
    kind: "job.awaiting_input",
    deepLink: "stubwise://inbox/11111111-1111-4111-8111-111111111111",
  },
  badge: 3,
  collapseId: "11111111-1111-4111-8111-111111111111",
};

const TOKENS: PushRelayToken[] = [{ platform: "ios", token: TOKEN }];

/** Chiamate osservate dal fetch finto: nessuna rete in questi test. */
interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okBody = (tokens: PushRelayToken[]) => ({
  results: tokens.map(({ token }) => ({ token, status: "ok" as const })),
});

describe("createPushRelayClient — la richiesta", () => {
  it("POSTa su <url>/v1/send un body conforme al contratto", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(okBody(TOKENS)));
    const client = createPushRelayClient({ url: URL_BASE, fetch: impl });

    await client.send(TOKENS, PAYLOAD);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${URL_BASE}/v1/send`);
    expect(call!.init.method).toBe("POST");
    expect(new Headers(call!.init.headers).get("content-type")).toBe("application/json");
    const body: unknown = JSON.parse(String(call!.init.body));
    expect(body).toEqual({ tokens: TOKENS, payload: PAYLOAD });
    expect(pushRelaySendRequestSchema.safeParse(body).success).toBe(true);
  });

  it("normalizza lo slash finale dell'URL", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(okBody(TOKENS)));
    await createPushRelayClient({ url: `${URL_BASE}//`, fetch: impl }).send(TOKENS, PAYLOAD);
    expect(calls[0]!.url).toBe(`${URL_BASE}/v1/send`);
  });

  it("restituisce la risposta del relay, parsata con lo schema", async () => {
    const two: PushRelayToken[] = [
      { platform: "ios", token: TOKEN },
      { platform: "android", token: `${TOKEN}-2` },
    ];
    const { impl } = fakeFetch(() =>
      jsonResponse({
        results: [
          { token: TOKEN, status: "ok" },
          { token: `${TOKEN}-2`, status: "invalid_token", reason: "Unregistered" },
        ],
      }),
    );
    const res = await createPushRelayClient({ url: URL_BASE, fetch: impl }).send(two, PAYLOAD);
    expect(res.results).toEqual([
      { token: TOKEN, status: "ok" },
      { token: `${TOKEN}-2`, status: "invalid_token", reason: "Unregistered" },
    ]);
  });
});

describe("createPushRelayClient — più di PUSH_RELAY_MAX_TOKENS device", () => {
  const many = (n: number): PushRelayToken[] =>
    Array.from({ length: n }, (_, i) => ({ platform: "ios" as const, token: `${TOKEN}-${i}` }));

  it("spezza in più chiamate e concatena gli esiti NELL'ORDINE dei token", async () => {
    // Un utente non ha 25 telefoni, ma accumula token stantii: restano attivi
    // finché una push non torna `invalid_token`. Se oltre il tetto la chiamata
    // fallisse, quella potatura non arriverebbe MAI e l'utente resterebbe senza
    // push per sempre — un guasto che si chiude da solo dentro.
    const tokens = many(PUSH_RELAY_MAX_TOKENS + 5);
    const { impl, calls } = fakeFetch(async (call) => {
      const body = JSON.parse(String(call.init.body)) as { tokens: PushRelayToken[] };
      return jsonResponse(okBody(body.tokens));
    });

    const res = await createPushRelayClient({ url: URL_BASE, fetch: impl }).send(tokens, PAYLOAD);

    expect(calls).toHaveLength(2);
    expect(res.results.map((r) => r.token)).toEqual(tokens.map((t) => t.token));
  });

  it("esattamente al tetto resta UNA chiamata sola", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(okBody(many(PUSH_RELAY_MAX_TOKENS))));
    await createPushRelayClient({ url: URL_BASE, fetch: impl }).send(
      many(PUSH_RELAY_MAX_TOKENS),
      PAYLOAD,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("createPushRelayClient — errori", () => {
  async function sendWith(response: () => Response | Promise<Response>) {
    const { impl } = fakeFetch(response);
    return createPushRelayClient({ url: URL_BASE, fetch: impl }).send(TOKENS, PAYLOAD);
  }

  it.each([500, 502, 503, 504])("%i del relay → PushRelayUnavailable (si ritenta)", async (status) => {
    await expect(sendWith(() => jsonResponse({ error: "boom" }, status))).rejects.toBeInstanceOf(
      PushRelayUnavailable,
    );
  });

  it.each([408, 429])("%i è transitorio, non un bug di contratto → PushRelayUnavailable", async (status) => {
    // 429 = il rate limit per token del relay; 408 = timeout lato relay.
    // Trattarli come 4xx qualsiasi butterebbe via una notifica che sarebbe
    // bastato rimandare di trenta secondi.
    await expect(sendWith(() => jsonResponse({ error: "slow down" }, status))).rejects.toBeInstanceOf(
      PushRelayUnavailable,
    );
  });

  it.each([400, 401, 403, 404, 413, 422])("%i → PushRelayRejected (delivery failed)", async (status) => {
    await expect(sendWith(() => jsonResponse({ error: "nope" }, status))).rejects.toBeInstanceOf(
      PushRelayRejected,
    );
  });

  it("un errore di rete → PushRelayUnavailable", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createPushRelayClient({ url: URL_BASE, fetch: impl }).send(TOKENS, PAYLOAD),
    ).rejects.toBeInstanceOf(PushRelayUnavailable);
  });

  it("il timeout aborta davvero la richiesta → PushRelayUnavailable", async () => {
    let seen: AbortSignal | undefined;
    const impl = ((_input: unknown, init: RequestInit = {}) => {
      seen = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    await expect(
      createPushRelayClient({ url: URL_BASE, fetch: impl, timeoutMs: 10 }).send(TOKENS, PAYLOAD),
    ).rejects.toBeInstanceOf(PushRelayUnavailable);
    expect(seen?.aborted).toBe(true);
  });

  it("il timeout copre anche la LETTURA del corpo, non solo l'handshake", async () => {
    // Un relay che manda gli header e poi si pianta sul corpo: se il timer
    // venisse spento appena `fetch` risolve, `res.json()` resterebbe appeso
    // SENZA TETTO. Non è la push a rimetterci: il poller processa le consegne
    // in sequenza con una guardia anti-rientro, quindi resterebbero ferme
    // anche tutte le altre — DM Slack e webhook compresi — fino al riavvio.
    // Il fake riproduce ciò che fa undici: l'abort del segnale fa fallire lo
    // stream del corpo.
    const impl = ((_input: unknown, init: RequestInit = {}) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    await expect(
      createPushRelayClient({ url: URL_BASE, fetch: impl, timeoutMs: 10 }).send(TOKENS, PAYLOAD),
    ).rejects.toBeInstanceOf(PushRelayUnavailable);
  });

  it("una 200 MALFORMATA → PushRelayRejected (non la si può interpretare)", async () => {
    await expect(sendWith(() => jsonResponse({ results: [{ token: 1, status: "ok" }] }))).rejects.toBeInstanceOf(
      PushRelayRejected,
    );
    await expect(sendWith(() => jsonResponse({ results: [{ token: TOKEN, status: "boh" }] }))).rejects.toBeInstanceOf(
      PushRelayRejected,
    );
    await expect(sendWith(() => jsonResponse("non sono json", 200))).rejects.toBeInstanceOf(
      PushRelayRejected,
    );
  });

  it("un payload fuori contratto non parte nemmeno: è un bug nostro", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(okBody(TOKENS)));
    const client = createPushRelayClient({ url: URL_BASE, fetch: impl });
    await expect(client.send([], PAYLOAD)).rejects.toBeInstanceOf(PushRelayRejected);
    await expect(
      client.send(TOKENS, { ...PAYLOAD, title: "t".repeat(5000) }),
    ).rejects.toBeInstanceOf(PushRelayRejected);
    expect(calls).toHaveLength(0);
  });

  it("NESSUN messaggio d'errore contiene un token", async () => {
    // I token push non vanno nei log: da lì chi li legge se li può intestare
    // (vedi il docblock di `deviceDeletionSchema`). Un messaggio d'eccezione
    // finisce nel log del poller, quindi vale la stessa regola.
    const cases: (() => Promise<unknown>)[] = [
      () => sendWith(() => jsonResponse({ error: TOKEN }, 400)),
      () => sendWith(() => jsonResponse({ error: TOKEN }, 503)),
      () => sendWith(() => jsonResponse({ results: [{ token: TOKEN, status: "boh" }] })),
      () => createPushRelayClient({ url: URL_BASE, fetch: fakeFetch(() => jsonResponse({}, 200)).impl }).send([], PAYLOAD),
    ];
    for (const run of cases) {
      const error = await run().then(
        () => null,
        (err: unknown) => err as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(`${error!.name}: ${error!.message}`).not.toContain(TOKEN);
    }
  });
});
