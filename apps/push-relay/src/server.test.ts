import { describe, expect, it } from "vitest";
import { buildRelay } from "./server.js";
import type { RelayConfig } from "./config.js";
import type { PushClient, PushSendResult } from "./outcome.js";
import type { PushPayload } from "@stubwise/shared";

const IOS_TOKEN = "9a3f01bc77de4521aa08e6b4c1d90f3e2b5647c8a9012de3f4560789abcdef12";
const ANDROID_TOKEN =
  "fJ8kQ2mXSFy1nR0pZ4vTbA:APA91bH7xK-2NfQwE9rLm3sVuY6dGc0iPjO5tZaB8hXn4LqW1eRyU3oI";

const PAYLOAD: PushPayload = {
  title: "PR aperta",
  body: "Il fix di #42 è pronto per la review",
  category: "job.pr_opened",
  data: { notificationId: "n-1" },
  collapseId: "n-1",
};

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8090,
    iosPushVia: "fcm",
    apns: null,
    fcm: { projectId: "stubwise-push", serviceAccountJson: "{}" },
    rate: { perTokenHour: 60, perTokenDay: 500, perIpMinute: 600 },
    ...overrides,
  };
}

/** Client finto che registra i token ricevuti e risponde ciò che gli si dice. */
function fakeClient(result: PushSendResult = { status: "ok" }): PushClient & {
  sent: Array<{ token: string; payload: PushPayload }>;
} {
  const sent: Array<{ token: string; payload: PushPayload }> = [];
  return {
    sent,
    async send(token, payload) {
      sent.push({ token, payload });
      return result;
    },
  };
}

function build(overrides: Partial<RelayConfig> = {}) {
  const apns = fakeClient();
  const fcm = fakeClient();
  const logs: string[] = [];
  const app = buildRelay({
    config: config(overrides),
    apns,
    fcm,
    loggerStream: {
      write(line: string) {
        logs.push(line);
      },
    },
  });
  return { app, apns, fcm, logs };
}

function send(tokens: Array<{ platform: "ios" | "android"; token: string }>, payload = PAYLOAD) {
  return { method: "POST" as const, url: "/v1/send", payload: { tokens, payload } };
}

describe("buildRelay", () => {
  it("GET /healthz risponde 200", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  describe("validazione", () => {
    it.each([
      ["tokens vuoto", { tokens: [], payload: PAYLOAD }],
      ["senza payload", { tokens: [{ platform: "ios", token: IOS_TOKEN }] }],
      [
        "piattaforma ignota",
        { tokens: [{ platform: "windows", token: IOS_TOKEN }], payload: PAYLOAD },
      ],
      [
        "title vuoto",
        { tokens: [{ platform: "ios", token: IOS_TOKEN }], payload: { ...PAYLOAD, title: "" } },
      ],
      [
        "data non stringa",
        {
          tokens: [{ platform: "ios", token: IOS_TOKEN }],
          payload: { ...PAYLOAD, data: { a: 1 } },
        },
      ],
      [
        "oltre 20 token",
        {
          tokens: Array.from({ length: 21 }, (_, i) => ({ platform: "android", token: `t-${i}` })),
          payload: PAYLOAD,
        },
      ],
    ])("body non conforme (%s) → 400", async (_name, payload) => {
      const { app, fcm } = build();
      const res = await app.inject({ method: "POST", url: "/v1/send", payload });
      expect(res.statusCode).toBe(400);
      expect(fcm.sent).toHaveLength(0);
      await app.close();
    });

    /** Il tetto del corpo è la prima difesa: si rifiuta prima di parsare. */
    it("payload oltre 16 KB → 413", async () => {
      const { app } = build();
      const res = await app.inject(
        send(
          Array.from({ length: 20 }, () => ({
            platform: "android" as const,
            token: "z".repeat(1000),
          })),
        ),
      );
      expect(res.statusCode).toBe(413);
      await app.close();
    });
  });

  describe("instradamento", () => {
    /**
     * ⚠️ In v1 l'app usa Firebase Messaging ANCHE su iOS: il token registrato
     * con `platform: ios` è un token FCM. Instradarlo verso APNs lo farebbe
     * rifiutare come `BadDeviceToken`.
     */
    it("di default TUTTO passa da FCM, iOS compreso", async () => {
      const { app, apns, fcm } = build();
      const res = await app.inject(
        send([
          { platform: "ios", token: IOS_TOKEN },
          { platform: "android", token: ANDROID_TOKEN },
        ]),
      );
      expect(res.statusCode).toBe(200);
      expect(apns.sent).toHaveLength(0);
      expect(fcm.sent.map((s) => s.token)).toEqual([IOS_TOKEN, ANDROID_TOKEN]);
      await app.close();
    });

    it("con IOS_PUSH_VIA=apns c'è un send per client", async () => {
      const { app, apns, fcm } = build({
        iosPushVia: "apns",
        apns: {
          keyP8: "pem",
          keyId: "K",
          teamId: "T",
          bundleId: "B",
          sandbox: false,
        },
      });
      const res = await app.inject(
        send([
          { platform: "ios", token: IOS_TOKEN },
          { platform: "android", token: ANDROID_TOKEN },
        ]),
      );
      expect(res.statusCode).toBe(200);
      expect(apns.sent.map((s) => s.token)).toEqual([IOS_TOKEN]);
      expect(fcm.sent.map((s) => s.token)).toEqual([ANDROID_TOKEN]);
      expect(res.json().results).toHaveLength(2);
      await app.close();
    });

    it("gli esiti tornano nell'ORDINE dei token, non in quello delle risposte", async () => {
      const { app } = build();
      const res = await app.inject(
        send([
          { platform: "android", token: "tok-a" },
          { platform: "ios", token: "tok-b" },
          { platform: "android", token: "tok-c" },
        ]),
      );
      expect(res.json().results.map((r: { token: string }) => r.token)).toEqual([
        "tok-a",
        "tok-b",
        "tok-c",
      ]);
      await app.close();
    });

    /** Un client che esplode non deve buttare giù gli altri token della stessa richiesta. */
    it("se un client lancia, quel token è retry e gli altri passano", async () => {
      const boom: PushClient = {
        async send() {
          throw new Error("boom");
        },
      };
      const fcm = fakeClient();
      const app = buildRelay({
        config: config({
          iosPushVia: "apns",
          apns: { keyP8: "p", keyId: "K", teamId: "T", bundleId: "B", sandbox: false },
        }),
        apns: boom,
        fcm,
      });
      const res = await app.inject(
        send([
          { platform: "ios", token: IOS_TOKEN },
          { platform: "android", token: ANDROID_TOKEN },
        ]),
      );
      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results[0]).toMatchObject({ token: IOS_TOKEN, status: "retry" });
      expect(results[1]).toMatchObject({ token: ANDROID_TOKEN, status: "ok" });
      await app.close();
    });

    /**
     * Senza credenziali APNs il ramo iOS non esiste: va detto con un esito
     * permanente, non con un `ok` che perde la notifica in silenzio.
     */
    it("iOS via apns senza client configurato → failed, non ok", async () => {
      const fcm = fakeClient();
      const app = buildRelay({ config: config({ iosPushVia: "apns" }), apns: null, fcm });
      const res = await app.inject(send([{ platform: "ios", token: IOS_TOKEN }]));
      expect(res.json().results[0]).toMatchObject({ status: "failed" });
      await app.close();
    });
  });

  describe("rate limit per token", () => {
    /**
     * ⚠️ Il tetto è PER TOKEN e non fa fallire la richiesta: il client spezza
     * oltre 20 token e ritenta l'INTERA consegna quando un gruppo fallisce, il
     * che significa invii duplicati per i token già serviti. Un 429 sull'intera
     * richiesta bloccherebbe anche i token che non hanno superato nulla.
     */
    it("la 61ª nell'ora è retry/rate_limited per QUEL token, e la richiesta resta 200", async () => {
      const { app, fcm } = build();
      for (let i = 0; i < 60; i += 1) {
        const res = await app.inject(send([{ platform: "android", token: ANDROID_TOKEN }]));
        expect(res.json().results[0].status).toBe("ok");
      }
      const res = await app.inject(send([{ platform: "android", token: ANDROID_TOKEN }]));
      expect(res.statusCode).toBe(200);
      expect(res.json().results[0]).toEqual({
        token: ANDROID_TOKEN,
        status: "retry",
        reason: "rate_limited",
      });
      expect(fcm.sent).toHaveLength(60);
      await app.close();
    });

    it("un token esaurito non blocca gli altri della stessa richiesta", async () => {
      const { app, fcm } = build({ rate: { perTokenHour: 1, perTokenDay: 500, perIpMinute: 600 } });
      await app.inject(send([{ platform: "android", token: "tok-caldo" }]));
      const res = await app.inject(
        send([
          { platform: "android", token: "tok-caldo" },
          { platform: "android", token: "tok-fresco" },
        ]),
      );
      const results = res.json().results;
      expect(results[0]).toMatchObject({ status: "retry", reason: "rate_limited" });
      expect(results[1]).toMatchObject({ status: "ok" });
      expect(fcm.sent.map((s) => s.token)).toEqual(["tok-caldo", "tok-fresco"]);
      await app.close();
    });

    it("vale anche il tetto giornaliero", async () => {
      const { app } = build({ rate: { perTokenHour: 60, perTokenDay: 2, perIpMinute: 600 } });
      await app.inject(send([{ platform: "android", token: ANDROID_TOKEN }]));
      await app.inject(send([{ platform: "android", token: ANDROID_TOKEN }]));
      const res = await app.inject(send([{ platform: "android", token: ANDROID_TOKEN }]));
      expect(res.json().results[0].reason).toBe("rate_limited");
      await app.close();
    });
  });

  describe("rate limit per IP", () => {
    it("oltre il tetto la richiesta è 429", async () => {
      const { app } = build({ rate: { perTokenHour: 60, perTokenDay: 500, perIpMinute: 2 } });
      await app.inject(send([{ platform: "android", token: "a" }]));
      await app.inject(send([{ platform: "android", token: "b" }]));
      const res = await app.inject(send([{ platform: "android", token: "c" }]));
      expect(res.statusCode).toBe(429);
      await app.close();
    });

    it("/healthz non è soggetto al tetto per IP", async () => {
      const { app } = build({ rate: { perTokenHour: 60, perTokenDay: 500, perIpMinute: 1 } });
      await app.inject(send([{ platform: "android", token: "a" }]));
      for (let i = 0; i < 3; i += 1) {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
      }
      await app.close();
    });
  });

  /**
   * ⚠️ Il relay è il bersaglio di maggior valore del sistema e vede il
   * contenuto reale delle notifiche di ogni istanza. Nei log vanno CONTEGGI e
   * STATI, mai il payload e mai i token.
   */
  describe("i log non contengono né payload né token", () => {
    it("né in una richiesta riuscita né in una rifiutata", async () => {
      const { app, logs } = build();
      await app.inject(
        send([
          { platform: "ios", token: IOS_TOKEN },
          { platform: "android", token: ANDROID_TOKEN },
        ]),
      );
      await app.inject({ method: "POST", url: "/v1/send", payload: { tokens: [] } });
      await app.close();

      const dump = logs.join("\n");
      expect(dump).not.toContain(IOS_TOKEN);
      expect(dump).not.toContain(ANDROID_TOKEN);
      expect(dump).not.toContain(PAYLOAD.title);
      expect(dump).not.toContain(PAYLOAD.body);
    });
  });
});
