import { notificationDeliveries, type Db, type NotificationDelivery } from "@stubwise/db";
import { loadSettings, sendWebhookEvent } from "@stubwise/notifications";
import type { NotificationEvent } from "@stubwise/notifications/format";
import { and, eq, sql } from "drizzle-orm";

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
 * CANALI: oggi solo `webhook` (il webhook d'istanza, per EVENTO: nessuna
 * notifica dietro, payload nella colonna `event`). `slack_dm` e `slack_update`
 * sono chiusi `skipped` con `channel_not_implemented` finché il Task 9 non li
 * implementa: meglio una consegna dichiaratamente non gestita che una riga
 * pending che il poller riguarda per sempre.
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
  /** Invio webhook iniettabile nei test. Default sendWebhookEvent. */
  sendWebhook?: SendWebhookFn;
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
async function processDelivery(deps: DeliveriesPollerDeps, row: NotificationDelivery): Promise<void> {
  const { db } = deps;
  if (row.channel !== "webhook") {
    // Task 9: DM Slack e aggiornamento del messaggio. Fino ad allora la riga si
    // chiude dichiaratamente non gestita invece di restare pending per sempre.
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

  let processed = 0;
  for (const row of rows) {
    if (deps.signal?.aborted) break;
    try {
      await processDelivery(deps, row);
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
