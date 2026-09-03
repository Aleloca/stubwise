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
  buildInboxBlocks,
  buildPushPayload,
  buildQuestionBlocks,
  createSlackClient,
  formatNotification,
  isFatalSlackError,
  KINDS_WITH_OPTIONS,
  loadSettings,
  loadSlackBotToken,
  openUrl,
  PushRelayRejected,
  sendWebhookEvent,
  unreadCount,
  type DbOrTx,
  type NotificationEvent,
  type PushRelayClient,
  type SlackBlock,
  type SlackMessenger,
} from "@stubwise/notifications";
import type { PushPlatform, PushRelaySendResponse } from "@stubwise/shared";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

/**
 * POLLER DELL'OUTBOX delle notifiche (`notification_deliveries`): task SEPARATO
 * dal loop dei job, sul proprio intervallo breve (default 5"), stesso pattern
 * degli altri poller del worker (backlog, review, graph, docs auto-update).
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
 *  - `slack_dm` — il DM personale al destinatario, con i bottoni Block Kit
 *    delle azioni che QUELL'utente può compiere (`actionsFor` col suo ruolo e
 *    con lo stato attuale dell'ultimo job del ticket). Il riferimento del
 *    messaggio postato finisce in `external_ref` (vedi sotto);
 *  - `slack_update` — riscrive il DM già inviato della STESSA notifica (la sua
 *    consegna `slack_dm` sorella) togliendo i bottoni e aggiungendo una riga di
 *    stato. Il testo da aggiungere sta nel jsonb `event` della riga, nella
 *    forma `{ "note": "✅ Gestita da …" }` (`event` è nullable per i canali
 *    diversi da `webhook`: senza nota si limita a togliere i bottoni, che è
 *    esattamente ciò che serve dopo uno snooze);
 *  - `push` — la notifica sui telefoni del destinatario, spedita al RELAY
 *    (nessuna istanza parla con APNs o FCM). Una consegna per destinatario,
 *    non per device: i device attivi si leggono al momento dell'invio.
 *
 * FORMATO DI `external_ref` (canali Slack): `"<channel>|<ts>"`, dove `channel`
 * è quello RISOLTO da Slack (postando su uno user id è il DM `D…`) e `ts` la
 * chiave del messaggio. Sono i due argomenti che `chat.update` pretende, e
 * tenerli insieme evita una colonna in più. Vedi {@link parseExternalRef}.
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

/** Caricamento del bot token Slack. Default {@link loadSlackBotToken}, fake nei test. */
export type LoadSlackBotTokenFn = (db: Db, encryptionKey: Buffer) => Promise<string | null>;

/** Fabbrica del client Slack. Default {@link createSlackClient}, fake nei test. */
export type SlackMessengerFactory = (botToken: string) => SlackMessenger;

export interface DeliveriesPollerDeps {
  db: Db;
  logger: DeliveriesLogger;
  /**
   * Chiave con cui è cifrato il bot token Slack nelle instance settings (la
   * stessa del server). Serve ai canali Slack; il webhook la ignora.
   */
  encryptionKey: Buffer;
  /** Invio webhook iniettabile nei test. Default sendWebhookEvent. */
  sendWebhook?: SendWebhookFn;
  /** Caricamento del bot token iniettabile nei test. Default loadSlackBotToken. */
  loadSlackBotToken?: LoadSlackBotTokenFn;
  /** Client Slack iniettabile nei test. Default createSlackClient (rete vera). */
  slackClientFactory?: SlackMessengerFactory;
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
  externalRef?: string,
): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({
      status,
      error,
      ...(status === "sent" ? { sentAt: sql`now()` } : {}),
      ...(externalRef ? { externalRef } : {}),
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
  if (row.channel === "slack_dm" || row.channel === "slack_update") {
    await processSlackDelivery(deps, tick, row);
    return;
  }
  if (row.channel === "push") {
    await processPushDelivery(deps, row);
    return;
  }
  if (row.channel !== "webhook") {
    // Canale aggiunto all'enum ma non ancora gestito qui: meglio una consegna
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

  const send = deps.sendWebhook ?? sendWebhookEvent;
  // Il cast è il punto in cui il jsonb torna il tipo forte dell'unione: è
  // `publishNotification` ad averlo scritto da un NotificationEvent.
  const event = row.event as unknown as NotificationEvent;
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
 * tentativi, poi `failed`. Condiviso da webhook e canali Slack.
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


// --- Canali Slack ---------------------------------------------------------

/**
 * Stato condiviso da tutte le consegne di UN tick. Il bot token si carica (e si
 * decifra) UNA volta per giro, non una per riga: sono N query e N decifrature
 * identiche su una coda arretrata.
 *
 * La memoizzazione è per TICK e non per processo di proposito: se un admin
 * ricollega Slack, il tick successivo vede il token nuovo senza riavviare il
 * worker.
 */
interface TickContext {
  /** Bot token decifrato, `null` se l'integrazione non è configurata. Memoizzato. */
  botToken(): Promise<string | null>;
}

function createTickContext(deps: DeliveriesPollerDeps): TickContext {
  const load = deps.loadSlackBotToken ?? loadSlackBotToken;
  let pending: Promise<string | null> | undefined;
  return {
    botToken() {
      pending ??= load(deps.db, deps.encryptionKey);
      return pending;
    },
  };
}

/** Separatore di `external_ref` per i canali Slack: `<channel>|<ts>`. */
const EXTERNAL_REF_SEPARATOR = "|";

/** Compone l'`external_ref` di un messaggio Slack. Vedi il docblock del modulo. */
export function externalRefOf(message: { channel: string; ts: string }): string {
  return `${message.channel}${EXTERNAL_REF_SEPARATOR}${message.ts}`;
}

/**
 * Scompone un `external_ref` Slack nei due argomenti di `chat.update`, o `null`
 * se la stringa non ha la forma attesa (riga scritta a mano, o da una versione
 * precedente): meglio saltare l'aggiornamento che chiamare Slack con un ts vuoto.
 */
export function parseExternalRef(
  externalRef: string | null,
): { channel: string; ts: string } | null {
  if (!externalRef) return null;
  const index = externalRef.indexOf(EXTERNAL_REF_SEPARATOR);
  if (index <= 0) return null;
  const channel = externalRef.slice(0, index);
  const ts = externalRef.slice(index + 1);
  return channel && ts ? { channel, ts } : null;
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
   * dell'agente, che non è un permesso di ruolo.
   */
  requestedByUserId: string | null;
  slackUserId: string | null;
  language: Language;
  role: "admin" | "member";
}

/** Il `kind` come lo tipizza la colonna enum (già valido: lo garantisce il DB). */
type NotificationKindColumn = Parameters<typeof actionsFor>[0]["kind"];

/**
 * RECINTO attorno alla resa del testo dal jsonb, gemello di quello del servizio
 * inbox: `notifications.event` è stato scritto anche mesi fa e da una versione
 * precedente del codice, e un payload marcio non deve far fallire (e ritentare
 * per cinque volte) una consegna. Degrada al `kind`, che viene dalla colonna
 * enum di cui ci si può fidare, e rinuncia al link.
 */
function renderSlack(
  rawEvent: Record<string, unknown>,
  kind: NotificationKindColumn,
  lang: Language,
): { text: string; url?: string } {
  try {
    const event = rawEvent as unknown as NotificationEvent;
    const body = formatNotification(event, "slack", lang).body as { text?: unknown };
    const text = typeof body.text === "string" && body.text.trim() !== "" ? body.text : kind;
    const url: unknown = openUrl(event);
    return { text, ...(typeof url === "string" && url !== "" ? { url } : {}) };
  } catch {
    return { text: kind };
  }
}

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
      slackUserId: users.slackUserId,
      language: users.language,
      role: users.role,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(aiJobs, eq(aiJobs.id, notifications.jobId))
    .where(eq(notifications.id, notificationId));
  return row ?? null;
}

/** Stato dell'ultimo job del ticket (come fa il servizio inbox): gate delle azioni. */
async function latestJobStatus(db: Db, ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: aiJobs.status })
    .from(aiJobs)
    .where(eq(aiJobs.ticketId, ticketId))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);
  return row?.status ?? null;
}

/**
 * Processa una consegna Slack (DM o aggiornamento). Struttura comune ai due
 * canali: bot token → notifica e destinatario → invio → classificazione
 * dell'errore.
 *
 * CLASSIFICAZIONE: un errore Slack DEFINITIVO ({@link isFatalSlackError}: token
 * revocato, scope mancante, destinatario o messaggio inesistente) chiude subito
 * `failed` — ritentarlo cinque volte non lo farebbe cambiare idea. Tutto il
 * resto (rete, `ratelimited`, errori interni di Slack) passa dal backoff
 * ordinario.
 */
async function processSlackDelivery(
  deps: DeliveriesPollerDeps,
  tick: TickContext,
  row: NotificationDelivery,
): Promise<void> {
  const { db } = deps;
  const token = await tick.botToken();
  if (!token) {
    // Esito terminale silenzioso altrimenti: senza log l'unica traccia sarebbe
    // una riga di DB che nessuno guarda.
    deps.logger.warn(
      { deliveryId: row.id, channel: row.channel },
      "[notify] consegna skipped: bot Slack non configurato",
    );
    await finish(db, row.id, "skipped", "slack_not_configured");
    return;
  }
  if (!row.notificationId) {
    // Impossibile per il CHECK `notification_deliveries_channel_shape_chk`, ma
    // il tipo lo ammette: riga malformata → terminale.
    await finish(db, row.id, "failed", "consegna Slack senza notificationId");
    return;
  }
  const recipient = await loadRecipient(db, row.notificationId);
  if (!recipient) {
    await finish(db, row.id, "failed", "notifica o destinatario non trovati");
    return;
  }

  const client = (deps.slackClientFactory ?? createSlackClient)(token);
  try {
    if (row.channel === "slack_update") {
      await sendSlackUpdate(deps, row, recipient, client);
    } else {
      await sendSlackDm(deps, row, recipient, client);
    }
  } catch (err) {
    const error = errText(err);
    if (isFatalSlackError(err)) {
      deps.logger.warn(
        { deliveryId: row.id, channel: row.channel, error },
        "[notify] consegna Slack failed: errore non recuperabile",
      );
      await finish(db, row.id, "failed", error);
      return;
    }
    // NOTA su `ratelimited`: il `Retry-After` di Slack NON viene onorato, di
    // proposito. Il backoff minimo del claim è 30s ≥ del Retry-After tipico
    // (1–30s), gli invii di un tick sono sequenziali e il limite è per-canale:
    // coi volumi attesi (un DM per destinatario per notifica) non lo si tocca.
    // Se un giorno lo si toccasse, il posto per leggerlo è qui.
    await retryOrFail(deps, row, error);
  }
}

/** Posta il DM con i bottoni delle azioni offerte a QUESTO destinatario. */
async function sendSlackDm(
  deps: DeliveriesPollerDeps,
  row: NotificationDelivery,
  recipient: DeliveryRecipient,
  client: SlackMessenger,
): Promise<void> {
  const { db } = deps;
  if (!recipient.slackUserId) {
    // L'utente ha scollegato Slack dopo il publish: non c'è dove consegnare, e
    // ritentare non lo ricollegherà.
    await finish(db, row.id, "skipped", "user_without_slack_id");
    return;
  }
  const { text, url } = renderSlack(recipient.event, recipient.kind, recipient.language);
  const jobStatus = recipient.ticketId ? await latestJobStatus(db, recipient.ticketId) : null;
  const actions = actionsFor(
    { kind: recipient.kind, requestedByUserId: recipient.requestedByUserId },
    jobStatus,
    { id: recipient.userId, role: recipient.role },
  );
  // I kind CON OPZIONI (la domanda dell'agente, il pulse proattivo) hanno
  // bottoni loro, uno per scelta: il generico "Rispondi" non potrebbe portarsi
  // dietro l'opzione premuta. `buildQuestionBlocks` legge le opzioni dal payload
  // dell'evento (autosufficiente, e indifferente al kind) e, se non sono
  // utilizzabili, degrada da sé ai blocchi standard.
  const blocks = KINDS_WITH_OPTIONS.has(recipient.kind)
    ? buildQuestionBlocks({
        text,
        event: recipient.event,
        actions,
        notificationId: recipient.notificationId,
        lang: recipient.language,
        ...(url ? { url } : {}),
      })
    : buildInboxBlocks({
        text,
        actions,
        notificationId: recipient.notificationId,
        lang: recipient.language,
        ...(url ? { url } : {}),
      });

  // `channel` = lo user id: Slack apre da sé il DM (scope chat:write + im:write).
  const posted = await client.postMessage({ channel: recipient.slackUserId, text, blocks });
  await finish(db, row.id, "sent", null, externalRefOf(posted));
}

/**
 * Riscrive il DM già inviato della stessa notifica: testo originale (nella
 * lingua del destinatario) + la nota di stato del payload, senza bottoni.
 *
 * Il messaggio da riscrivere è quello della consegna `slack_dm` SORELLA (stessa
 * notifica, `sent`, con `external_ref`). Se non c'è — il DM non è mai partito, o
 * è fallito — non c'è nulla da aggiornare: `skipped`, non un errore.
 */
async function sendSlackUpdate(
  deps: DeliveriesPollerDeps,
  row: NotificationDelivery,
  recipient: DeliveryRecipient,
  client: SlackMessenger,
): Promise<void> {
  const { db } = deps;
  const [sibling] = await db
    .select({ externalRef: notificationDeliveries.externalRef })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, recipient.notificationId),
        eq(notificationDeliveries.channel, "slack_dm"),
        eq(notificationDeliveries.status, "sent"),
        isNotNull(notificationDeliveries.externalRef),
      ),
    )
    .orderBy(desc(notificationDeliveries.sentAt))
    .limit(1);
  const target = parseExternalRef(sibling?.externalRef ?? null);
  if (!target) {
    // Nessun DM `sent` da riscrivere: due situazioni diverse.
    //
    // Se il DM sorella è ancora `pending` siamo semplicemente ARRIVATI PRIMA —
    // capita di continuo, perché chi accoda l'aggiornamento (l'azione dai
    // bottoni) e chi accoda il DM sono processi distinti e il claim del poller
    // non garantisce l'ordine. Lasciare la riga `pending` la fa ritentare dopo
    // il backoff, quando il DM sarà partito: chiuderla `skipped` lascerebbe
    // invece per sempre un messaggio con i bottoni di una notifica già decisa.
    // Il DM che non parte mai (utente scollegato, token revocato) finisce
    // `failed`/`skipped` e ricade nel ramo sotto, che chiude anche l'update.
    const [pendingSibling] = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.notificationId, recipient.notificationId),
          eq(notificationDeliveries.channel, "slack_dm"),
          eq(notificationDeliveries.status, "pending"),
        ),
      )
      .limit(1);
    // CAP DELL'ATTESA: `retryOrFail` non ritenta all'infinito. Con
    // MAX_ATTEMPTS=5 e backoff 30/60/120/240s la finestra è di ~8 minuti; oltre
    // quella l'update si chiude `failed` e il DM resta con i bottoni di una
    // notifica già decisa. Innocuo: chi li preme ottiene `already_handled` (il
    // servizio inbox riguarda lo stato, non il messaggio), e i bottoni stale
    // spariscono al prossimo aggiornamento di quel DM.
    if (pendingSibling) {
      await retryOrFail(deps, row, "slack_dm_pending");
      return;
    }
    // DM sorella assente o in uno stato terminale senza messaggio: non c'è
    // nulla da riscrivere, e non lo sarà mai.
    await finish(db, row.id, "skipped", "no_slack_message");
    return;
  }

  const { text } = renderSlack(recipient.event, recipient.kind, recipient.language);
  const note = noteOf(row.event);
  // Riga di stato staccata dal testo: il DM resta leggibile come "cos'era" +
  // "com'è finita".
  const updatedText = note ? `${text}\n\n${note}` : text;
  const blocks: SlackBlock[] = buildInboxBlocks({
    text: updatedText,
    // Nessuna azione: una notifica già decisa non si ridecide dal messaggio
    // vecchio (chi ci prova otterrebbe un `already_handled`).
    actions: [],
    notificationId: recipient.notificationId,
    lang: recipient.language,
  });

  await client.updateMessage({ channel: target.channel, ts: target.ts, text: updatedText, blocks });
  // L'aggiornamento conserva il riferimento del messaggio riscritto: è utile a
  // capire, guardando la riga, QUALE messaggio ha toccato.
  await finish(db, row.id, "sent", null, externalRefOf(target));
}

/**
 * Nota di stato dal payload della consegna `slack_update`
 * (`{ "note": "✅ Gestita da …" }`). Assente o malformata ⇒ nessuna nota: si
 * rimuovono solo i bottoni. Il payload lo scrive chi accoda l'aggiornamento
 * (Task 10), già localizzato per il destinatario.
 */
function noteOf(event: Record<string, unknown> | null): string | null {
  const note = event?.note;
  return typeof note === "string" && note.trim() !== "" ? note : null;
}

// --- Canale push (fase 4) -------------------------------------------------

/**
 * Tetto per SINGOLA chiamata al relay push, molto più stretto dei 10 s di
 * default del client.
 *
 * Non è un'ottimizzazione della latenza della push: è la protezione di TUTTE le
 * altre consegne. Il poller processa fino a 20 righe per tick IN SEQUENZA e con
 * una guardia anti-rientro, quindi col default un relay morto allungherebbe il
 * tick a 200 s — e in quel tick non partirebbero nemmeno i DM Slack e i
 * webhook, che stanno nella stessa coda. Il backoff non aiuta: agisce dopo.
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
 * Finisce nella colonna `error` anche quando la consegna è `sent`, e non è una
 * svista: è l'unica colonna diagnostica della riga (`external_ref` ha già un
 * significato suo, ed è dei canali Slack), ed è l'unico posto in cui resta
 * scritto QUALI telefoni hanno ricevuto la notifica e quali no. Una riga `sent`
 * con `error` valorizzato è quindi normale su questo canale, e solo su questo.
 */
function summarizePushOutcomes(outcomes: DeviceOutcome[]): string {
  const shown = outcomes.slice(0, PUSH_DETAIL_MAX_ENTRIES).map(({ device, result }) => {
    const status = result?.status ?? "no_result";
    return result?.reason ? `${device.id}=${status} (${result.reason})` : `${device.id}=${status}`;
  });
  const rest = outcomes.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
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
  const detail = summarizePushOutcomes(outcomes);
  const anyOk = outcomes.some(({ result }) => result?.status === "ok");
  const anyRetry = outcomes.some(({ result }) => result?.status === "retry");

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
      await retryOrFail(deps, row, detail, tx);
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
  row: NotificationDelivery,
): Promise<void> {
  const { db } = deps;
  const client = deps.pushRelay;
  if (!client) {
    // Esito terminale altrimenti silenzioso: senza log l'unica traccia sarebbe
    // una riga di DB che nessuno guarda. Vale come per il bot Slack non
    // configurato — chi ha spento le push le vede tacere e sa perché.
    deps.logger.warn(
      { deliveryId: row.id, channel: row.channel },
      "[notify] consegna skipped: push spente (PUSH_RELAY_URL vuota)",
    );
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

  const devices = await activeDevices(db, recipient.userId);
  if (devices.length === 0) {
    // Al publish ne aveva almeno uno: nel frattempo li ha persi (revoca del
    // PAT, o l'ultima push aveva già disabilitato l'ultimo token). Non è un
    // errore e non c'è dove consegnare: `skipped`, come l'utente senza Slack.
    await finish(db, row.id, "skipped", "no_active_device");
    return;
  }

  let payload;
  try {
    payload = buildPushPayload(recipient.event as unknown as NotificationEvent, recipient.language, {
      notificationId: recipient.notificationId,
      // Il badge è il numero della campanella di QUESTO destinatario, non un
      // conteggio delle sue push: stessa funzione della rotta `unread-count`.
      unreadCount: await unreadCount(db, recipient.userId),
      projectId: recipient.projectId,
    });
  } catch (err) {
    // RECINTO attorno alla resa dal jsonb, gemello di quello di `renderSlack`:
    // `notifications.event` può essere stato scritto mesi fa da una versione
    // precedente. Senza questo catch l'eccezione uscirebbe da `processDelivery`
    // e la riga resterebbe `pending` PER SEMPRE: `retryOrFail` non verrebbe mai
    // raggiunto, quindi nessuno la dichiarerebbe `failed` e il claim
    // continuerebbe a ripescarla a ogni scadenza del backoff.
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

  // Contesto del giro: il bot token si carica al massimo una volta (e solo se
  // c'è davvero una consegna Slack da fare).
  const tick = createTickContext(deps);
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
