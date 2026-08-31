import {
  aiJobs,
  notificationDeliveries,
  notifications,
  users,
  type Db,
  type NotificationDelivery,
} from "@stubwise/db";
import {
  actionsFor,
  buildInboxBlocks,
  createSlackClient,
  formatNotification,
  isFatalSlackError,
  loadSettings,
  loadSlackBotToken,
  openUrl,
  sendWebhookEvent,
  type SlackBlock,
  type SlackMessenger,
} from "@stubwise/notifications";
import type { Language, NotificationEvent } from "@stubwise/notifications/format";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

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
 *    esattamente ciò che serve dopo uno snooze).
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
  db: Db,
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
async function keepPending(db: Db, id: string, error: string): Promise<void> {
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
): Promise<void> {
  // `attempts` è già quello POST-claim: al quinto tentativo si chiude.
  if (row.attempts >= MAX_ATTEMPTS) {
    // Notifica definitivamente persa: deve comparire nei log del worker, non
    // solo nella colonna `error` della riga.
    deps.logger.warn(
      { deliveryId: row.id, channel: row.channel, attempts: row.attempts, error },
      "[notify] consegna failed dopo MAX_ATTEMPTS",
    );
    await finish(deps.db, row.id, "failed", error);
    return;
  }
  await keepPending(deps.db, row.id, error);
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
interface SlackRecipient {
  notificationId: string;
  userId: string;
  kind: NotificationKindColumn;
  event: Record<string, unknown>;
  ticketId: string | null;
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
async function loadRecipient(db: Db, notificationId: string): Promise<SlackRecipient | null> {
  const [row] = await db
    .select({
      notificationId: notifications.id,
      userId: notifications.userId,
      kind: notifications.kind,
      event: notifications.event,
      ticketId: notifications.ticketId,
      slackUserId: users.slackUserId,
      language: users.language,
      role: users.role,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
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
  recipient: SlackRecipient,
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
  const actions = actionsFor({ kind: recipient.kind }, jobStatus, {
    id: recipient.userId,
    role: recipient.role,
  });
  const blocks = buildInboxBlocks({
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
  recipient: SlackRecipient,
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
