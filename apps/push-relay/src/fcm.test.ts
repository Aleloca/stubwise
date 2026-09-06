import { describe, expect, it } from "vitest";
import { createFcmClient } from "./fcm.js";
import type { PushPayload } from "@stubwise/shared";

/** Un token FCM realistico: lungo, con `:` e `-`, non una stringa regolare. */
const TOKEN = "fJ8kQ2mXSFy1nR0pZ4vTbA:APA91bH7xK-2NfQwE9rLm3sVuY6dGc0iPjO5tZaB8hXn4LqW1eRyU3oI";

const PAYLOAD: PushPayload = {
  title: "PR aperta",
  body: "Il fix di #42 è pronto per la review",
  category: "job.pr_opened",
  data: { notificationId: "n-1", url: "/inbox/n-1" },
  badge: 3,
  threadId: "proj-7",
  collapseId: "n-1",
};

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "stubwise-push",
  client_email: "relay@stubwise-push.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function build(responses: Array<{ status: number; body?: string }>) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const next = queue.shift() ?? { status: 200 };
    return new Response(next.body ?? "{}", { status: next.status });
  }) as unknown as typeof fetch;

  const client = createFcmClient({
    serviceAccountJson: SERVICE_ACCOUNT,
    fetch: fetchImpl,
    getAccessToken: async () => "ya29.ACCESS-TOKEN",
  });
  return { client, calls };
}

describe("createFcmClient", () => {
  describe("la richiesta", () => {
    it("va sull'endpoint del project_id del service account, autenticata", async () => {
      const { client, calls } = build([{ status: 200 }]);
      await client.send(TOKEN, PAYLOAD);

      expect(calls[0]!.url).toBe(
        "https://fcm.googleapis.com/v1/projects/stubwise-push/messages:send",
      );
      expect(calls[0]!.headers["authorization"]).toBe("Bearer ya29.ACCESS-TOKEN");
      expect(calls[0]!.headers["content-type"]).toBe("application/json");
    });

    it("costruisce il messaggio con i blocchi android e apns", async () => {
      const { client, calls } = build([{ status: 200 }]);
      await client.send(TOKEN, PAYLOAD);

      expect(calls[0]!.body).toEqual({
        message: {
          token: TOKEN,
          notification: { title: "PR aperta", body: "Il fix di #42 è pronto per la review" },
          data: { notificationId: "n-1", url: "/inbox/n-1" },
          android: {
            priority: "high",
            notification: { channel_id: "job.pr_opened", tag: "n-1", notification_count: 3 },
            collapse_key: "n-1",
          },
          apns: {
            headers: {
              "apns-collapse-id": "n-1",
              "apns-priority": "10",
              "apns-push-type": "alert",
            },
            payload: {
              aps: { category: "job.pr_opened", badge: 3, "thread-id": "proj-7", sound: "default" },
            },
          },
        },
      });
    });

    /**
     * `Message.data` di FCM v1 è `map<string,string>`: un valore non stringa fa
     * fallire l'intero invio con `INVALID_ARGUMENT`. Il contratto lo garantisce
     * già a monte, ma qui si verifica che il relay non ci infili nulla di suo.
     */
    it("data contiene SOLE stringhe", async () => {
      const { client, calls } = build([{ status: 200 }]);
      await client.send(TOKEN, { ...PAYLOAD, data: { a: "1", b: "" } });
      const data = (calls[0]!.body as { message: { data: Record<string, unknown> } }).message.data;
      for (const value of Object.values(data)) expect(typeof value).toBe("string");
    });

    it("senza badge/threadId/collapseId omette i campi invece di mandarli nulli", async () => {
      const { client, calls } = build([{ status: 200 }]);
      await client.send(TOKEN, { title: "T", body: "B", category: "ticket.created", data: {} });
      const message = (calls[0]!.body as { message: Record<string, unknown> }).message;
      expect(message["android"]).toEqual({
        priority: "high",
        notification: { channel_id: "ticket.created" },
      });
      expect(message["apns"]).toEqual({
        headers: { "apns-priority": "10", "apns-push-type": "alert" },
        payload: { aps: { category: "ticket.created", sound: "default" } },
      });
    });
  });

  describe("la mappatura errore → esito", () => {
    async function sendWith(status: number, body?: string) {
      const { client } = build([{ status, body }]);
      return client.send(TOKEN, PAYLOAD);
    }

    function fcmError(status: string, message = "dettaglio"): string {
      return JSON.stringify({ error: { code: 400, status, message } });
    }

    it("200 → ok", async () => {
      expect(await sendWith(200)).toEqual({ status: "ok" });
    });

    /** L'unico esito che spegne un telefono, e l'unico codice che lo dichiara. */
    it("404 UNREGISTERED → invalid_token", async () => {
      const result = await sendWith(404, fcmError("UNREGISTERED"));
      expect(result.status).toBe("invalid_token");
    });

    /**
     * ⚠️ LA FORMA VERA di FCM v1 per un token sparito: `status` vale
     * `NOT_FOUND` e `UNREGISTERED` sta in `details[].errorCode`. Leggendo il
     * solo `status` non si poterebbe MAI un token, e i device disinstallati
     * resterebbero attivi per sempre.
     */
    it("404 con UNREGISTERED dentro details[] → invalid_token", async () => {
      const body = JSON.stringify({
        error: {
          code: 404,
          message: "Requested entity was not found.",
          status: "NOT_FOUND",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      });
      expect((await sendWith(404, body)).status).toBe("invalid_token");
    });

    /**
     * ⚠️ Un 404 NUDO non basta: lo stesso codice esce quando il `project_id`
     * del service account è sbagliato, cioè per una nostra misconfigurazione
     * che riguarda TUTTI i device. Solo `UNREGISTERED` parla del token.
     */
    it("404 NOT_FOUND (project sbagliato) → failed, non invalid_token", async () => {
      const result = await sendWith(404, fcmError("NOT_FOUND"));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("NOT_FOUND");
    });

    it("404 senza corpo leggibile → failed: nel dubbio non si spegne un telefono", async () => {
      expect((await sendWith(404, "<html>not found</html>")).status).toBe("failed");
    });

    it("400 INVALID_ARGUMENT → failed", async () => {
      const result = await sendWith(400, fcmError("INVALID_ARGUMENT"));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("INVALID_ARGUMENT");
    });

    it.each(["THIRD_PARTY_AUTH_ERROR", "SENDER_ID_MISMATCH", "PERMISSION_DENIED"])(
      "%s → failed (è un guasto NOSTRO, non del token)",
      async (status) => {
        const result = await sendWith(403, fcmError(status));
        expect(result.status).toBe("failed");
      },
    );

    it("429 QUOTA_EXCEEDED → retry", async () => {
      expect((await sendWith(429, fcmError("QUOTA_EXCEEDED"))).status).toBe("retry");
    });

    it.each([500, 503])("%i → retry", async (status) => {
      expect((await sendWith(status)).status).toBe("retry");
    });

    it("UNAVAILABLE → retry", async () => {
      expect((await sendWith(503, fcmError("UNAVAILABLE"))).status).toBe("retry");
    });

    it("uno status che non conosciamo → failed, e lo nomina", async () => {
      const result = await sendWith(400, fcmError("STATO_NUOVO"));
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("STATO_NUOVO");
    });

    it("la rete che cade → retry", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch,
        getAccessToken: async () => "t",
      });
      expect((await client.send(TOKEN, PAYLOAD)).status).toBe("retry");
    });

    /** Le credenziali del relay non si prendono a OAuth: è permanente, non del token. */
    it("l'access token non ottenibile → failed", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: (() =>
          Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch,
        getAccessToken: async () => {
          throw new Error("invalid_grant");
        },
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("failed");
    });
  });

  /**
   * ⚠️ Senza `signal`, `fetch` ricade sui timeout di undici (~300s): trenta
   * volte il tetto che il chiamante si aspetta, con lo stesso accumulo di
   * richieste appese descritto su `apns.ts`. Il fake qui sotto non risponde
   * MAI di suo: si sblocca solo perché è il client ad abortire.
   */
  describe("il tetto per singola richiesta", () => {
    /** Un fetch che si risolve solo quando il segnale viene abortito. */
    function hangingFetch(): typeof fetch {
      return ((_url: string | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        })) as unknown as typeof fetch;
    }

    it("una richiesta che non risponde mai diventa retry, non un blocco", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: hangingFetch(),
        getAccessToken: async () => "t",
        timeoutMs: 30,
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("retry");
      expect(result.reason).toContain("timeout");
    });

    /**
     * ⚠️ Il caso che il solo `signal` NON copre: un `fetch` che il segnale lo
     * IGNORA. `signal` è una promessa che ci fa il trasporto — undici la
     * mantiene, ma il tetto non può dipendere da questo. Qui il fake non
     * risponde e non ascolta l'abort: se `send` ritorna comunque, è perché il
     * tetto è nostro.
     */
    it("regge anche se il fetch ignora del tutto il segnale", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
        getAccessToken: async () => "t",
        timeoutMs: 30,
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("retry");
      expect(result.reason).toContain("timeout");
    });

    it("il segnale arriva davvero al fetch (non è un rifiuto simulato)", async () => {
      let seenSignal: AbortSignal | undefined;
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: ((_url: string | URL, init?: RequestInit) => {
          seenSignal = init?.signal ?? undefined;
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch,
        getAccessToken: async () => "t",
      });
      await client.send(TOKEN, PAYLOAD);
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal!.aborted).toBe(false);
    });

    /**
     * Il timer copre ANCHE la lettura del corpo: un server che manda gli header
     * e poi si pianta lascerebbe `text()` senza tetto — è la lezione già
     * imparata in `createPushRelayClient`.
     */
    it("un corpo che non arriva mai è comunque un timeout", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: (() =>
          Promise.resolve({
            status: 200,
            text: () => new Promise<string>(() => {}),
          })) as unknown as typeof fetch,
        getAccessToken: async () => "t",
        timeoutMs: 30,
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.status).toBe("retry");
      expect(result.reason).toContain("timeout");
    });
  });

  /** ⚠️ VINCOLO DEL TASK 10, e qui morde davvero: FCM ripete il token nei messaggi. */
  describe("il token non esce mai dentro reason", () => {
    it("nemmeno quando FCM lo ripete nel messaggio d'errore", async () => {
      const body = JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: `The registration token ${TOKEN} is not a valid FCM registration token`,
          details: [{ token: TOKEN }],
        },
      });
      const { client } = build([{ status: 400, body }]);
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
      expect(result.reason).toContain("INVALID_ARGUMENT");
    });

    /**
     * ⚠️ UN TOKEN CORTO è il caso che il tetto sui 40 caratteri NON può
     * fermare: qui l'unica barriera è il confronto esplicito col token. Il
     * mutation testing lo ha dimostrato — togliendo solo il tetto, o solo il
     * confronto, i test con un token da 64 caratteri restavano verdi, perché
     * ciascuna barriera da sola bastava. Il contratto ammette qualunque token
     * da 1 byte in su, quindi la copertura senza questo caso era illusoria.
     */
    it("nemmeno se il token è corto e ha la forma di un identificatore", async () => {
      const shortToken = "abcdefghijklmnopqrst";
      const body = JSON.stringify({ error: { status: shortToken } });
      const { client } = build([{ status: 400, body }]);
      const result = await client.send(shortToken, PAYLOAD);
      expect(result.reason ?? "").not.toContain(shortToken);
    });

    it("nemmeno se il token si traveste da status", async () => {
      const body = JSON.stringify({ error: { status: TOKEN } });
      const { client } = build([{ status: 400, body }]);
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });

    /**
     * ⚠️ LA SOVRAPPOSIZIONE A UN BORDO: il caso che il confronto per contenenza
     * TOTALE lasciava passare. Qui né il codice contiene il token né il token
     * contiene il codice — si toccano solo su un bordo — eppure il codice si
     * porta via dieci caratteri del token. È il buco che ha reso necessario
     * `sharesRunWithToken`: con un `code` fino a 40 caratteri il frammento
     * poteva arrivare a 39.
     */
    it.each([
      ["un SUFFISSO del token in testa al codice", "klmnopqrstUnregistered"],
      ["un PREFISSO del token in coda al codice", "InvalidTokenabcdefghij"],
    ])("nemmeno con %s", async (_name, hostileCode) => {
      const overlapToken = "abcdefghijklmnopqrst";
      const body = JSON.stringify({ error: { status: hostileCode } });
      const { client } = build([{ status: 400, body }]);
      const result = await client.send(overlapToken, PAYLOAD);
      // Nessun frammento lungo del token deve sopravvivere in `reason`.
      expect(result.reason ?? "").not.toContain("klmnopqrst");
      expect(result.reason ?? "").not.toContain("abcdefghij");
    });

    it("nemmeno quando l'errore di rete porta il token nel messaggio", async () => {
      const client = createFcmClient({
        serviceAccountJson: SERVICE_ACCOUNT,
        fetch: (() =>
          Promise.reject(
            new Error(`connect ECONNREFUSED sending ${TOKEN}`),
          )) as unknown as typeof fetch,
        getAccessToken: async () => "t",
      });
      const result = await client.send(TOKEN, PAYLOAD);
      expect(result.reason ?? "").not.toContain(TOKEN);
    });
  });
});
