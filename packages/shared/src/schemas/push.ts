import { z } from "zod";
import { pushTokenSchema } from "./notification.js";

/**
 * IL CONTRATTO PUBBLICO FRA UN'ISTANZA STUBWISE E IL RELAY PUSH.
 *
 * Il modello è RELAY-ONLY: l'app sugli store è una sola (la nostra), quindi le
 * chiavi APNs/FCM sono legate alla NOSTRA identità e vivono solo nel relay.
 * Nessuna istanza parla con APNs o FCM: tutte chiamano
 * `POST <relay>/v1/send` con questi schemi.
 *
 * ⚠️ **È l'unico schema del repo i cui due capi si deployano da soli.** Server,
 * worker e SPA viaggiano nella stessa immagine e si aggiornano insieme; qui no:
 * un'istanza self-hosted aggiorna quando vuole, il relay lo aggiorniamo noi, e
 * nel mezzo un relay nuovo parla con istanze vecchie e viceversa. Da qui due
 * regole che non si negoziano:
 *
 *  1. **Solo cambi ADDITIVI**, e in ENTRAMBE le direzioni (richiesta e
 *     risposta): un campo si aggiunge OPZIONALE, non si toglie e non cambia
 *     tipo. La versione sta nel path (`/v1/send`): una rottura vera è un `/v2`,
 *     non una modifica qui.
 *  2. **Nessuno `.strict()`.** Gli oggetti di Zod SCARTANO le chiavi ignote, ed
 *     è esattamente ciò che serve: un'istanza più nuova che manda un campo che
 *     questo relay non conosce si vede la push consegnata invece di un 400, e
 *     un relay più nuovo che aggiunge un campo alla risposta non fa fallire il
 *     parse delle istanze già installate. Chi aggiungesse `.strict()` "per
 *     rigore" renderebbe rompente ogni futura aggiunta.
 *
 * Nota per chi cerca i guardiani di `reader.ts`: `data` è un `z.record`, cioè
 * uno dei nodi che `readerSchema` non attraversa. Non accende nulla perché quel
 * guardiano raccoglie i soli schemi di RISPOSTA passati come quarto argomento a
 * `request` in `@stubwise/api-client`, e questi non ci passano: il relay non è
 * l'API di Stubwise e il mobile non lo chiama mai. Se un giorno una rotta del
 * server restituisse uno di questi schemi, il guardiano si accenderebbe — ed è
 * il comportamento voluto, non un falso allarme da mettere a tacere.
 */

/** Quanti token stanno in UNA chiamata a `/v1/send`. */
export const PUSH_RELAY_MAX_TOKENS = 20;

/**
 * Tetti di `title` e `body`, in CARATTERI.
 *
 * Il vincolo vero è il payload che APNs e FCM accettano: **4096 byte** per una
 * notifica normale (oltre, APNs risponde `PayloadTooLarge` e FCM
 * `invalid-argument`). Il conto: 100 + 500 unità UTF-16 al caso peggiore per
 * questa misura — un carattere BMP da 3 byte, tipo il CJK — fanno 1800 byte,
 * cui si aggiungono i ~200 byte di `data` e l'impalcatura JSON. Si resta sotto
 * la metà del limite.
 *
 * Il tetto è quindi in CARATTERI e non in byte, al contrario di quello del
 * token push (vedi `PUSH_TOKEN_MAX_BYTES` in `./notification.ts`), e la
 * differenza è tutta nel margine: là il muro era a 2704 byte con un tetto di
 * 1024, cioè un fattore 2,6 che i 3 byte per carattere del CJK sfondavano; qui
 * il muro è a 4096 con un carico di 1800, e nessuna codifica lo raggiunge.
 */
export const PUSH_TITLE_MAX_CHARS = 100;
export const PUSH_BODY_MAX_CHARS = 500;

/**
 * Tetto di `collapseId`: l'header `apns-collapse-id` di APNs ammette al massimo
 * 64 byte. Il valore che ci mettiamo è un uuid (36 caratteri ASCII), quindi il
 * tetto non morde mai — c'è perché il contratto non deve poter produrre una
 * richiesta che APNs rifiuta.
 */
export const PUSH_COLLAPSE_ID_MAX_CHARS = 64;

/** Servizio di push del sistema operativo del device. */
export const pushPlatformSchema = z.enum(["ios", "android"]);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

/**
 * Un device da raggiungere: la piattaforma dice al relay a quale servizio
 * inoltrare, il token è quello registrato dall'app.
 *
 * `token` RIUSA lo schema della registrazione (`PUT /api/me/devices`), e non è
 * un vezzo di fattorizzazione: è l'invariante «un token registrabile è sempre
 * spedibile». Se i due tetti divergessero esisterebbe un device che si registra
 * senza errori e che il relay poi rifiuta con un 400 — cioè una consegna
 * `failed` per sempre, senza che nulla lo segnali all'utente. Un test in
 * `push.test.ts` confronta le due validazioni sugli stessi valori.
 */
export const pushRelayTokenSchema = z.object({
  platform: pushPlatformSchema,
  token: pushTokenSchema,
});
export type PushRelayToken = z.infer<typeof pushRelayTokenSchema>;

/**
 * Il contenuto della notifica, nella forma che il relay traduce in `aps` per
 * APNs e in `message` per FCM.
 *
 * `data` è una mappa di sole STRINGHE perché `Message.data` di FCM v1 è
 * `map<string,string>`: numeri, booleani e oggetti annidati vanno serializzati
 * dal mittente. APNs sarebbe più permissivo (le chiavi custom accettano JSON
 * qualsiasi), ma il contratto è l'INTERSEZIONE dei due servizi — altrimenti la
 * stessa notifica arriverebbe su iOS e fallirebbe su Android.
 *
 * `category` è il `kind` della notifica: su iOS diventa la
 * `UNNotificationCategory` (i bottoni dell'azione rapida), su Android il
 * `channel_id`.
 *
 * `collapseId` fa SOSTITUIRE sul telefono una notifica precedente con lo stesso
 * id invece di accodarne una seconda; `threadId` le raggruppa (il progetto).
 */
export const pushPayloadSchema = z.object({
  title: z.string().min(1).max(PUSH_TITLE_MAX_CHARS),
  body: z.string().max(PUSH_BODY_MAX_CHARS),
  category: z.string().min(1).max(64),
  data: z.record(z.string(), z.string()),
  /** Pallino sull'icona dell'app: le notifiche non lette del destinatario. */
  badge: z.number().int().nonnegative().optional(),
  threadId: z.string().min(1).max(64).optional(),
  collapseId: z.string().min(1).max(PUSH_COLLAPSE_ID_MAX_CHARS).optional(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * Body di `POST <relay>/v1/send`: gli stessi contenuti verso più device dello
 * STESSO destinatario (telefono e tablet), in una chiamata sola.
 *
 * Il tetto su `tokens` è del contratto, non del chiamante: chi ne ha di più
 * spezza in più chiamate (lo fa `createPushRelayClient`). Vedi
 * {@link PUSH_RELAY_MAX_TOKENS}.
 */
export const pushRelaySendRequestSchema = z.object({
  tokens: z.array(pushRelayTokenSchema).min(1).max(PUSH_RELAY_MAX_TOKENS),
  payload: pushPayloadSchema,
});
export type PushRelaySendRequest = z.infer<typeof pushRelaySendRequestSchema>;

/**
 * Esito per singolo token:
 *  - `ok` — accettata dal servizio di push;
 *  - `invalid_token` — il token non esiste più (app disinstallata, token
 *    ruotato): il chiamante DEVE disabilitare quel device, non ritentare;
 *  - `retry` — guasto transitorio (5xx di APNs/FCM, rate limit): si ritenta.
 */
export const pushRelayResultStatusSchema = z.enum(["ok", "invalid_token", "retry"]);
export type PushRelayResultStatus = z.infer<typeof pushRelayResultStatusSchema>;

/**
 * Risposta di `/v1/send`: un esito per token, nello stesso ordine della
 * richiesta. `reason` è diagnostica leggibile, mai un dato su cui ramificare.
 *
 * L'enum qui NON si apre col `readerSchema`: quello serve al mobile, che si
 * aggiorna dagli store. Il relay lo deployiamo noi, e uno stato che non
 * conosciamo è un bug di contratto che il poller deve vedere — non qualcosa da
 * trattare in silenzio come "ok".
 */
export const pushRelaySendResponseSchema = z.object({
  results: z.array(
    z.object({
      token: z.string().min(1),
      status: pushRelayResultStatusSchema,
      reason: z.string().optional(),
    }),
  ),
});
export type PushRelaySendResponse = z.infer<typeof pushRelaySendResponseSchema>;
