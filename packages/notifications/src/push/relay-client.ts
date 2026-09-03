/**
 * CLIENT DEL RELAY PUSH: l'unico punto in cui un'istanza Stubwise parla del
 * mondo delle push con qualcuno.
 *
 * Il modello è relay-only: le chiavi APNs/FCM sono legate alla nostra identità
 * dell'app e vivono SOLO nel relay. Nessuna istanza — nemmeno la nostra —
 * chiama APNs o FCM: tutte fanno `POST <relay>/v1/send`.
 *
 * I DUE ERRORI NON SONO SFUMATURE DELLO STESSO: sono l'istruzione che il poller
 * delle consegne aspetta. {@link PushRelayUnavailable} dice «riprova col
 * backoff» (il guasto è di là e passerà), {@link PushRelayRejected} dice
 * «arrenditi e segna `failed`» (la richiesta non andrà mai bene così com'è).
 * Confonderli costa in entrambe le direzioni: un bug di contratto ritentato per
 * sempre, o una notifica buttata via per un 503 di trenta secondi.
 */
import {
  PUSH_RELAY_MAX_TOKENS,
  pushRelaySendRequestSchema,
  pushRelaySendResponseSchema,
  type PushPayload,
  type PushRelaySendResponse,
  type PushRelayToken,
} from "@stubwise/shared";

/**
 * Il relay non è raggiungibile o non ce l'ha fatta: rete, timeout, 5xx, e
 * anche i due 4xx che sono attese travestite (vedi {@link RETRYABLE_STATUSES}).
 * Il chiamante RITENTA.
 */
export class PushRelayUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PushRelayUnavailable";
  }
}

/**
 * Il relay ha capito la richiesta e l'ha rifiutata, o ha risposto qualcosa che
 * non sappiamo leggere: è un BUG DI CONTRATTO fra due software che deployiamo
 * noi. Il chiamante NON ritenta e segna la consegna `failed`, così il guasto si
 * vede invece di consumare tentativi in silenzio.
 */
export class PushRelayRejected extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PushRelayRejected";
  }
}

/**
 * Codici che il relay usa per dire «più tardi», e che a dispetto della classe
 * 4xx NON sono bug di contratto: `429` è il rate limit per token del relay,
 * `408` un timeout dichiarato da lui. Trattarli come gli altri 4xx butterebbe
 * via una notifica che sarebbe bastato rimandare di trenta secondi.
 */
const RETRYABLE_STATUSES = new Set([408, 429]);

export interface PushRelayClientOptions {
  /** Base del relay, senza path: `/v1/send` lo aggiunge il client. */
  url: string;
  /** Iniettabile nei test (default: il fetch globale di Node 22). */
  fetch?: typeof fetch;
  /** Tetto per singola chiamata. Vedi il docblock di {@link createPushRelayClient}. */
  timeoutMs?: number;
}

export interface PushRelayClient {
  /**
   * Manda lo stesso payload a tutti i device del destinatario e ritorna un
   * esito per token, nell'ordine dei token passati.
   *
   * LANCIA {@link PushRelayUnavailable} o {@link PushRelayRejected}: non
   * esiste un ritorno "andata male". Un esito per-token negativo
   * (`invalid_token`, `retry`) è invece un successo della CHIAMATA e sta nella
   * risposta — è il chiamante a decidere cosa farne.
   */
  send(tokens: PushRelayToken[], payload: PushPayload): Promise<PushRelaySendResponse>;
}

/** Spezza i token in gruppi che stanno in una chiamata sola. */
function chunk(tokens: PushRelayToken[]): PushRelayToken[][] {
  const chunks: PushRelayToken[][] = [];
  for (let i = 0; i < tokens.length; i += PUSH_RELAY_MAX_TOKENS) {
    chunks.push(tokens.slice(i, i + PUSH_RELAY_MAX_TOKENS));
  }
  return chunks;
}

/**
 * Crea il client del relay.
 *
 * `timeoutMs` (default 10 s) è il tetto per SINGOLA chiamata, allineato a
 * quello del webhook nello stesso poller. Va letto sapendo dove finisce: il
 * poller delle consegne processa fino a 20 righe per tick, IN SEQUENZA e con
 * una guardia anti-rientro, quindi un relay morto allunga il tick fino a
 * 20 × timeout — e in quel tick non partono nemmeno i DM Slack, che stanno
 * nella stessa coda. Chi accorcia il timeout non sta ottimizzando la latenza
 * della push: sta accorciando il blocco di TUTTE le consegne quando il relay è
 * giù. Un relay sano risponde in decine di millisecondi.
 *
 * ⚠️ **Il token push non finisce MAI nel messaggio di un'eccezione.** Da un
 * token in un log ci si può intestare il device di qualcun altro (il perché per
 * esteso sta su `deviceRegistrationSchema` in `@stubwise/shared`), e questi
 * messaggi il poller li scrive nel log e in `notification_deliveries.error`.
 * Per questo dell'errore si riporta lo STATO, non il corpo della risposta —
 * che il relay potrebbe benissimo aver riempito coi token — e di un parse
 * fallito i soli percorsi dei campi, non i valori.
 */
export function createPushRelayClient({
  url,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}: PushRelayClientOptions): PushRelayClient {
  const endpoint = `${url.replace(/\/+$/, "")}/v1/send`;

  async function sendChunk(
    tokens: PushRelayToken[],
    payload: PushPayload,
  ): Promise<PushRelaySendResponse> {
    // Validazione LOCALE prima della rete: la richiesta la costruiamo noi, e
    // una che il relay rifiuterebbe è un nostro bug. Scoprirlo qui dà un
    // messaggio che nomina il campo invece di un 400 opaco, e non consuma un
    // round-trip. `error.issues` porta i PERCORSI, non i valori: un token
    // fuori tetto non si trascina dietro il token.
    const parsedRequest = pushRelaySendRequestSchema.safeParse({ tokens, payload });
    if (!parsedRequest.success) {
      const fields = parsedRequest.error.issues.map((issue) => issue.path.join(".") || "(root)");
      throw new PushRelayRejected(
        `richiesta fuori contratto verso il relay push (campi: ${[...new Set(fields)].join(", ")})`,
      );
    }

    // AbortController esplicito invece di `AbortSignal.timeout`: il segnale
    // così è osservabile dal fetch iniettato nei test, che può abortire per
    // davvero invece di simulare un rifiuto.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsedRequest.data),
          signal: controller.signal,
        });
      } catch (error) {
        // Rete caduta, DNS, TLS, o il nostro stesso timeout: tutto transitorio.
        const reason = controller.signal.aborted ? `timeout dopo ${timeoutMs}ms` : "errore di rete";
        throw new PushRelayUnavailable(`relay push non raggiungibile (${reason})`, { cause: error });
      }

      if (!res.ok) {
        // Solo lo STATO nel messaggio: il corpo della risposta d'errore
        // potrebbe contenere i token che le abbiamo appena mandato.
        if (res.status >= 500 || RETRYABLE_STATUSES.has(res.status)) {
          throw new PushRelayUnavailable(`relay push ha risposto ${res.status}`);
        }
        throw new PushRelayRejected(`relay push ha rifiutato la richiesta (${res.status})`);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (error) {
        // ⚠️ Il timer copre anche QUESTA attesa, e non è pedanteria: un relay
        // che manda gli header e poi si pianta sul corpo lascerebbe la lettura
        // appesa SENZA TETTO. A rimetterci non sarebbe la push — il poller
        // processa le consegne in sequenza con una guardia anti-rientro,
        // quindi resterebbero ferme anche tutte le altre, DM Slack e webhook
        // compresi, fino al riavvio del worker. Abortito il segnale, `fetch`
        // fa fallire lo stream del corpo: è quel fallimento che arriva qui, e
        // va letto come timeout (transitorio), non come JSON malformato.
        if (controller.signal.aborted) {
          throw new PushRelayUnavailable(
            `relay push non raggiungibile (timeout dopo ${timeoutMs}ms leggendo la risposta)`,
            { cause: error },
          );
        }
        throw new PushRelayRejected("risposta del relay push non è JSON", { cause: error });
      }
      const parsed = pushRelaySendResponseSchema.safeParse(json);
      if (!parsed.success) {
        const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new PushRelayRejected(
          `risposta del relay push fuori contratto (campi: ${[...new Set(fields)].join(", ")})`,
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async send(tokens, payload) {
      /**
       * Oltre il tetto del contratto si fanno PIÙ CHIAMATE, non un errore né un
       * troncamento.
       *
       * Non è il caso «qualcuno ha 25 telefoni»: un token resta attivo finché
       * una push non torna `invalid_token`, quindi le reinstallazioni ne
       * accumulano di stantii. Se oltre il tetto la spedizione fallisse, la
       * potatura — che arriva SOLO da una spedizione riuscita — non
       * arriverebbe mai: l'utente resterebbe senza push per sempre, e il
       * guasto si sarebbe chiuso dentro da solo.
       *
       * In sequenza e non in parallelo: sono le stesse ragioni per cui il
       * poller manda le consegne una alla volta, e i gruppi sono al più due o
       * tre. Se un gruppo intermedio lancia, l'intera `send` lancia e il poller
       * ritenta tutto: i device del primo gruppo ricevono una seconda volta la
       * stessa push, che il `collapseId` fa SOSTITUIRE a quella già arrivata
       * invece di accodarla.
       */
      // `tokens` vuoto non produce nessun gruppo: senza questo controllo la
      // validazione locale non scatterebbe mai e la funzione tornerebbe una
      // risposta vuota, cioè un "tutto bene" su una spedizione che non è
      // avvenuta. È un bug del chiamante (chi non ha device attivi non deve
      // accodare una consegna push) e va detto forte.
      if (tokens.length === 0) {
        throw new PushRelayRejected("nessun token da raggiungere");
      }
      const results: PushRelaySendResponse["results"] = [];
      for (const group of chunk(tokens)) {
        const res = await sendChunk(group, payload);
        results.push(...res.results);
      }
      return { results };
    },
  };
}
