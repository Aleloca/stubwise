/**
 * CLIENT APNs (HTTP/2 + provider token JWT ES256).
 *
 * ⚠️ **Prima di toccare la tabella `classify` qui sotto, leggi le due regole in
 * testa a `./outcome.ts`.** In sintesi: `invalid_token` è l'unico esito
 * distruttivo del sistema — il poller lo traduce in un device DISABILITATO, e
 * il rimedio è un re-login su quel telefono — quindi lo merita solo un codice
 * che dichiara la registrazione finita (`Unregistered`), mai uno status HTTP
 * nudo e mai un codice ignoto; nel dubbio si sceglie `failed`. E in `reason`
 * entra solo un identificatore passato da {@link reasonCode}, mai il testo di
 * una risposta: quel campo finisce in `notification_deliveries.error`.
 *
 * ⚠️ **In v1 questo client è INATTIVO** (`IOS_PUSH_VIA=fcm`, il default): l'app
 * usa Firebase Messaging anche su iOS, quindi i token `ios` sono token FCM.
 * Resta implementato e testato perché la fase 4b — token APNs nativi e
 * Notification Service Extension — sia una variabile d'ambiente e non una
 * riscrittura. Vuol dire però che **un errore qui non lo scopre nessuno in
 * produzione**: i test sono l'unica rete, e vanno tenuti onesti.
 */
import { createSign } from "node:crypto";
import { connect as http2Connect } from "node:http2";
import type { PushPayload } from "@stubwise/shared";
import { APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST } from "./config.js";
import { reasonCode, type PushClient, type PushSendResult } from "./outcome.js";

/**
 * La fetta di `ClientHttp2Session` che serve al client, dichiarata in modo
 * strutturale così che un test possa iniettarne una finta senza aprire socket.
 */
export interface Http2StreamLike {
  on(event: "response", listener: (headers: Record<string, unknown>) => void): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  setEncoding(encoding: string): unknown;
  end(body?: string): unknown;
}

export interface Http2SessionLike {
  request(headers: Record<string, string | number>): Http2StreamLike;
  close(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroyed: boolean;
}

export type Http2ConnectLike = (authority: string) => Http2SessionLike;

export interface ApnsClientOptions {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  sandbox: boolean;
  /** Iniettabile nei test; di default `http2.connect`. */
  http2Connect?: Http2ConnectLike;
  /** Iniettabile nei test, per esercitare la scadenza del provider token. */
  now?: () => number;
}

export interface ApnsClient extends PushClient {
  close(): void;
}

/**
 * Vita del provider token.
 *
 * Apple rifiuta un token più vecchio di **un'ora** (`ExpiredProviderToken`) e
 * insieme rifiuta chi lo rigenera troppo spesso (`TooManyProviderTokenUpdates`):
 * il margine di dieci minuti serve a stare lontani da entrambi i muri.
 */
const PROVIDER_TOKEN_TTL_MS = 50 * 60_000;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Codici che APNs manda quando il problema è PERMANENTE ma NON riguarda la
 * validità del token: il payload, il topic, le nostre credenziali.
 *
 * Sono elencati per essere LEGGIBILI, non perché la classificazione dipenda
 * dall'elenco: un codice fuori da qui ricade comunque su `failed` (vedi
 * `classify`). L'elenco serve a chi legge per sapere cosa ci si aspetta.
 */
const PERMANENT_REASONS = new Set([
  "BadCollapseId",
  "BadDeviceToken",
  "BadExpirationDate",
  "BadMessageId",
  "BadPriority",
  "BadTopic",
  "DeviceTokenNotForTopic",
  "DuplicateHeaders",
  "IdleTimeout",
  "InvalidProviderToken",
  "MissingDeviceToken",
  "MissingTopic",
  "PayloadEmpty",
  "PayloadTooLarge",
  "TopicDisallowed",
  "UnrelatedTopic",
]);

/**
 * Codici in cui l'ambiente (`APNS_SANDBOX`) è una causa PLAUSIBILE quanto un
 * token davvero sbagliato: nel `reason` si nomina perciò l'ambiente in uso, così
 * chi legge `notification_deliveries.error` vede subito la pista giusta invece
 * di dare la colpa al telefono. È la sola mitigazione possibile: Apple manda lo
 * stesso codice nei due casi e il relay non li può distinguere.
 */
const ENVIRONMENT_SENSITIVE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

export function createApnsClient(options: ApnsClientOptions): ApnsClient {
  const connect = options.http2Connect ?? (http2Connect as unknown as Http2ConnectLike);
  const now = options.now ?? Date.now;
  const authority = options.sandbox ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
  const environment = options.sandbox ? "sandbox" : "production";

  let session: Http2SessionLike | null = null;
  let cachedToken: { value: string; issuedAt: number } | null = null;

  /**
   * Il provider token, rigenerato solo alla scadenza.
   *
   * ⚠️ ES256 vuole la firma GREZZA r||s (IEEE P-1363, 64 byte). Node firma le
   * curve ellittiche in **DER** se non gli si dice altro, e un JWT firmato in
   * DER è sintatticamente perfetto: APNs lo rifiuta con `InvalidProviderToken`
   * e non c'è nulla, nel codice, che lo faccia sospettare. È il motivo del
   * `dsaEncoding` qui sotto e del test che misura la firma in byte.
   */
  function providerToken(): string {
    const issuedAt = now();
    if (cachedToken !== null && issuedAt - cachedToken.issuedAt < PROVIDER_TOKEN_TTL_MS) {
      return cachedToken.value;
    }
    const header = base64url(JSON.stringify({ alg: "ES256", kid: options.keyId }));
    const claims = base64url(
      JSON.stringify({ iss: options.teamId, iat: Math.floor(issuedAt / 1000) }),
    );
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign({ key: options.keyP8, dsaEncoding: "ieee-p1363" });
    const value = `${header}.${claims}.${base64url(signature)}`;
    cachedToken = { value, issuedAt };
    return value;
  }

  function openSession(): Http2SessionLike {
    if (session !== null && !session.destroyed) return session;
    const opened = connect(authority);
    // Senza un listener, un errore di sessione diventa un'eccezione non gestita
    // che abbatte il processo: il relay morirebbe per un reset di APNs.
    opened.on("error", () => {
      session = null;
    });
    session = opened;
    return opened;
  }

  function buildBody(payload: PushPayload): string {
    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      category: payload.category,
      sound: "default",
    };
    if (payload.badge !== undefined) aps["badge"] = payload.badge;
    if (payload.threadId !== undefined) aps["thread-id"] = payload.threadId;
    // `data` in cima accanto ad `aps`: è così che APNs consegna le chiavi
    // custom all'app. Le chiavi del contratto sono già sole stringhe.
    return JSON.stringify({ aps, ...payload.data });
  }

  /**
   * LA TABELLA. Ordine di lettura: prima i due casi che decidono il destino di
   * un device, poi le classi transitorie, poi il fondo che raccoglie tutto il
   * resto — mai in silenzio.
   */
  function classify(status: number, rawBody: string, token: string): PushSendResult {
    if (status === 200) return { status: "ok" };

    let code: string | null = null;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed === "object" && parsed !== null) {
        code = reasonCode((parsed as Record<string, unknown>)["reason"], token);
      }
    } catch {
      // Corpo non JSON (un gateway, una pagina d'errore): resta `null`, e sotto
      // si ricade sullo status. Non si guarda MAI dentro il testo.
    }

    // (1) L'unico esito distruttivo, e l'unico codice che lo dichiara.
    if (status === 410 && code === "Unregistered") return { status: "invalid_token" };

    // (2) Le nostre credenziali sono scadute: si butta la cache così il
    // prossimo invio riparte pulito. Resta `failed` — non riguarda il token, e
    // ritentare con lo stesso JWT non servirebbe a nulla.
    if (code === "ExpiredProviderToken" || code === "InvalidProviderToken") {
      cachedToken = null;
      return { status: "failed", reason: code };
    }

    // (3) Transitori: la CLASSE dello status basta a dirlo, qualunque sia il
    // codice. È l'unico posto in cui si concede un `retry`.
    if (status === 429 || status >= 500) {
      return { status: "retry", reason: code ?? `apns status ${status}` };
    }

    // (4) Permanenti noti.
    if (code !== null && PERMANENT_REASONS.has(code)) {
      const reason = ENVIRONMENT_SENSITIVE_REASONS.has(code)
        ? `${code} (apns env: ${environment})`
        : code;
      return { status: "failed", reason };
    }

    // (5) Il fondo: tutto ciò che non conosciamo. `failed`, mai `invalid_token`
    // — e RUMOROSO, col nome di ciò che non sappiamo leggere, perché chi legge
    // il log capisca che gli manca un aggiornamento invece di vedere sparire
    // una notifica.
    return {
      status: "failed",
      reason: code !== null ? `unknown APNs reason ${code}` : `unknown APNs status ${status}`,
    };
  }

  return {
    async send(token, payload) {
      const body = buildBody(payload);
      const headers: Record<string, string | number> = {
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": options.bundleId,
        "apns-push-type": "alert",
        "apns-priority": 10,
      };
      if (payload.collapseId !== undefined) headers["apns-collapse-id"] = payload.collapseId;

      const { status, raw } = await new Promise<{ status: number; raw: string }>(
        (resolve, reject) => {
          const stream = openSession().request(headers);
          let chunks = "";
          let httpStatus = 0;
          stream.setEncoding("utf8");
          stream.on("response", (responseHeaders) => {
            httpStatus = Number(responseHeaders[":status"] ?? 0);
          });
          stream.on("data", (chunk) => {
            chunks += chunk;
          });
          stream.on("end", () => resolve({ status: httpStatus, raw: chunks }));
          stream.on("error", (error) => reject(error));
          stream.end(body);
        },
      );

      return classify(status, raw, token);
    },
    close() {
      session?.close();
      session = null;
    },
  };
}
