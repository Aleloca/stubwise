import { describe, expect, it } from "vitest";
import { deviceRegistrationSchema } from "./notification.js";
import {
  PUSH_BODY_MAX_CHARS,
  PUSH_COLLAPSE_ID_MAX_CHARS,
  PUSH_RELAY_MAX_TOKENS,
  PUSH_TITLE_MAX_CHARS,
  pushRelaySendRequestSchema,
  pushRelaySendResponseSchema,
} from "./push.js";

const TOKEN = "fD8kQ2n1TZyR:APA91bE-esempio-di-token-fcm";

/** Payload minimo valido: è la forma che `buildPushPayload` produce. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Una domanda ti aspetta",
    body: "L'AI ha bisogno di una decisione su #131.",
    category: "job.awaiting_input",
    data: {
      notificationId: "11111111-1111-4111-8111-111111111111",
      kind: "job.awaiting_input",
      deepLink: "stubwise://inbox/11111111-1111-4111-8111-111111111111",
    },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    tokens: [{ platform: "ios", token: TOKEN }],
    payload: payload(),
    ...overrides,
  };
}

describe("pushRelaySendRequestSchema", () => {
  it("accetta la forma minima e quella completa", () => {
    expect(pushRelaySendRequestSchema.parse(request())).toEqual(request());
    const full = request({
      tokens: [
        { platform: "ios", token: TOKEN },
        { platform: "android", token: `${TOKEN}-2` },
      ],
      payload: payload({
        badge: 7,
        threadId: "22222222-2222-4222-8222-222222222222",
        collapseId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    expect(pushRelaySendRequestSchema.parse(full)).toEqual(full);
  });

  it("rifiuta zero token e più di PUSH_RELAY_MAX_TOKENS", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ platform: "ios" as const, token: `${TOKEN}-${i}` }));
    expect(() => pushRelaySendRequestSchema.parse(request({ tokens: [] }))).toThrow();
    expect(pushRelaySendRequestSchema.parse(request({ tokens: many(PUSH_RELAY_MAX_TOKENS) })).tokens)
      .toHaveLength(PUSH_RELAY_MAX_TOKENS);
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ tokens: many(PUSH_RELAY_MAX_TOKENS + 1) })),
    ).toThrow();
  });

  it("rifiuta una piattaforma che non conosciamo", () => {
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ tokens: [{ platform: "web", token: TOKEN }] })),
    ).toThrow();
  });

  it("`data` è una mappa di sole STRINGHE: è il vincolo di FCM, non uno stile", () => {
    // `Message.data` di FCM v1 è `map<string,string>`: numeri, booleani e
    // oggetti vanno serializzati dal mittente. Ammetterli qui produrrebbe un
    // 400 dal relay a valle, non un errore qui.
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ payload: payload({ data: { badge: 3 } }) })),
    ).toThrow();
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ payload: payload({ data: { x: { y: "z" } } }) })),
    ).toThrow();
  });

  it("il badge è un intero non negativo", () => {
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ payload: payload({ badge: -1 }) })),
    ).toThrow();
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ payload: payload({ badge: 1.5 }) })),
    ).toThrow();
    expect(pushRelaySendRequestSchema.parse(request({ payload: payload({ badge: 0 }) }))).toBeTruthy();
  });

  it("title e body hanno un tetto: oltre 4096 byte APNs risponde PayloadTooLarge", () => {
    expect(() =>
      pushRelaySendRequestSchema.parse(request({ payload: payload({ title: "" }) })),
    ).toThrow();
    expect(() =>
      pushRelaySendRequestSchema.parse(
        request({ payload: payload({ title: "t".repeat(PUSH_TITLE_MAX_CHARS + 1) }) }),
      ),
    ).toThrow();
    expect(() =>
      pushRelaySendRequestSchema.parse(
        request({ payload: payload({ body: "b".repeat(PUSH_BODY_MAX_CHARS + 1) }) }),
      ),
    ).toThrow();
    // Il tetto è sui CARATTERI e il margine sui byte è largo: 100 + 500 unità
    // UTF-16 al caso peggiore (BMP a 3 byte) sono 1800 byte, contro i 4096 di
    // APNs/FCM. È il contrario del token push, dove il margine era sottile e il
    // limite ha dovuto essere in byte.
    const heavy = request({
      payload: payload({
        title: "戦".repeat(PUSH_TITLE_MAX_CHARS),
        body: "戦".repeat(PUSH_BODY_MAX_CHARS),
      }),
    });
    expect(pushRelaySendRequestSchema.parse(heavy)).toBeTruthy();
    expect(new TextEncoder().encode(JSON.stringify(heavy)).length).toBeLessThan(4096);
  });

  it("il collapseId sta nei 64 byte dell'header `apns-collapse-id`", () => {
    expect(() =>
      pushRelaySendRequestSchema.parse(
        request({ payload: payload({ collapseId: "c".repeat(PUSH_COLLAPSE_ID_MAX_CHARS + 1) }) }),
      ),
    ).toThrow();
  });

  it("un campo IGNOTO viene tolto invece di far fallire: il relay può crescere", () => {
    // Contratto fra due sistemi che si deployano da soli. Un'istanza più nuova
    // che manda un campo che questo relay non conosce non deve prendere un 400:
    // il campo viene ignorato e la push parte lo stesso.
    const parsed = pushRelaySendRequestSchema.parse(
      request({ payload: payload({ sound: "chime" }), priority: "high" }),
    );
    expect(parsed).not.toHaveProperty("priority");
    expect(parsed.payload).not.toHaveProperty("sound");
  });
});

describe("allineamento col token registrato", () => {
  /**
   * L'INVARIANTE: un token che passa la registrazione DEVE essere spedibile.
   *
   * Se i due tetti divergessero esisterebbe un device registrato che il relay
   * rifiuta con un 400 — cioè una delivery `failed` per sempre, su un telefono
   * che si è registrato senza errori.
   */
  const samples = [
    { name: "token FCM tipico", value: TOKEN },
    { name: "token APNs esadecimale", value: "a3f".repeat(21) + "b" },
    { name: "esattamente al tetto in byte (ASCII)", value: "x".repeat(1024) },
    { name: "esattamente al tetto in byte (3 byte per carattere)", value: "戦".repeat(341) },
    { name: "un byte oltre il tetto", value: "x".repeat(1025) },
    { name: "vuoto", value: "" },
  ];

  it.each(samples)("registrabile ⇔ spedibile: $name", ({ value }) => {
    const registrable = deviceRegistrationSchema.safeParse({
      platform: "ios",
      token: value,
    }).success;
    const sendable = pushRelaySendRequestSchema.safeParse(
      request({ tokens: [{ platform: "ios", token: value }] }),
    ).success;
    expect(sendable).toBe(registrable);
  });
});

describe("pushRelaySendResponseSchema", () => {
  it("accetta un esito per token, con e senza `reason`", () => {
    const body = {
      results: [
        { token: TOKEN, status: "ok" },
        { token: `${TOKEN}-2`, status: "invalid_token", reason: "Unregistered" },
        { token: `${TOKEN}-3`, status: "retry", reason: "503 from APNs" },
      ],
    };
    expect(pushRelaySendResponseSchema.parse(body)).toEqual(body);
  });

  it("uno stato che non conosciamo è un errore: qui NON si aprono gli enum", () => {
    // Il lettore aperto (`readerSchema`) serve al MOBILE, che si aggiorna dagli
    // store. Il relay lo deployiamo noi: uno stato ignoto qui è un bug di
    // contratto, e il poller deve accorgersene invece di trattarlo come "ok".
    expect(() =>
      pushRelaySendResponseSchema.parse({ results: [{ token: TOKEN, status: "boh" }] }),
    ).toThrow();
  });

  it("una lista vuota è lecita, un `results` mancante no", () => {
    expect(pushRelaySendResponseSchema.parse({ results: [] })).toEqual({ results: [] });
    expect(() => pushRelaySendResponseSchema.parse({})).toThrow();
  });

  it("un campo IGNOTO nella risposta viene tolto invece di far fallire", () => {
    // Speculare al lato richiesta: un relay più nuovo che aggiunge un campo non
    // deve rompere le istanze già installate.
    const parsed = pushRelaySendResponseSchema.parse({
      results: [{ token: TOKEN, status: "ok", latencyMs: 12 }],
      totalMs: 30,
    });
    expect(parsed).toEqual({ results: [{ token: TOKEN, status: "ok" }] });
  });
});
