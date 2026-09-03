/**
 * CLIENT FCM HTTP v1.
 *
 * ⚠️ **Prima di toccare la tabella `classify` qui sotto, leggi le due regole in
 * testa a `./outcome.ts`.** In sintesi: `invalid_token` è l'unico esito
 * distruttivo del sistema — il poller lo traduce in un device DISABILITATO, e
 * il rimedio è un re-login su quel telefono — quindi lo merita solo un codice
 * che dichiara la registrazione finita (`UNREGISTERED`), mai uno status HTTP
 * nudo e mai un codice ignoto; nel dubbio si sceglie `failed`. E in `reason`
 * entra solo un identificatore passato da {@link reasonCode}, mai il testo di
 * una risposta.
 *
 * Quest'ultima regola qui morde davvero: FCM il token lo RIPETE nei messaggi
 * d'errore («The registration token <token> is not a valid FCM registration
 * token»), quindi `error.message` non entra in `reason` in nessuna forma,
 * nemmeno troncato.
 *
 * In v1 questo client porta TUTTO il traffico, iOS compreso: l'app usa Firebase
 * Messaging anche su iOS e Firebase media verso APNs. Da qui il blocco `apns`
 * dentro il messaggio, che è ciò che dà a iOS categoria, badge e raggruppamento.
 */
import { JWT } from "google-auth-library";
import type { PushPayload } from "@stubwise/shared";
import { reasonCode, type PushClient, type PushSendResult } from "./outcome.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/**
 * Tetto per SINGOLA richiesta a FCM.
 *
 * ⚠️ Senza `signal`, `fetch` ricade sui timeout di default di undici (~300s):
 * trenta volte il tetto che il chiamante si aspetta. Il danno è quello descritto
 * su `DEFAULT_REQUEST_TIMEOUT_MS` in `./apns.ts` — il server fa `Promise.all`
 * sui token del batch, il worker molla a 10s e ritenta, e ogni tentativo lascia
 * qui una richiesta viva finché undici non si arrende. Venti secondi: sopra i
 * 10s del client, così è il chiamante a mollare per primo, ma finito.
 *
 * Il timer copre ANCHE la lettura del corpo, non solo gli header: è la stessa
 * lezione già imparata in `createPushRelayClient`, dove un server che manda gli
 * header e poi si pianta sul corpo lasciava la lettura senza tetto.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface FcmClientOptions {
  /** Il JSON del service account, già decodificato (vedi `./config.ts`). */
  serviceAccountJson: string;
  /** Iniettabile nei test; di default il `fetch` globale di Node 22. */
  fetch?: typeof fetch;
  /** Iniettabile nei test, per non fare OAuth vero. */
  getAccessToken?: () => Promise<string>;
  /** Tetto per singola richiesta. Vedi {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Codici PERMANENTI di FCM: il messaggio non arriverà mai, ma il token non
 * c'entra. `THIRD_PARTY_AUTH_ERROR` e `SENDER_ID_MISMATCH` in particolare sono
 * guasti NOSTRI (credenziali del relay, progetto Firebase sbagliato) e
 * riguardano tutti i device insieme: mapparli su `invalid_token` cancellerebbe
 * l'intera base installata per una nostra svista di configurazione.
 *
 * Come per APNs l'elenco è documentazione, non la logica: un codice fuori da
 * qui ricade comunque su `failed`.
 */
const PERMANENT_CODES = new Set([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "SENDER_ID_MISMATCH",
  "THIRD_PARTY_AUTH_ERROR",
]);

/**
 * Estrae il codice d'errore di FCM.
 *
 * ⚠️ **Non basta `error.status`.** Per un token sparito FCM risponde `404` con
 * `status: "NOT_FOUND"` e mette `UNREGISTERED` dentro `details[]`, nell'oggetto
 * `type.googleapis.com/google.firebase.fcm.v1.FcmError`. Leggendo il solo
 * `status` non si vedrebbe MAI un `UNREGISTERED`, e nessun token verrebbe mai
 * potato: i device disinstallati resterebbero attivi per sempre, accumulando
 * consegne che non arrivano a nessuno. `details[]` ha quindi la precedenza.
 */
function extractCode(body: unknown, token: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return null;
  const fields = error as Record<string, unknown>;

  const details = fields["details"];
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail !== "object" || detail === null) continue;
      const code = reasonCode((detail as Record<string, unknown>)["errorCode"], token);
      if (code !== null) return code;
    }
  }
  return reasonCode(fields["status"], token);
}

export function createFcmClient(options: FcmClientOptions): PushClient {
  const account = JSON.parse(options.serviceAccountJson) as {
    project_id: string;
    client_email: string;
    private_key: string;
  };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

  // Creato pigramente: con `getAccessToken` iniettato (i test) non serve, e
  // costruirlo comunque significherebbe pretendere una chiave privata vera.
  let jwt: JWT | null = null;
  const getAccessToken =
    options.getAccessToken ??
    (async () => {
      jwt ??= new JWT({
        email: account.client_email,
        key: account.private_key,
        scopes: [FCM_SCOPE],
      });
      const { token } = await jwt.getAccessToken();
      if (typeof token !== "string" || token === "") {
        throw new Error("nessun access token da Google");
      }
      return token;
    });

  function buildMessage(token: string, payload: PushPayload): unknown {
    const androidNotification: Record<string, unknown> = { channel_id: payload.category };
    if (payload.collapseId !== undefined) androidNotification["tag"] = payload.collapseId;
    if (payload.badge !== undefined) androidNotification["notification_count"] = payload.badge;

    const android: Record<string, unknown> = {
      priority: "high",
      notification: androidNotification,
    };
    if (payload.collapseId !== undefined) android["collapse_key"] = payload.collapseId;

    const aps: Record<string, unknown> = { category: payload.category, sound: "default" };
    if (payload.badge !== undefined) aps["badge"] = payload.badge;
    if (payload.threadId !== undefined) aps["thread-id"] = payload.threadId;

    const apnsHeaders: Record<string, string> = {
      "apns-priority": "10",
      "apns-push-type": "alert",
    };
    if (payload.collapseId !== undefined) apnsHeaders["apns-collapse-id"] = payload.collapseId;

    return {
      message: {
        token,
        notification: { title: payload.title, body: payload.body },
        // Già `Record<string, string>` per contratto: `Message.data` di FCM v1 è
        // `map<string,string>` e un valore non stringa fa fallire TUTTO l'invio.
        data: payload.data,
        android,
        apns: { headers: apnsHeaders, payload: { aps } },
      },
    };
  }

  /** LA TABELLA. Vedi l'ordine di lettura in `apns.ts`: è lo stesso. */
  function classify(status: number, rawBody: string, token: string): PushSendResult {
    if (status >= 200 && status < 300) return { status: "ok" };

    let code: string | null = null;
    try {
      code = extractCode(JSON.parse(rawBody), token);
    } catch {
      // Corpo non JSON: si ricade sullo status. Mai dentro il testo.
    }

    // (1) L'unico esito distruttivo. La CONGIUNZIONE è voluta: `404` da solo
    // esce anche quando il `project_id` del service account è sbagliato — una
    // nostra misconfigurazione che riguarda TUTTI i device — e `UNREGISTERED`
    // da solo non dovrebbe mai arrivare con un altro status. Servono entrambi.
    if (status === 404 && code === "UNREGISTERED") return { status: "invalid_token" };

    // (2) Transitori: la classe dello status basta.
    if (status === 429 || status >= 500) {
      return { status: "retry", reason: code ?? `fcm status ${status}` };
    }

    // (3) Permanenti noti.
    if (code !== null && PERMANENT_CODES.has(code)) return { status: "failed", reason: code };

    // (4) Il fondo, rumoroso e mai distruttivo.
    return {
      status: "failed",
      reason: code !== null ? `unknown FCM code ${code}` : `unknown FCM status ${status}`,
    };
  }

  return {
    async send(token, payload) {
      let accessToken: string;
      try {
        accessToken = await getAccessToken();
      } catch {
        /**
         * Le credenziali del relay non si trasformano in un access token: è un
         * guasto NOSTRO e permanente (service account revocato, chiave
         * ruotata), non del telefono. La `cause` non si propaga e il messaggio
         * dell'errore non si riporta: `invalid_grant` di Google arriva con
         * dentro l'email del service account.
         */
        return { status: "failed", reason: "fcm auth failed" };
      }

      // `AbortController` esplicito e non `AbortSignal.timeout`: così il
      // segnale è osservabile dal `fetch` iniettato nei test, che può abortire
      // per davvero invece di simulare un rifiuto.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /**
       * Il tetto non si affida SOLO al segnale.
       *
       * `signal` dice a undici di chiudere la connessione — ed è quello che
       * libera davvero il socket — ma è una promessa che ci fa la libreria: un
       * `fetch` che lo ignorasse ci lascerebbe appesi comunque, che è la
       * lacuna appena chiusa. Correndo contro questa promessa il tetto diventa
       * NOSTRO: qualunque cosa faccia il trasporto, `send` ritorna entro
       * `timeoutMs`. Le due cose sono complementari, non ridondanti — il
       * segnale libera la risorsa, la corsa libera noi.
       */
      const expired = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("timeout")), {
          once: true,
        });
      });
      // Il `finally` cancella il timer, quindi normalmente questa non rigetta
      // mai; il no-op evita un'unhandled rejection nella corsa fra i due.
      expired.catch(() => {});
      try {
        let response: Response;
        try {
          response = await Promise.race([
            fetchImpl(endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(buildMessage(token, payload)),
              signal: controller.signal,
            }),
            expired,
          ]);
        } catch {
          // ⚠️ Messaggio FISSO. Un errore di rete di undici può portarsi dietro
          // l'URL e, in alcune forme, il corpo della richiesta — cioè il token.
          return controller.signal.aborted
            ? { status: "retry", reason: `fcm timeout after ${timeoutMs}ms` }
            : { status: "retry", reason: "fcm network error" };
        }

        let rawBody = "";
        try {
          rawBody = await Promise.race([response.text(), expired]);
        } catch {
          // Corpo illeggibile, o timeout scattato MENTRE lo leggevamo: in
          // entrambi i casi si classifica su ciò che si ha. Se è stato il
          // timeout, lo si dice — è transitorio, non un guasto del payload.
          if (controller.signal.aborted) {
            return { status: "retry", reason: `fcm timeout after ${timeoutMs}ms` };
          }
        }
        return classify(response.status, rawBody, token);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
