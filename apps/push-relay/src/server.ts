/**
 * IL RELAY: `POST /v1/send`, e nient'altro di interessante.
 *
 * È il servizio con la superficie più piccola e il valore più alto di tutto il
 * sistema — tiene le chiavi APNs/FCM legate alla NOSTRA identità di publisher —
 * quindi tutto qui dentro è scritto per NON sapere niente di più del necessario
 * e per non lasciare tracce:
 *
 *  - **Nessun log del payload e nessun log dei token.** Nei log vanno conteggi
 *    e stati. Il relay vede il contenuto reale delle notifiche di OGNI istanza
 *    Stubwise (titoli di ticket, domande dell'agente): scriverlo su disco
 *    trasformerebbe un servizio di transito in un archivio.
 *  - **Nessuno stato oltre i contatori del rate limit**, che stanno in memoria
 *    e muoiono col processo (vedi {@link createTokenLimiter}).
 *  - **Nessuna autenticazione**, ed è una scelta: il token del device È la
 *    credenziale. Chi non ha un token non raggiunge nessun telefono, e chi ce
 *    l'ha lo ha già. Le difese sono il rate limit e il tetto sul corpo.
 */
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import {
  pushRelaySendRequestSchema,
  type PushPlatform,
  type PushRelaySendResponse,
} from "@stubwise/shared";
import type { RelayConfig } from "./config.js";
import type { PushClient, PushSendResult } from "./outcome.js";

/**
 * Tetto del corpo: 16 KB.
 *
 * Il massimo legittimo è molto sotto — 20 token da 1 KB più un payload da ~2 KB
 * — ma il tetto serve a rifiutare PRIMA di parsare, non a misurare il caso
 * normale.
 */
const BODY_LIMIT_BYTES = 16 * 1024;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Quanti token distinti il limitatore tiene in memoria.
 *
 * Senza tetto, un flusso di token inventati (il tetto per IP ne concede 600×20
 * al minuto) farebbe crescere la mappa fino all'OOM: il relay morirebbe e con
 * lui le push di tutte le istanze. Oltre il tetto si buttano le voci più
 * vecchie, il che vuol dire che **sotto flood il limite per token si può
 * aggirare** — è accettato, perché in quello scenario la difesa vera è il tetto
 * per IP (funziona perché `trustProxy: 1` fa leggere a Fastify l'IP del
 * client reale dietro Caddy, non quello — sempre uguale — di Caddy stesso:
 * vedi il commento su `Fastify({ trustProxy: 1, ... })` qui sotto), e perdere
 * il conteggio è meglio che perdere il processo.
 */
export const MAX_TRACKED_TOKENS = 100_000;

export interface TokenLimiter {
  /** `true` se l'invio può partire; `false` se il token ha esaurito la quota. */
  take(token: string): boolean;
  /** Quanti token il limitatore sta tracciando. Serve a sorvegliare il tetto. */
  size(): number;
}

/**
 * Contatore a FINESTRA SCORREVOLE per token, in memoria.
 *
 * ⚠️ **NON SCALA OLTRE UN PROCESSO, ed è deliberato in v1.** Il conteggio vive
 * nell'heap di questo processo: a ogni RIAVVIO riparte da zero (una finestra
 * perdonata, il che è il verso giusto in cui sbagliare — un riavvio non deve
 * bloccare notifiche legittime), e con DUE repliche ogni token avrebbe due
 * budget indipendenti, cioè il doppio del tetto dichiarato. Se un giorno il
 * relay dovrà girare in più istanze, questo modulo va sostituito con un
 * contatore condiviso (Redis) — non aggirato mettendo un load balancer davanti
 * e sperando nell'affinità. Il tipo {@link TokenLimiter} esiste apposta per
 * rendere quella sostituzione un cambio di implementazione.
 *
 * ⚠️ La chiave è lo **SHA-256 del token**, non il token. Non è cifratura (il
 * token è nella richiesta comunque): serve a garantire che la struttura dati
 * più longeva del processo non contenga credenziali in chiaro, così un heap
 * dump o un futuro log diagnostico di questa mappa non possano diventare una
 * fuga di token.
 *
 * Gli istanti sono tenuti in un array per chiave: è limitato dal tetto
 * giornaliero (si registra solo un invio CONCESSO), quindi non può crescere
 * oltre `perTokenDay` elementi.
 */
export function createTokenLimiter(
  rate: RelayConfig["rate"],
  now: () => number = Date.now,
  maxTrackedTokens: number = MAX_TRACKED_TOKENS,
): TokenLimiter {
  const hits = new Map<string, number[]>();

  function evictIfNeeded(): void {
    if (hits.size <= maxTrackedTokens) return;
    const cutoff = now() - DAY_MS;
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1]! <= cutoff) hits.delete(key);
    }
    // Ancora sopra: si buttano le voci meno recenti (la Map itera in ordine
    // d'inserimento e ogni aggiornamento re-inserisce, quindi è un LRU povero).
    for (const key of hits.keys()) {
      if (hits.size <= maxTrackedTokens) break;
      hits.delete(key);
    }
  }

  return {
    size: () => hits.size,
    take(token) {
      const key = createHash("sha256").update(token).digest("hex");
      const current = now();
      const dayCutoff = current - DAY_MS;
      const hourCutoff = current - HOUR_MS;

      const previous = hits.get(key) ?? [];
      const withinDay = previous.filter((stamp) => stamp > dayCutoff);
      const withinHour = withinDay.filter((stamp) => stamp > hourCutoff);

      if (withinHour.length >= rate.perTokenHour || withinDay.length >= rate.perTokenDay) {
        // Si riscrive comunque la finestra potata, così le voci vecchie non
        // restano appese a un token che continua a bussare.
        hits.delete(key);
        hits.set(key, withinDay);
        return false;
      }

      withinDay.push(current);
      hits.delete(key);
      hits.set(key, withinDay);
      evictIfNeeded();
      return true;
    },
  };
}

export interface BuildRelayOptions {
  config: RelayConfig;
  /** `null` quando le credenziali APNs non ci sono (il caso normale in v1). */
  apns: PushClient | null;
  fcm: PushClient;
  /** Iniettabile nei test, per ispezionare ciò che finisce nei log. */
  loggerStream?: { write(line: string): void };
  limiter?: TokenLimiter;
}

export function buildRelay({
  config,
  apns,
  fcm,
  loggerStream,
  limiter = createTokenLimiter(config.rate),
}: BuildRelayOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: loggerStream ? { level: "info", stream: loggerStream } : { level: "info" },
    /**
     * `1`, non `true`. Il relay non pubblica nessuna porta: ci arriva SOLO
     * Caddy dalla rete interna (vedi `caddy.d/relay.caddy.example`), quindi
     * c'è esattamente UN hop fidato fra il client reale e questo processo.
     * `trustProxy: 1` fa sì che `request.ip` sia l'ultimo indirizzo della
     * catena `X-Forwarded-For` — quello che Caddy stesso ha annesso — così
     * il rate limit "per IP" distingue davvero le istanze fra loro invece di
     * vederle tutte come lo stesso IP (quello di Caddy).
     *
     * `true` sarebbe SBAGLIATO qui: significherebbe fidarsi dell'INTERA
     * catena `X-Forwarded-For`, che un client può scrivere lui stesso —
     * basterebbe anteporre un hop finto per scegliersi un bucket diverso a
     * ogni richiesta e aggirare il limite. Con `1` conta solo l'ultimo
     * indirizzo, quello che SOLO Caddy può aver annesso.
     */
    trustProxy: 1,
  });

  /**
   * A quale servizio va un token.
   *
   * ⚠️ In v1 anche iOS passa da FCM: l'app usa Firebase Messaging su entrambe
   * le piattaforme, quindi un token registrato con `platform: "ios"` è un token
   * FCM che Firebase inoltra ad APNs. Il client APNs diretto si accende con
   * `IOS_PUSH_VIA=apns` e serve alla fase 4b (token APNs nativi + Notification
   * Service Extension). Vedi il docblock di `RelayConfig.iosPushVia` per il
   * perché il default è questo e non l'altro.
   */
  function clientFor(platform: PushPlatform): PushClient | null {
    if (platform === "android") return fcm;
    return config.iosPushVia === "apns" ? apns : fcm;
  }

  app.get("/healthz", async () => ({ status: "ok" }));

  /**
   * `/v1/send` sta in un plugin incapsulato per un motivo preciso: il tetto per
   * IP di `@fastify/rate-limit` si applica per rotta solo se il plugin ha FINITO
   * di registrarsi PRIMA che la rotta esista — è un hook `onRoute`, e le rotte
   * dichiarate nello stesso giro sincrono di `register` gli passano davanti
   * senza che nulla lo segnali (nessun errore, semplicemente nessun limite, e
   * nemmeno gli header `x-ratelimit-*`). Verificato: senza l'`await` qui dentro
   * la 3ª richiesta con tetto 2 rispondeva ancora 200.
   *
   * L'incapsulamento tiene fuori `/healthz`: una probe non deve poter esaurire
   * la quota, né essere rifiutata quando qualcun altro l'ha esaurita.
   */
  app.register(async (instance) => {
    await instance.register(rateLimit, { global: false });

    instance.post(
      "/v1/send",
      {
        config: {
          rateLimit: { max: config.rate.perIpMinute, timeWindow: "1 minute" },
        },
      },
      async (request, reply) => {
        const parsed = pushRelaySendRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          /**
           * Si risponde 400 SENZA rimandare indietro né i dettagli di Zod né il
           * corpo: i percorsi dei campi sarebbero utili al chiamante, ma questo
           * è un endpoint pubblico e l'unico chiamante legittimo valida già in
           * casa sua (`createPushRelayClient` fa lo stesso `safeParse` prima di
           * partire). Nel log va il solo CONTEGGIO dei problemi.
           */
          request.log.info({ issues: parsed.error.issues.length }, "richiesta fuori contratto");
          return reply.code(400).send({ error: "invalid_request" });
        }

        const { tokens, payload } = parsed.data;
        const results: PushRelaySendResponse["results"] = await Promise.all(
          tokens.map(async ({ platform, token }) => {
            /**
             * Il tetto per token NON fa fallire la richiesta: risponde `retry`
             * per quel token e lascia passare gli altri.
             *
             * ⚠️ È il vincolo che viene dal client: oltre 20 token spezza in più
             * chiamate e, se un gruppo fallisce, il poller ritenta l'INTERA
             * consegna — quindi il relay vede invii duplicati per i token già
             * serviti. Un 429 sull'intera richiesta punirebbe anche i token che
             * non hanno superato nulla, e trasformerebbe un retry legittimo in un
             * blocco. `retry` invece è esattamente ciò che il poller sa gestire:
             * riprova più tardi, col backoff.
             */
            if (!limiter.take(token)) {
              return { token, status: "retry" as const, reason: "rate_limited" };
            }

            // La quota si consuma PRIMA di sapere se il client esiste, ed è
            // voluto: così ogni percorso della rotta è limitato, anche quello
            // che finisce in `failed` per configurazione mancante. Invertire
            // l'ordine aprirebbe un percorso non limitato.
            const client = clientFor(platform);
            if (client === null) {
              // iOS instradato su APNs senza credenziali: permanente e nostro.
              // Un `ok` qui perderebbe la notifica in silenzio.
              return { token, status: "failed" as const, reason: "apns not configured" };
            }

            let outcome: PushSendResult;
            try {
              outcome = await client.send(token, payload);
            } catch {
              /**
               * Il guasto di UN token non deve buttare giù gli altri della stessa
               * richiesta, quindi si cattura per token e non attorno alla
               * `Promise.all`. Messaggio FISSO: l'eccezione può portarsi dietro
               * URL e corpo della richiesta, cioè il token.
               */
              return { token, status: "retry" as const, reason: "relay error" };
            }
            return outcome.reason === undefined
              ? { token, status: outcome.status }
              : { token, status: outcome.status, reason: outcome.reason };
          }),
        );

        // Nel log SOLO i conteggi per esito: né token, né titoli, né corpi.
        const counts: Record<string, number> = {};
        for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
        request.log.info({ tokens: tokens.length, counts }, "consegna inoltrata");

        return reply.send({ results } satisfies PushRelaySendResponse);
      },
    );
  });

  return app;
}
