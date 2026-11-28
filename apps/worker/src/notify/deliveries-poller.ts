import {
  aiJobs,
  deviceTokens,
  notificationDeliveries,
  notifications,
  users,
  type Db,
  type NotificationDelivery,
} from "@stubwise/db";
import type { Language } from "@stubwise/i18n";
import {
  actionsFor,
  buildPushPayload,
  loadSettings,
  notificationVisibleToRecipient,
  PushRelayRejected,
  sendWebhookEvent,
  unreadCount,
  type DbOrTx,
  type NotificationEvent,
  type PushRelayClient,
  contentLanguageOf,
  sendableWebhook,
  webhookWantsKind,
  sendToWebhook,
  type SendableWebhook,
} from "@stubwise/notifications";
import type { PushPlatform, PushRelaySendResponse } from "@stubwise/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * POLLER DELL'OUTBOX delle notifiche (`notification_deliveries`): task SEPARATO
 * dal loop dei job, sul proprio intervallo breve (default 5"), stesso pattern
 * degli altri poller del worker (backlog, review, graph).
 *
 * `publishNotification` (packages/notifications) NON invia nulla: scrive l'inbox
 * per-utente e una riga di outbox per canale, con il GATING dei toggle già
 * applicato al publish. Qui si prendono le consegne DOVUTE e si spediscono. Il
 * gating NON si rifà: una riga in outbox è, per costruzione, una consegna
 * decisa.
 *
 * CANALI:
 *  - `webhook` — il webhook d'istanza, per EVENTO: nessuna notifica dietro,
 *    payload nella colonna `event`;
 *  - `push` — la notifica sui telefoni del destinatario, spedita al RELAY
 *    (nessuna istanza parla con APNs o FCM). Una consegna per destinatario,
 *    non per device: i device attivi si leggono al momento dell'invio.
 *
 * `slack_dm` e `slack_update` (i DM Slack) sono andati via con R2, le loro
 * righe con la 0246 (R3): un canale che il poller non conosce lo chiude
 * `skipped`.
 *
 * SCELTA TRANSAZIONALE (il claim PRE-SCHEDULA il ritentativo, l'invio sta fuori
 * dalla transazione): {@link claimDue} è un UPDATE unico che, nello stesso atto
 * con cui prende le righe dovute, incrementa `attempts` e sposta
 * `next_attempt_at` a `now() + backoff(attempts)`. L'invio HTTP avviene DOPO,
 * fuori da qualunque transazione (tenere aperta una transazione per la durata di
 * un POST di rete significherebbe lock lunghi e connessioni del pool bloccate).
 * Conseguenze, tutte volute:
 *  - due poller concorrenti non prendono mai la stessa riga: `FOR UPDATE SKIP
 *    LOCKED` li rende disgiunti nell'istante del claim e, subito dopo il commit,
 *    la riga non è più "dovuta" (next_attempt_at nel futuro) per nessun altro;
 *  - se il worker MUORE a metà invio la riga resta `pending` con `attempts` già
 *    incrementato e `next_attempt_at` fra 30s×2^n: viene ritentata al risveglio,
 *    NESSUNA consegna si perde per sempre (è l'unica proprietà che ci serve);
 *  - il prezzo è un possibile DOPPIO INVIO (crash dopo il POST ma prima di
 *    marcare `sent`). Accettabile per il webhook: at-least-once, non
 *    exactly-once (nota esplicita del piano).
 *
 * ESITI: successo → `sent` + `sent_at`; errore → `pending` (ritentativo già
 * schedulato) finché `attempts < MAX_ATTEMPTS`, poi `failed` con l'errore.
 * Eccezione: se l'invio fallisce e il webhook risulta NON (più) configurato la
 * consegna è `skipped`, non si bruciano 5 tentativi su una destinazione che non
 * esiste (raccomandazione della review del Task 4). Il caso si riconosce
 * rileggendo la config invece di confrontare il messaggio dell'errore
 * (`sendWebhookEvent` lancia "Nessun webhook configurato."): la config è la
 * verità, e la rilettura costa una query solo sui fallimenti.
 *
 * BEST-EFFORT come gli altri poller: ogni consegna in try/catch isolato, il tick
 * a sua volta; non fa MAI crashare il worker. Si ferma sull'AbortSignal.
 */

/** Tentativi massimi di una consegna prima di dichiararla `failed`. */
export const MAX_ATTEMPTS = 5;

/** Base del backoff esponenziale: 30s, 60s, 120s, 240s… */
const BACKOFF_BASE_SECONDS = 30;

/** Quante consegne al massimo per tick. */
const DEFAULT_LIMIT = 20;

/** Attesa (ms) prima del tentativo numero `attempt` (0-based). */
export function backoffMs(attempt: number): number {
  return BACKOFF_BASE_SECONDS * 1000 * 2 ** attempt;
}

/** Logger minimo del worker (stesso contratto degli altri poller). */
export interface DeliveriesLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Invio sul canale webhook. Default {@link sendWebhookEvent}, fake nei test. */
export type SendWebhookFn = (db: Db, event: NotificationEvent) => Promise<void>;

export interface DeliveriesPollerDeps {
  db: Db;
  logger: DeliveriesLogger;
  /** Chiave delle instance settings (la stessa del server): decifra il segreto dei webhook. */
  encryptionKey: Buffer;
  /** Invio webhook iniettabile nei test. Default sendWebhookEvent. */
  sendWebhook?: SendWebhookFn;
  /**
   * Area 9, F3: l'invio a UN webhook (col suo formato e la sua firma),
   * iniettabile nei test. Default `sendToWebhook` di `@stubwise/notifications`.
   */
  sendToWebhook?: (webhook: SendableWebhook, event: NotificationEvent, lang: "en" | "it") => Promise<unknown>;
  /**
   * Client del relay push, costruito all'avvio dal `PUSH_RELAY_URL`.
   * `null`/assente = PUSH SPENTE: la consegna si chiude `skipped push_disabled`
   * invece di restare pending per sempre. Non c'è un default che vada in rete —
   * al contrario del webhook — perché il relay è una destinazione CONFIGURATA:
   * chi non l'ha configurata non deve scoprirlo con un POST.
   */
  pushRelay?: PushRelayClient | null;
  /** Consegne massime per tick. Default 20. */
  limit?: number;
  /** Stop cooperativo: interrompe il giro a metà. */
  signal?: AbortSignal;
  /**
   * PUBLIC_URL, per i link che si DERIVANO a lettura invece di stare
   * nell'evento (`openUrl`: l'avviso di sicurezza). Assente = nessun link.
   */
  publicUrl?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reclama le consegne DOVUTE (`pending` con `next_attempt_at` passato) e, nello
 * stesso UPDATE, incrementa i tentativi e schedula il prossimo ritentativo (vedi
 * "SCELTA TRANSAZIONALE" nel docblock del modulo).
 *
 * `FOR UPDATE SKIP LOCKED` nella subquery: due worker non prendono mai la stessa
 * riga. L'ORDER BY è su `next_attempt_at` — la stessa colonna dell'indice
 * parziale `WHERE status='pending'` — così il claim resta un index scan e non un
 * sort su tutta la tabella (raccomandazione della review del Task 1: NON
 * ordinare per `created_at`).
 */
export async function claimDue(db: Db, limit = DEFAULT_LIMIT): Promise<NotificationDelivery[]> {
  return db
    .update(notificationDeliveries)
    .set({
      attempts: sql`${notificationDeliveries.attempts} + 1`,
      nextAttemptAt: sql`now() + make_interval(secs => ${BACKOFF_BASE_SECONDS} * power(2, ${notificationDeliveries.attempts}))`,
    })
    .where(
      sql`${notificationDeliveries.id} IN (
        SELECT id FROM notification_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/**
 * Chiude una consegna in uno stato terminale. Status-guarded su `pending`: se
 * nel frattempo la riga è cambiata (non dovrebbe: l'abbiamo reclamata noi)
 * l'UPDATE non tocca nulla invece di sovrascrivere.
 */
async function finish(
  db: DbOrTx,
  id: string,
  status: "sent" | "failed" | "skipped",
  error: string | null,
): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({
      status,
      error,
      ...(status === "sent" ? { sentAt: sql`now()` } : {}),
    })
    .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, "pending")));
}

/** Registra un fallimento ritentabile: resta `pending` (il claim ha già schedulato). */
async function keepPending(db: DbOrTx, id: string, error: string): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({ error })
    .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, "pending")));
}

/**
 * Il webhook d'istanza è configurato? Se no, ritentare è inutile.
 *
 * Guarda SOLO `webhookUrl`, deliberatamente NON `enabled` (né i toggle per
 * kind): il gating on/off si decide al publish, e una consegna già in outbox è
 * una decisione già presa. Spegnere l'interruttore generale mentre una consegna
 * è in volo la lascia quindi al suo destino di ritentativi — non è una
 * destinazione inesistente, è solo un invio in corso. Manca invece l'URL
 * (`sendWebhookEvent` lancia "Nessun webhook configurato.") ⇒ non c'è dove
 * consegnare, e bruciare 5 tentativi non serve a nulla.
 */
async function webhookConfigured(db: Db): Promise<boolean> {
  try {
    const settings = await loadSettings(db);
    return Boolean(settings?.webhookUrl);
  } catch {
    // Config illeggibile: non è una prova che il webhook non esista → ritenta.
    return true;
  }
}

/**
 * Processa UNA consegna già reclamata. Non lancia: qualunque errore diventa uno
 * stato sulla riga.
 */
async function processDelivery(
  deps: DeliveriesPollerDeps,
  tick: TickContext,
  row: NotificationDelivery,
): Promise<void> {
  const { db } = deps;
  if (row.channel === "push") {
    await processPushDelivery(deps, tick, row);
    return;
  }
  if (row.channel !== "webhook") {
    // Canale non gestito qui (uno aggiunto all'enum, o `slack_dm`/`slack_update`
    // rimasti in coda dopo il ritiro di Slack, R2): meglio una consegna
    // dichiaratamente non gestita che una riga pending che il poller riguarda
    // per sempre (o, peggio, trattata come un webhook).
    await finish(db, row.id, "skipped", "channel_not_implemented");
    return;
  }
  if (!row.event) {
    // Impossibile per il CHECK `notification_deliveries_webhook_event_chk`, ma
    // il tipo lo ammette: riga malformata → terminale, non ritentabile.
    await finish(db, row.id, "failed", "webhook delivery senza event");
    return;
  }

  // Il cast è il punto in cui il jsonb torna il tipo forte dell'unione: è
  // `publishNotification` ad averlo scritto da un NotificationEvent.
  const event = row.event as unknown as NotificationEvent;

  // Area 9, F3: la consegna di UN webhook (dalla 0188), col suo formato e il
  // suo segreto. Spento nel frattempo: si chiude senza invio (eliminato: la
  // consegna è già sparita in cascata). Un errore ritenta SOLO questa
  // consegna, così un webhook che fallisce non ferma gli altri.
  if (row.webhookId) {
    // Tutto dentro il try, lettura e decifratura comprese (review di F3): un
    // segreto che non si decifra o un errore del DB ritentano e, al tetto,
    // chiudono la consegna `failed`, invece di lasciarla pending per sempre.
    try {
      const webhook = await sendableWebhook(db, row.webhookId, deps.encryptionKey);
      if (!webhook) {
        await finish(db, row.id, "skipped", "webhook_disabled");
        return;
      }
      // Rimandi, lotto 4: l'evento è stato tolto dal webhook dopo l'accodamento.
      if (!webhookWantsKind(webhook, event.kind)) {
        await finish(db, row.id, "skipped", "event_not_selected");
        return;
      }
      await (deps.sendToWebhook ?? sendToWebhook)(webhook, event, await contentLanguageOf(db));
      await finish(db, row.id, "sent", null);
    } catch (err) {
      await retryOrFail(deps, row, errText(err));
    }
    return;
  }

  // Una consegna di PRIMA della 0188 (senza webhook): il percorso di allora.
  const send = deps.sendWebhook ?? sendWebhookEvent;
  try {
    await send(db, event);
    await finish(db, row.id, "sent", null);
  } catch (err) {
    const error = errText(err);
    if (!(await webhookConfigured(db))) {
      // Esito TERMINALE silenzioso altrimenti: senza questo log l'unica traccia
      // sarebbe una riga di DB che nessuno guarda.
      deps.logger.warn(
        { deliveryId: row.id, channel: row.channel, error },
        "[notify] consegna skipped: webhook non configurato",
      );
      await finish(db, row.id, "skipped", error);
      return;
    }
    await retryOrFail(deps, row, error);
  }
}

/**
 * Esito di un invio fallito RITENTABILE: resta `pending` finché ci sono
 * tentativi, poi `failed`. Condiviso dai canali.
 */
async function retryOrFail(
  deps: DeliveriesPollerDeps,
  row: NotificationDelivery,
  error: string,
  /**
   * Dove scrivere. Il canale push passa la sua transazione: la disabilitazione
   * dei device e l'esito della consegna devono muoversi insieme (vedi
   * {@link applyPushOutcome}).
   */
  db: DbOrTx = deps.db,
): Promise<void> {
  // `attempts` è già quello POST-claim: al quinto tentativo si chiude.
  if (row.attempts >= MAX_ATTEMPTS) {
    // Notifica definitivamente persa: deve comparire nei log del worker, non
    // solo nella colonna `error` della riga.
    deps.logger.warn(
      { deliveryId: row.id, channel: row.channel, attempts: row.attempts, error },
      "[notify] consegna failed dopo MAX_ATTEMPTS",
    );
    await finish(db, row.id, "failed", error);
    return;
  }
  await keepPending(db, row.id, error);
}

// --- Consegne per destinatario --------------------------------------------

/** Stato condiviso da tutte le consegne di UN tick. */
interface TickContext {
  /**
   * Vero la PRIMA volta che lo si chiama in questo tick: serve a loggare UNA
   * SOLA riga per le push spente, non una per consegna.
   *
   * `PUSH_RELAY_URL=` è l'interruttore documentato del rollback, cioè uno
   * stato STABILE: su un'istanza con dieci telefoni sarebbero dieci warn per
   * notifica, per sempre, e un log che si ripete così smette di essere letto.
   */
  firstPushDisabled(): boolean;
}

function createTickContext(): TickContext {
  let pushDisabledLogged = false;
  return {
    firstPushDisabled() {
      if (pushDisabledLogged) return false;
      pushDisabledLogged = true;
      return true;
    },
  };
}

/** La notifica dietro una consegna per-destinatario, col suo destinatario. */
interface DeliveryRecipient {
  notificationId: string;
  userId: string;
  kind: NotificationKindColumn;
  event: Record<string, unknown>;
  ticketId: string | null;
  /**
   * Progetto della notifica (nullable: i kind d'istanza non ne hanno uno).
   * Serve al canale push come `threadId`, cioè al raggruppamento delle
   * notifiche sul telefono. L'evento porta il NOME del progetto, non l'id.
   */
  projectId: string | null;
  /**
   * Richiedente del job dietro la notifica (`null` sui run dell'automazione e
   * sugli eventi senza job): decide chi può rispondere a una domanda
   * dell'agente, che non è solo un permesso di progetto.
   */
  requestedByUserId: string | null;
  language: Language;
}

/** Il `kind` come lo tipizza la colonna enum (già valido: lo garantisce il DB). */
type NotificationKindColumn = Parameters<typeof actionsFor>[0]["kind"];

/** Legge la notifica e il destinatario di una consegna per-destinatario. */
async function loadRecipient(db: Db, notificationId: string): Promise<DeliveryRecipient | null> {
  const [row] = await db
    .select({
      notificationId: notifications.id,
      userId: notifications.userId,
      kind: notifications.kind,
      event: notifications.event,
      ticketId: notifications.ticketId,
      projectId: notifications.projectId,
      // LEFT JOIN sul job della notifica (nullo sugli eventi d'istanza): una
      // colonna in più nella query che c'era già, non una query in più.
      requestedByUserId: aiJobs.requestedByUserId,
      language: users.language,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(aiJobs, eq(aiJobs.id, notifications.jobId))
    .where(eq(notifications.id, notificationId));
  return row ?? null;
}

/**
 * Il destinatario VEDE ancora la card? È il filtro a lettura dell'inbox
 * (`notificationVisibleToRecipient`), riletto al momento dell'invio: fra la
 * publish e la consegna può essere uscito dal progetto, e un DM o una push di
 * una card che in inbox non vedrebbe gli porterebbe proprio ciò che la revoca
 * gli toglie. Query a sé: il predicato sta nella WHERE, dove le colonne sono
 * qualificate.
 */
async function recipientStillSees(db: Db, notificationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), notificationVisibleToRecipient()));
  return rows.length > 0;
}

// --- Canale push (fase 4) -------------------------------------------------

/**
 * Tetto per SINGOLA chiamata al relay push, molto più stretto dei 10 s di
 * default del client.
 *
 * Non è un'ottimizzazione della latenza della push: è la protezione di TUTTE le
 * altre consegne. Il poller processa fino a 20 righe per tick IN SEQUENZA e con
 * una guardia anti-rientro, quindi col default un relay morto allungherebbe il
 * tick a 200 s — e in quel tick non partirebbero nemmeno i webhook, che
 * stanno nella stessa coda. Il backoff non aiuta: agisce dopo.
 * Il relay è un hop che gestiamo noi e in salute risponde in decine di ms;
 * 3 secondi sono già due ordini di grandezza di margine, e una push tardata di
 * un tick è invisibile mentre un tick fermo non lo è.
 */
export const PUSH_RELAY_TIMEOUT_MS = 3_000;

/**
 * Quanti esiti per-device si scrivono al massimo nella riga. I token stantii si
 * accumulano (un token resta attivo finché una push non torna `invalid_token`),
 * quindi l'elenco non è limitato dal numero di telefoni veri; il resto diventa
 * un `+N`. Ogni `reason` è già troncato a 240 caratteri dal client.
 *
 * ⚠️ Vale 20 come `PUSH_RELAY_MAX_TOKENS` per pura COINCIDENZA, e le due
 * costanti sono indipendenti: quella è il tetto del CONTRATTO (quanti token
 * stanno in una chiamata, oltre i quali il client spezza in più chiamate),
 * questa è quanto testo diagnostico ha senso tenere in una colonna. Chi le
 * "unifica" cambia il significato di una delle due — e un `send` da 25 token
 * resta legittimo, con 25 esiti da riassumere.
 */
const PUSH_DETAIL_MAX_ENTRIES = 20;

/** Un device raggiungibile del destinatario. */
interface ActiveDevice {
  id: string;
  platform: PushPlatform;
  token: string;
}

/**
 * I device ATTIVI del destinatario, letti al momento dell'invio.
 *
 * Il predicato è `disabled_at IS NULL` e MAI il motivo — alla lettera quello
 * dell'indice parziale `device_tokens_user_active_idx` e quello di
 * `pushRecipients` al publish. Che la lista possa essere VUOTA anche se al
 * publish non lo era è normale e non è una corsa da chiudere: fra le due letture
 * l'utente può aver revocato il PAT con cui aveva registrato il telefono.
 */
async function activeDevices(db: Db, userId: string): Promise<ActiveDevice[]> {
  return db
    .select({ id: deviceTokens.id, platform: deviceTokens.platform, token: deviceTokens.token })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.disabledAt)));
}

/** Un device con l'esito che il relay gli ha dato. */
interface DeviceOutcome {
  device: ActiveDevice;
  result: PushRelaySendResponse["results"][number] | undefined;
}

/**
 * Riga di diagnostica salvata sulla consegna: un esito PER ID DI DEVICE.
 *
 * ⚠️ **Mai per token.** `results[].token` torna dal relay anche sul percorso di
 * successo, e copiarlo qui scriverebbe i token push in chiaro in
 * `notification_deliveries` — cioè nel DB e in ogni log che ne legge le righe.
 * Da un token push ci si intesta il device di qualcun altro: è lo stesso motivo
 * per cui `POST /api/me/devices/delete` li tiene fuori dal path.
 *
 * PREFISSO FISSO `devices: `, perché in questa colonna convivono tre dialetti:
 * i codici snake_case (`push_disabled`), i messaggi liberi delle eccezioni e
 * questa lista. `error LIKE 'devices:%'` separa «il relay ha risposto, ecco
 * cos'ha detto per ciascun telefono» da «è saltata un'eccezione», che altrimenti
 * si distinguono solo a occhio.
 */
function summarizePushOutcomes(outcomes: DeviceOutcome[]): string {
  const shown = outcomes.slice(0, PUSH_DETAIL_MAX_ENTRIES).map(({ device, result }) => {
    const status = result?.status ?? "no_result";
    return result?.reason ? `${device.id}=${status} (${result.reason})` : `${device.id}=${status}`;
  });
  const rest = outcomes.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
  return `devices: ${list}`;
}

/**
 * Scrive INSIEME le due conseguenze di una spedizione: i device da disabilitare
 * e l'esito della consegna.
 *
 * UNA TRANSAZIONE, e la ragione non è che perderne una sarebbe una catastrofe —
 * entrambi gli stati si riparano da soli al giro dopo (un token morto lasciato
 * attivo torna `invalid_token` alla notifica successiva; una consegna lasciata
 * `pending` si ritenta e il `collapseId` fa sostituire la push già arrivata
 * invece di accodarne una seconda). La ragione è che sono la stessa decisione,
 * presa sulla stessa risposta: separarle vorrebbe dire ammettere uno stato in
 * cui la riga dice «consegnato» e il device dice «vivo» pur essendo morto, e
 * doverlo poi spiegare a chi legge il DB.
 *
 * L'UPDATE dei device è ristretto anche a `disabled_at IS NULL`: se nel
 * frattempo la revoca di un PAT li ha già disabilitati, il suo motivo — che è
 * quello vero — non viene sovrascritto da `invalid_token`.
 */
async function applyPushOutcome(
  deps: DeliveriesPollerDeps,
  row: NotificationDelivery,
  outcomes: DeviceOutcome[],
): Promise<void> {
  const toDisable = outcomes
    .filter(({ result }) => result?.status === "invalid_token")
    .map(({ device }) => device.id);
  const anyOk = outcomes.some(({ result }) => result?.status === "ok");
  const anyRetry = outcomes.some(({ result }) => result?.status === "retry");
  /**
   * Tutti raggiunti = `error` NULL, come su ogni altro canale.
   *
   * Gli altri tre canali scrivono `error = null` su una consegna `sent`: fosse
   * il push l'unico a valorizzarla sempre, `error IS NOT NULL` smetterebbe di
   * significare la stessa cosa nella stessa colonna. Il successo PARZIALE
   * (`id1=ok, id2=failed (PayloadTooLarge)`) resta invece scritto, perché lì
   * qualcosa è andato storto davvero — ed è anche l'unico posto in cui si vede
   * che una push `retry` è stata persa perché un altro device era `ok`. Del
   * caso tutto-ok si perde solo l'elenco dei device raggiunti, che è
   * ricostruibile da `device_tokens`.
   */
  const allOk = outcomes.every(({ result }) => result?.status === "ok");
  // Il riassunto si calcola comunque: serve ai rami che NON sono il tutto-ok,
  // e averlo come stringa invece che come `string | null` toglie un `?? ""` in
  // un punto irraggiungibile — che inviterebbe a credere possibile un caso che
  // non lo è.
  const summary = summarizePushOutcomes(outcomes);
  const detail = allOk ? null : summary;

  await deps.db.transaction(async (tx) => {
    if (toDisable.length > 0) {
      await tx
        .update(deviceTokens)
        .set({ disabledAt: sql`now()`, disabledReason: "invalid_token" })
        .where(and(inArray(deviceTokens.id, toDisable), isNull(deviceTokens.disabledAt)));
    }
    if (anyOk) {
      // Basta UN device raggiunto: la consegna è per DESTINATARIO, e la persona
      // la notifica ce l'ha. Se un altro suo device ha detto `retry`, quella
      // singola push si perde — ritentare l'intera consegna rimanderebbe la
      // stessa notifica ai telefoni che l'hanno già.
      await finish(tx, row.id, "sent", detail);
      return;
    }
    if (anyRetry) {
      // Nessuno raggiunto ma qualcuno da riprovare: il backoff è già schedulato
      // dal claim, e i device appena disabilitati non saranno del giro dopo.
      await retryOrFail(deps, row, summary, tx);
      return;
    }
    // Solo esiti permanenti (`invalid_token`, `failed`): ritentare non
    // cambierebbe nulla, e cinque tentativi a vuoto nasconderebbero il guasto.
    await finish(tx, row.id, "failed", detail);
  });
}

/**
 * Processa UNA consegna push: relay configurato → destinatario → device attivi
 * → payload nella sua lingua → spedizione → conseguenze.
 *
 * CLASSIFICAZIONE DEGLI ERRORI, che è tutto il senso delle due eccezioni del
 * client: {@link PushRelayRejected} è un bug di contratto fra due software che
 * deployiamo noi e chiude subito `failed` (ritentarlo cinque volte non lo
 * farebbe cambiare idea, e il guasto si vedrebbe solo come una notifica che non
 * arriva); tutto il resto — `PushRelayUnavailable` e qualunque imprevisto —
 * passa dal backoff ordinario.
 */
async function processPushDelivery(
  deps: DeliveriesPollerDeps,
  tick: TickContext,
  row: NotificationDelivery,
): Promise<void> {
  const { db } = deps;
  const client = deps.pushRelay;
  if (!client) {
    // Esito terminale altrimenti silenzioso: senza log l'unica traccia sarebbe
    // una riga di DB che nessuno guarda. UNA riga per tick, non una per
    // consegna: vedi `firstPushDisabled`.
    if (tick.firstPushDisabled()) {
      deps.logger.warn(
        { deliveryId: row.id, channel: row.channel },
        "[notify] consegne skipped: push spente (PUSH_RELAY_URL vuota)",
      );
    }
    await finish(db, row.id, "skipped", "push_disabled");
    return;
  }
  if (!row.notificationId) {
    // Impossibile per il CHECK `notification_deliveries_channel_shape_chk`, ma
    // il tipo lo ammette: riga malformata → terminale.
    await finish(db, row.id, "failed", "consegna push senza notificationId");
    return;
  }
  const recipient = await loadRecipient(db, row.notificationId);
  if (!recipient) {
    await finish(db, row.id, "failed", "notifica o destinatario non trovati");
    return;
  }

  if (!(await recipientStillSees(db, recipient.notificationId))) {
    // Come per il DM: una push di una card che in inbox non vedrebbe più.
    await finish(db, row.id, "skipped", "recipient_cannot_see");
    return;
  }

  const devices = await activeDevices(db, recipient.userId);
  if (devices.length === 0) {
    // Al publish ne aveva almeno uno: nel frattempo li ha persi (revoca del
    // PAT, o l'ultima push aveva già disabilitato l'ultimo token). Non è un
    // errore e non c'è dove consegnare: `skipped`.
    await finish(db, row.id, "skipped", "no_active_device");
    return;
  }

  /**
   * Il badge è il numero della campanella di QUESTO destinatario, non un
   * conteggio delle sue push: stessa funzione della rotta `unread-count`.
   *
   * ⚠️ FUORI dal `try` qui sotto, e non è una questione di stile. Il recinto
   * chiude `failed` SENZA RITENTATIVO, e questa riga è una query: una
   * connessione chiusa dal pool o un restart di Postgres a metà tick
   * diventerebbero una notifica persa per sempre, per giunta etichettata
   * «payload non costruibile» — cioè un errore Postgres da cercare nel posto
   * sbagliato. Lasciata qui, la stessa eccezione esce da `processDelivery`, la
   * prende il catch del tick e la riga resta `pending` col backoff già
   * schedulato, esattamente come farebbe fallendo `activeDevices`.
   *
   * UNA QUERY PER CONSEGNA, e va bene così: è un index-only scan su
   * `notifications_user_status_created_idx`, sullo stesso percorso che fa già
   * una chiamata di rete al relay. Memoizzarla per tick risparmierebbe ~zero
   * query nel caso comune (una push per utente per tick) in cambio di una mappa
   * da tenere: se un giorno il tetto per tick crescesse molto, la mossa giusta
   * non è la memo ma un conteggio solo per tutti gli utenti del batch.
   */
  const badge = await unreadCount(db, recipient.userId);

  let payload;
  try {
    const pushGroup = (row.event as { pushGroup?: unknown } | null)?.pushGroup;
    payload = buildPushPayload(recipient.event as unknown as NotificationEvent, recipient.language, {
      notificationId: recipient.notificationId,
      unreadCount: badge,
      projectId: recipient.projectId,
      // Registro, A4 r.169: il gruppo di una menzione di gruppo, scritto nella consegna all'invio.
      ...(typeof pushGroup === "string" ? { group: pushGroup } : {}),
    });
  } catch (err) {
    // RECINTO attorno alla resa dal jsonb: `notifications.event` può essere
    // stato scritto mesi fa da una versione precedente. Qui NON si degrada
    // consegnando col solo `kind`: una push con titolo `push.title.qualcosa` sul
    // telefono è peggio di una push che non arriva, e l'inbox la notifica ce
    // l'ha comunque. Senza questo catch l'eccezione uscirebbe da
    // `processDelivery` e la riga resterebbe `pending` PER SEMPRE:
    // `retryOrFail` non verrebbe mai raggiunto, quindi nessuno la
    // dichiarerebbe `failed` e il claim continuerebbe a ripescarla a ogni
    // scadenza del backoff.
    const error = errText(err);
    deps.logger.warn(
      { deliveryId: row.id, channel: row.channel, error },
      "[notify] consegna push failed: payload non costruibile",
    );
    await finish(db, row.id, "failed", `payload push non costruibile: ${error}`);
    return;
  }

  let response: PushRelaySendResponse;
  try {
    response = await client.send(
      devices.map(({ platform, token }) => ({ platform, token })),
      payload,
    );
  } catch (err) {
    const error = errText(err);
    if (err instanceof PushRelayRejected) {
      deps.logger.warn(
        { deliveryId: row.id, channel: row.channel, error },
        "[notify] consegna push failed: il relay ha rifiutato la richiesta",
      );
      await finish(db, row.id, "failed", error);
      return;
    }
    await retryOrFail(deps, row, error);
    return;
  }

  /**
   * APPAIAMENTO PER VALORE DEL TOKEN, mai per indice.
   *
   * Lo schema dichiara che il relay risponde nell'ordine dei token, ma un
   * contratto non lo può imporre e i due capi si deployano da soli. Un relay
   * che riordinasse la risposta farebbe disabilitare il device SBAGLIATO —
   * spegnere un telefono sano e tenerne attivo uno morto — senza nessun errore
   * da nessuna parte, solo un utente che smette di ricevere notifiche.
   *
   * Che ci sia un esito per ogni token spedito, una volta sola, lo verifica già
   * il client (`assertOneResultPerToken`, che altrimenti lancia
   * `PushRelayRejected`): qui un `undefined` non è raggiungibile, e per questo
   * non disabilita nulla e conta come esito permanente.
   */
  const byToken = new Map(response.results.map((result) => [result.token, result]));
  await applyPushOutcome(
    deps,
    row,
    devices.map((device) => ({ device, result: byToken.get(device.token) })),
  );
}

/**
 * Esegue UN giro: reclama fino a `limit` consegne dovute e le spedisce in
 * SEQUENZA (un webhook non va martellato in parallelo; il timeout del POST è
 * 10s, quindi il caso peggiore di un tick è limitato). Un solo batch per tick:
 * con un intervallo di 5" una coda arretrata si drena comunque in fretta, e il
 * tick resta corto e prevedibile. Ritorna quante consegne sono state processate.
 * NON lancia mai.
 */
export async function processDeliveriesOnce(deps: DeliveriesPollerDeps): Promise<number> {
  let rows: NotificationDelivery[];
  try {
    rows = await claimDue(deps.db, deps.limit ?? DEFAULT_LIMIT);
  } catch (err) {
    deps.logger.error({ err }, "[notify] claim delle consegne fallito");
    return 0;
  }

  // Contesto del giro (il log delle push spente, una volta sola).
  const tick = createTickContext();
  let processed = 0;
  for (const row of rows) {
    if (deps.signal?.aborted) break;
    try {
      await processDelivery(deps, tick, row);
      processed += 1;
    } catch (err) {
      // Difesa in profondità: processDelivery cattura già tutto.
      deps.logger.error({ err, deliveryId: row.id }, "[notify] consegna non processata");
    }
  }
  return processed;
}

export interface StartDeliveriesPollerOptions extends DeliveriesPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller sul proprio setInterval. Guard `running` anti-rientro: un tick
 * lento (molte consegne, webhook lento) non si sovrappone al successivo. Stop
 * sull'AbortSignal; ritorna uno stop idempotente. `intervalSeconds ≤ 0` =
 * disabilitato (nessun timer, nessuna consegna inviata).
 */
export function startDeliveriesPoller(opts: StartDeliveriesPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDeliveriesOnce(deps);
    } catch (err) {
      deps.logger.error({ err }, "[notify] tick delle consegne fallito");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
