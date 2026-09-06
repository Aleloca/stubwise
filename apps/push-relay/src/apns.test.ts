import { beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createApnsClient, type Http2ConnectLike, type Http2SessionLike } from "./apns.js";
import type { PushPayload } from "@stubwise/shared";

/**
 * Un token realistico: 64 caratteri esadecimali, come quelli veri di APNs.
 *
 * ⚠️ Comincia di proposito con una LETTERA. Un token esadecimale che comincia
 * per lettera ha esattamente la forma di un identificatore d'errore, quindi è
 * il caso peggiore per il filtro di `reasonCode`: sceglierne uno che comincia
 * per cifra farebbe passare i test anche con un filtro che si affida alla sola
 * forma, e non proverebbe nulla.
 */
const TOKEN = "a3f01bc77de4521aa08e6b4c1d90f3e2b5647c8a9012de3f4560789abcdef129";

const PAYLOAD: PushPayload = {
  title: "PR aperta",
  body: "Il fix di #42 è pronto per la review",
  category: "job.pr_opened",
  data: { notificationId: "n-1", url: "/inbox/n-1" },
  badge: 3,
  threadId: "proj-7",
  collapseId: "n-1",
};

interface RecordedRequest {
  authority: string;
  headers: Record<string, string | number>;
  body: string;
}

/**
 * Una risposta programmata, o uno dei due modi in cui un giro di rete può NON
 * arrivare: `hang` tiene lo stream aperto per sempre (il degrado che il timeout
 * esiste per troncare), `error` lo fa fallire a metà.
 */
type ProgrammedResponse = { status: number; body?: string } | { kind: "hang" } | { kind: "error" };

/**
 * Sessione HTTP/2 finta: registra ciò che il client manda e risponde con la
 * prossima risposta programmata. Emette in modo asincrono perché è così che si
 * comporta quella vera — un fake sincrono non eserciterebbe l'attesa.
 */
function fakeHttp2(responses: ProgrammedResponse[]): {
  connect: Http2ConnectLike;
  requests: RecordedRequest[];
  streams: Array<{ closed: boolean }>;
  sessions: number;
} {
  const requests: RecordedRequest[] = [];
  const streams: Array<{ closed: boolean }> = [];
  const state = { sessions: 0 };
  const queue = [...responses];
  const connect: Http2ConnectLike = (authority) => {
    state.sessions += 1;
    const session: Http2SessionLike = Object.assign(new EventEmitter(), {
      destroyed: false,
      close() {
        (session as { destroyed: boolean }).destroyed = true;
      },
      request(headers: Record<string, string | number>) {
        const stream = Object.assign(new EventEmitter(), {
          closed: false,
          setEncoding() {},
          close() {
            stream.closed = true;
          },
          end(body?: string) {
            requests.push({ authority, headers, body: body ?? "" });
            const next: ProgrammedResponse = queue.shift() ?? { status: 200 };
            // `hang`: nessuna emissione, mai. Lo stream resta aperto finché non
            // è il client a troncarlo.
            if ("kind" in next && next.kind === "hang") return;
            setImmediate(() => {
              if ("kind" in next && next.kind === "error") {
                stream.emit("error", new Error(`h2 reset sending ${TOKEN}`));
                return;
              }
              const response = next as { status: number; body?: string };
              stream.emit("response", { ":status": response.status });
              if (response.body !== undefined) stream.emit("data", response.body);
              stream.emit("end");
            });
          },
        });
        streams.push(stream);
        return stream;
      },
    });
    return session;
  };
  return {
    connect,
    requests,
    streams,
    get sessions() {
      return state.sessions;
    },
  };
}

let privateKeyPem: string;
let publicKey: KeyObject;

beforeEach(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  publicKey = pair.publicKey;
});

function build(options: {
  responses?: ProgrammedResponse[];
  sandbox?: boolean;
  now?: () => number;
  timeoutMs?: number;
}) {
  const http2 = fakeHttp2(options.responses ?? [{ status: 200 }]);
  const client = createApnsClient({
    keyP8: privateKeyPem,
    keyId: "ABC1234567",
    teamId: "TEAM123456",
    bundleId: "com.app.aleloca.stubwise",
    sandbox: options.sandbox ?? false,
    http2Connect: http2.connect,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });
  return { client, http2 };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createApnsClient", () => {
  describe("la richiesta", () => {
    it("manda gli header e il payload che APNs si aspetta", async () => {
      const { client, http2 } = build({});
      await client.send(TOKEN, PAYLOAD);

      const [request] = http2.requests;
      expect(request).toBeDefined();
      expect(request!.authority).toBe("https://api.push.apple.com");
      expect(request!.headers[":method"]).toBe("POST");
      expect(request!.headers[":path"]).toBe(`/3/device/${TOKEN}`);
      expect(request!.headers["apns-topic"]).toBe("com.app.aleloca.stubwise");
      expect(request!.headers["apns-push-type"]).toBe("alert");
      expect(request!.headers["apns-priority"]).toBe(10);
      expect(request!.headers["apns-collapse-id"]).toBe("n-1");

      expect(JSON.parse(request!.body)).toEqual({
        aps: {
          alert: { title: "PR aperta", body: "Il fix di #42 è pronto per la review" },
          badge: 3,
          category: "job.pr_opened",
          "thread-id": "proj-7",
          sound: "default",
        },
        notificationId: "n-1",
        url: "/inbox/n-1",
      });
    });

    it("senza collapseId/threadId/badge non manda quegli header né quelle chiavi", async () => {
      const { client, http2 } = build({});
      await client.send(TOKEN, {
        title: "T",
        body: "B",
        category: "ticket.created",
        data: {},
      });
      const [request] = http2.requests;
      expect(request!.headers).not.toHaveProperty("apns-collapse-id");
      const parsed = JSON.parse(request!.body) as { aps: Record<string, unknown> };
      expect(parsed.aps).not.toHaveProperty("thread-id");
      expect(parsed.aps).not.toHaveProperty("badge");
    });

    it("il sandbox cambia host, ed è l'unica differenza", async () => {
      const { client, http2 } = build({ sandbox: true });
      await client.send(TOKEN, PAYLOAD);
      expect(http2.requests[0]!.authority).toBe("https://api.sandbox.push.apple.com");
    });
  });

  describe("il provider token (JWT ES256)", () => {
    it("porta kid nell'header e iss/iat nel payload", async () => {
      const { client, http2 } = build({});
      await client.send(TOKEN, PAYLOAD);

      const authorization = String(http2.requests[0]!.headers["authorization"]);
      expect(authorization.startsWith("bearer ")).toBe(true);
      const [header, claims] = authorization.slice("bearer ".length).split(".");
      expect(decodeJwtPart(header!)).toEqual({ alg: "ES256", kid: "ABC1234567" });
      const payload = decodeJwtPart(claims!);
      expect(payload["iss"]).toBe("TEAM123456");
      expect(typeof payload["iat"]).toBe("number");
    });

    /**
     * ⚠️ ES256 vuole la firma GREZZA r||s (64 byte, IEEE P-1363). Node di
     * default firma le curve ellittiche in DER, che è più lungo e a lunghezza
     * variabile: un JWT firmato così è sintatticamente perfetto e APNs lo
     * rifiuta con `InvalidProviderToken`. Siccome in v1 il client APNs è
     * inattivo, l'errore non lo scoprirebbe nessuno fino alla fase 4b.
     */
    it("la firma è raw P-1363 da 64 byte e verifica con la chiave pubblica", async () => {
      const { client, http2 } = build({});
      await client.send(TOKEN, PAYLOAD);

      const jwt = String(http2.requests[0]!.headers["authorization"]).slice("bearer ".length);
      const [header, claims, signature] = jwt.split(".");
      const raw = Buffer.from(signature!, "base64url");
      expect(raw.length).toBe(64);

      const verifier = createVerify("SHA256");
      verifier.update(`${header}.${claims}`);
      expect(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
    });

    it("è riusato entro i 50 minuti e rigenerato dopo", async () => {
      let now = 1_000_000_000_000;
      const { client, http2 } = build({
        responses: [{ status: 200 }, { status: 200 }, { status: 200 }],
        now: () => now,
      });

      await client.send(TOKEN, PAYLOAD);
      now += 49 * 60_000;
      await client.send(TOKEN, PAYLOAD);
      now += 2 * 60_000;
      await client.send(TOKEN, PAYLOAD);

      const jwts = http2.requests.map((r) => String(r.headers["authorization"]));
      expect(jwts[0]).toBe(jwts[1]);
      expect(jwts[2]).not.toBe(jwts[0]);
    });
  });

  describe("la mappatura errore → esito", () => {
    async function sendWith(status: number, body?: string) {
      const { client } = build({ responses: [{ status, body }] });
      return client.send(TOKEN, PAYLOAD);
    }

    it("200 → ok", async () => {
      expect(await sendWith(200)).toEqual({ status: "ok" });
    });

    /**
     * L'UNICO esito che spegne un telefono, e l'unico codice che lo merita:
     * `Unregistered` dice che quella registrazione non esiste più.
     */
    it("410 Unregistered → invalid_token", async () => {
      const result = await sendWith(410, JSON.stringify({ reason: "Unregistered" }));
      expect(result.status).toBe("invalid_token");
    });

    /**
     * La regola è «solo un identificatore che DICHIARA la registrazione finita
     * spegne un telefono», e vale anche qui: un 410 nudo non arriva da APNs (che
     * il `reason` lo manda sempre) ma da un proxy o da un gateway, cioè proprio
     * dal caso ambiguo in cui non si distrugge niente.
     */
    it("410 senza reason leggibile → failed, non invalid_token", async () => {
      expect((await sendWith(410)).status).toBe("failed");
      expect((await sendWith(410, "<html>gone</html>")).status).toBe("failed");
    });

    /**
     * ⚠️ NON `invalid_token`. Apple usa `BadDeviceToken` sia per un token
     * inventato sia per un token GIUSTO mandato all'ambiente sbagliato: con
     * `APNS_SANDBOX` invertito, mapparlo su `invalid_token` disabiliterebbe in
     * silenzio l'intera base installata iOS, un device alla volta, con rimedio
     * un re-login su ogni telefono.
     */
    it("400 BadDeviceToken → failed, e il reason nomina l'ambiente", async () => {
      const result = await sendWith(400, JSON.stringify({ reason: "BadDeviceToken" }));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("BadDeviceToken");
      expect(result.reason).toContain("production");
    });

    it.each([
      "PayloadTooLarge",
      "BadTopic",
      "TopicDisallowed",
      "BadCollapseId",
      "DeviceTokenNotForTopic",
    ])("400 %s → failed (permanente, ma il device è sano)", async (reason) => {
      const result = await sendWith(400, JSON.stringify({ reason }));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain(reason);
    });

    it("503 → retry", async () => {
      expect((await sendWith(503)).status).toBe("retry");
    });

    it("429 TooManyRequests → retry", async () => {
      const result = await sendWith(429, JSON.stringify({ reason: "TooManyRequests" }));
      expect(result.status).toBe("retry");
    });

    /**
     * La lezione del Task 9: uno stato ignoto degrada in modo RUMOROSO, e la
     * casella sicura è `failed` — mai `invalid_token`, che spegne un telefono.
     */
    it("un reason 400 che non conosciamo → failed, e lo nomina", async () => {
      const result = await sendWith(400, JSON.stringify({ reason: "QualcosaDiNuovo" }));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("QualcosaDiNuovo");
    });

    it("uno status che non conosciamo → failed, e lo nomina", async () => {
      const result = await sendWith(418);
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("418");
    });

    it("un 5xx sconosciuto resta retry: la classe basta a dire «transitorio»", async () => {
      expect((await sendWith(599)).status).toBe("retry");
    });

    it("un corpo che non è JSON non fa esplodere il client", async () => {
      const result = await sendWith(400, "<html>gateway</html>");
      expect(result.status).toBe("failed");
    });
  });

  /**
   * ⚠️ IL GUASTO CHE PORTA GIÙ IL RELAY PER TUTTI.
   *
   * `node:http2` non impone timeout suoi: un provider che tiene la connessione
   * aperta senza rispondere lascerebbe la Promise di `send` irrisolta PER
   * SEMPRE. Il server fa `Promise.all` sui token del batch, quindi un token
   * appeso blocca anche quelli già consegnati; il worker molla a 10s e ritenta,
   * ma la richiesta appesa resta viva e ogni tentativo ne aggiunge una. Sotto
   * un degrado prolungato il processo si riempie di richieste che non si
   * risolvono mai — e il relay va offline per TUTTE le istanze Stubwise.
   */
  describe("il tetto per singola richiesta", () => {
    it("uno stream che non risponde mai diventa retry, non un blocco", async () => {
      const { client } = build({ responses: [{ kind: "hang" }], timeoutMs: 30 });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("retry");
      expect(result.reason).toContain("timeout");
    });

    it("allo scadere lo stream viene CHIUSO, non solo abbandonato", async () => {
      const { client, http2 } = build({ responses: [{ kind: "hang" }], timeoutMs: 30 });
      await client.send(TOKEN, PAYLOAD);
      expect(http2.streams[0]!.closed).toBe(true);
    });

    it("una risposta che arriva in tempo non è toccata dal tetto", async () => {
      const { client, http2 } = build({ responses: [{ status: 200 }], timeoutMs: 5_000 });
      expect(await client.send(TOKEN, PAYLOAD)).toEqual({ status: "ok" });
      expect(http2.streams[0]!.closed).toBe(false);
    });

    /** Un errore a metà richiesta è transitorio: la connessione, non il token. */
    it("uno stream che fallisce a metà diventa retry", async () => {
      const { client } = build({ responses: [{ kind: "error" }] });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("retry");
    });

    /** ⚠️ E il messaggio dell'errore di rete non deve portarsi dietro il token. */
    it("il token non esce nel reason di un errore di stream", async () => {
      const { client } = build({ responses: [{ kind: "error" }] });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });
  });

  /**
   * ⚠️ VINCOLO DEL TASK 10: `reason` finisce in `notification_deliveries.error`
   * e nei log del worker. Un token là dentro vanifica l'intera catena che lo
   * tiene fuori da colonne e log.
   */
  describe("il token non esce mai dentro reason", () => {
    it("nemmeno se APNs lo mette nel corpo dell'errore", async () => {
      const hostile = JSON.stringify({
        reason: `BadDeviceToken ${TOKEN}`,
        detail: `il token ${TOKEN} non è valido`,
      });
      const { client } = build({ responses: [{ status: 400, body: hostile }] });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });

    it("nemmeno se il corpo d'errore è interamente il token", async () => {
      const { client } = build({ responses: [{ status: 400, body: TOKEN }] });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });

    it("nemmeno su uno status sconosciuto con corpo ostile", async () => {
      const { client } = build({
        responses: [{ status: 418, body: JSON.stringify({ reason: TOKEN }) }],
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });
  });
});
