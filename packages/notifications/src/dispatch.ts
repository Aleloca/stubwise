import { notificationSettings, type Db } from "@stubwise/db";
import {
  formatNotification,
  type NotificationEvent,
  type NotificationFormat,
  type NotificationKind,
  type TicketCreatedEvent,
} from "./format.js";

/**
 * Modulo di dispatch delle notifiche in uscita di Stubwise.
 *
 * Un singolo webhook configurabile (Slack / Discord / JSON generico) riceve un
 * messaggio sugli eventi chiave della piattaforma. I chiamanti (ingestion del
 * server, pipeline del worker) assemblano un {@link NotificationEvent} tipato
 * con tutto il necessario a comporre il messaggio: il modulo NON interroga
 * ticket/job, formatta soltanto e POSTa.
 *
 * La FORMATTAZIONE pura (evento → body del webhook) vive in `./format.ts`
 * (senza dipendenze dal DB, riusabile lato web): qui ci si occupa solo di
 * lettura config, gating e POST. {@link dispatchNotification} riusa
 * {@link formatNotification} come unica fonte di verità.
 *
 * BEST-EFFORT: {@link dispatchNotification} non lancia MAI. Un fallimento di
 * rete, una config rotta o un formato imprevisto vengono inghiottiti — una
 * notifica mancata non deve mai rompere l'ingestion né un job. La verifica
 * esplicita del webhook (che DEVE far emergere gli errori) è {@link sendTest}.
 */

/**
 * Proiezione (read-only) della riga di configurazione `notification_settings`
 * usata dal dispatch: solo i campi che servono a decidere SE e COME inviare.
 */
export interface NotificationSettingsRow {
  webhookUrl: string | null;
  format: NotificationFormat;
  enabled: boolean;
  notifyTicketCreated: boolean;
  notifyPrOpened: boolean;
  notifyJobHeld: boolean;
  notifyJobFailed: boolean;
  notifyPrClosed: boolean;
}

export interface DispatchOptions {
  /** fetch iniettabile nei test. Default: il fetch globale. */
  fetchImpl?: typeof fetch;
  /** Timeout del POST in ms (default 10s). */
  timeoutMs?: number;
}

/** Timeout di default del POST del webhook. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Mappa evento → colonna toggle della config. */
const TOGGLE_FOR_KIND: Record<NotificationKind, keyof NotificationSettingsRow> = {
  "ticket.created": "notifyTicketCreated",
  "job.pr_opened": "notifyPrOpened",
  "job.held": "notifyJobHeld",
  "job.failed": "notifyJobFailed",
  "job.pr_closed": "notifyPrClosed",
};

/**
 * Legge l'unica riga di configurazione (`notification_settings`, id=1 seedato
 * dalla migrazione). Restituisce null se assente (DB non ancora migrato in
 * scenari anomali). Best-effort: lascia propagare al chiamante che inghiotte.
 */
async function loadSettings(db: Db): Promise<NotificationSettingsRow | null> {
  const rows = await db
    .select({
      webhookUrl: notificationSettings.webhookUrl,
      format: notificationSettings.format,
      enabled: notificationSettings.enabled,
      notifyTicketCreated: notificationSettings.notifyTicketCreated,
      notifyPrOpened: notificationSettings.notifyPrOpened,
      notifyJobHeld: notificationSettings.notifyJobHeld,
      notifyJobFailed: notificationSettings.notifyJobFailed,
      notifyPrClosed: notificationSettings.notifyPrClosed,
    })
    .from(notificationSettings)
    .limit(1);
  return rows[0] ?? null;
}

// --- Formattazione ---

/**
 * Compone il body JSON per il formato configurato. Adattatore sottile attorno
 * a {@link formatNotification} (unica fonte di verità in `./format.ts`):
 * restituisce solo il `body`, quel che effettivamente si serializza nel POST.
 */
export function formatEvent(
  format: NotificationFormat,
  event: NotificationEvent,
): Record<string, unknown> {
  return formatNotification(event, format).body as Record<string, unknown>;
}

/**
 * POST del payload al webhook con timeout via AbortController. Restituisce la
 * Response; lancia su errore di rete/timeout. I chiamanti decidono se
 * inghiottire (dispatch) o far emergere (sendTest).
 */
async function postWebhook(
  url: string,
  payload: Record<string, unknown>,
  opts: DispatchOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Invia una notifica per l'evento dato, se la configurazione lo consente.
 *
 * No-op (silenzioso) quando: nessuna riga di config, `enabled` false, nessun
 * `webhookUrl`, o toggle del singolo evento off. Altrimenti formatta secondo
 * `format` e POSTa al webhook.
 *
 * BEST-EFFORT: non lancia MAI. Qualunque errore (lettura config, formato, rete,
 * risposta non-2xx) viene inghiottito: una notifica mancata non deve rompere
 * l'ingestion né un job.
 */
export async function dispatchNotification(
  db: Db,
  event: NotificationEvent,
  opts: DispatchOptions = {},
): Promise<void> {
  try {
    const settings = await loadSettings(db);
    if (!settings || !settings.enabled || !settings.webhookUrl) return;
    if (!settings[TOGGLE_FOR_KIND[event.kind]]) return;

    const payload = formatEvent(settings.format, event);
    const response = await postWebhook(settings.webhookUrl, payload, opts);
    // Una risposta non-2xx è un fallimento del webhook ma comunque best-effort:
    // non si propaga, al massimo si potrebbe loggare (qui niente logger).
    void response;
  } catch {
    // Inghiottito di proposito: vedi docblock del modulo.
  }
}

/**
 * Costruisce un evento `ticket.created` FITTIZIO per la verifica del webhook
 * dalla UI ("Invia notifica di test"): riusa la stessa formattazione del
 * dispatch reale, così quel che l'utente vede nel test è ciò che riceverà.
 * Il link punta a `${baseUrl}/tickets/test`.
 */
export function buildTestEvent(baseUrl: string): TicketCreatedEvent {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    kind: "ticket.created",
    ticketNumber: 0,
    ticketTitle: "Notifica di test di Stubwise",
    projectName: "Progetto di esempio",
    source: "sdk_error",
    ticketUrl: `${base}/tickets/test`,
  };
}

/** Esito della verifica del webhook: ok + dettaglio leggibile. */
export interface SendTestResult {
  ok: boolean;
  detail: string;
}

/**
 * Invia una notifica di TEST al webhook configurato e RIPORTA l'esito.
 *
 * A differenza di {@link dispatchNotification}, questo percorso NON inghiotte:
 * serve all'utente per capire se il webhook è corretto. Ignora i toggle
 * per-evento e l'interruttore `enabled` (è una verifica esplicita), ma richiede
 * un `webhookUrl` configurato. Usa il `format` salvato così il test combacia
 * con le notifiche reali.
 */
export async function sendTest(
  db: Db,
  baseUrl: string,
  opts: DispatchOptions = {},
): Promise<SendTestResult> {
  let settings: NotificationSettingsRow | null;
  try {
    settings = await loadSettings(db);
  } catch (err) {
    return { ok: false, detail: `Impossibile leggere la configurazione: ${errorMessage(err)}` };
  }
  if (!settings || !settings.webhookUrl) {
    return { ok: false, detail: "Nessun webhook configurato." };
  }

  const payload = formatEvent(settings.format, buildTestEvent(baseUrl));
  try {
    const response = await postWebhook(settings.webhookUrl, payload, opts);
    if (!response.ok) {
      return { ok: false, detail: `Il webhook ha risposto con stato ${response.status}.` };
    }
    return { ok: true, detail: "Notifica di test inviata correttamente." };
  } catch (err) {
    return { ok: false, detail: `Invio fallito: ${errorMessage(err)}` };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
