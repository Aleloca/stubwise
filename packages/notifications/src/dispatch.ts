import { instanceSettings, notificationSettings, type Db } from "@stubwise/db";
import type { Language } from "@stubwise/i18n";
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
 *
 * Dalla Fase 0 questo modulo è il CANALE `webhook` e non più il punto
 * d'ingresso: le notifiche si pubblicano con `publishNotification`
 * (`./publish.ts`), che scrive inbox e outbox; è poi il poller del worker a
 * chiamare {@link sendWebhookEvent} per le consegne dovute.
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
  notifyPlanReview: boolean;
  notifyJobFailed: boolean;
  notifyPrClosed: boolean;
  notifyBudgetHeld: boolean;
  notifyReviewCompleted: boolean;
  notifyDocsLimitPaused: boolean;
  notifyMonitor: boolean;
  notifyAwaitingInput: boolean;
}

/**
 * Lingua dei contenuti dell'istanza (`instance_settings.content_language`),
 * usata per localizzare i messaggi di notifica. Letta separatamente dalla config
 * del webhook perché vive in un'altra tabella singleton.
 */
export type ContentLanguage = Language;

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
  "job.plan_review": "notifyPlanReview",
  "job.budget_held": "notifyBudgetHeld",
  "job.failed": "notifyJobFailed",
  "job.pr_closed": "notifyPrClosed",
  "review.completed": "notifyReviewCompleted",
  "docs.limit_paused": "notifyDocsLimitPaused",
  // Un unico toggle governa entrambi i kind del monitoraggio (alert e recovered).
  "monitor.alert": "notifyMonitor",
  "monitor.recovered": "notifyMonitor",
  "job.awaiting_input": "notifyAwaitingInput",
};

/**
 * `Db` o una transazione drizzle: le letture di configurazione funzionano
 * identiche sui due, e chi pubblica una notifica dentro una transazione
 * (vedi `./publish.ts`) deve poter passare il suo `tx`.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Legge l'unica riga di configurazione (`notification_settings`, id=1 seedato
 * dalla migrazione). Restituisce null se assente (DB non ancora migrato in
 * scenari anomali). Best-effort: lascia propagare al chiamante che inghiotte.
 */
export async function loadSettings(db: DbOrTx): Promise<NotificationSettingsRow | null> {
  const rows = await db
    .select({
      webhookUrl: notificationSettings.webhookUrl,
      format: notificationSettings.format,
      enabled: notificationSettings.enabled,
      notifyTicketCreated: notificationSettings.notifyTicketCreated,
      notifyPrOpened: notificationSettings.notifyPrOpened,
      notifyJobHeld: notificationSettings.notifyJobHeld,
      notifyPlanReview: notificationSettings.notifyPlanReview,
      notifyJobFailed: notificationSettings.notifyJobFailed,
      notifyPrClosed: notificationSettings.notifyPrClosed,
      notifyBudgetHeld: notificationSettings.notifyBudgetHeld,
      notifyReviewCompleted: notificationSettings.notifyReviewCompleted,
      notifyDocsLimitPaused: notificationSettings.notifyDocsLimitPaused,
      notifyMonitor: notificationSettings.notifyMonitor,
      notifyAwaitingInput: notificationSettings.notifyAwaitingInput,
    })
    .from(notificationSettings)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Legge la lingua dei contenuti dell'istanza (`instance_settings`, id=1 seedata
 * con `'en'`). Default `"en"` se la riga manca (DB non ancora migrato) o in caso
 * di lettura vuota: una notifica non deve mai dipendere da questa lettura.
 */
async function loadContentLanguage(db: DbOrTx): Promise<ContentLanguage> {
  const rows = await db
    .select({ contentLanguage: instanceSettings.contentLanguage })
    .from(instanceSettings)
    .limit(1);
  return rows[0]?.contentLanguage ?? "en";
}

// --- Formattazione ---

/**
 * Compone il body JSON per il formato configurato, nella lingua `lang` (default
 * `"en"`). Adattatore sottile attorno a {@link formatNotification} (unica fonte
 * di verità in `./format.ts`): restituisce solo il `body`, quel che
 * effettivamente si serializza nel POST.
 */
export function formatEvent(
  format: NotificationFormat,
  event: NotificationEvent,
  lang: ContentLanguage = "en",
): Record<string, unknown> {
  return formatNotification(event, format, lang).body as Record<string, unknown>;
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
 * GATING del canale webhook: l'evento va recapitato al webhook d'istanza?
 * Serve un URL configurato, l'interruttore generale acceso e il toggle del
 * singolo kind attivo.
 *
 * È l'unico punto in cui la decisione vive: `publishNotification` la consulta
 * PRIMA di accodare la consegna (così l'outbox non si riempie di righe che il
 * poller scarterebbe) e {@link dispatchNotification} la usa nel percorso
 * sincrono legacy.
 */
export function shouldSendWebhook(
  settings: NotificationSettingsRow | null,
  kind: NotificationKind,
): boolean {
  if (!settings || !settings.enabled || !settings.webhookUrl) return false;
  return settings[TOGGLE_FOR_KIND[kind]] === true;
}

/**
 * INVIA l'evento al webhook d'istanza, SENZA gating: il chiamante ha già
 * deciso (a monte, con {@link shouldSendWebhook}) che questa consegna va fatta.
 *
 * A differenza di {@link dispatchNotification} LANCIA su qualunque errore
 * (webhook non configurato, rete, timeout, risposta non-2xx): è ciò che serve
 * al poller delle consegne, che sul throw incrementa i tentativi e riprova col
 * backoff.
 */
export async function sendWebhookEvent(
  db: DbOrTx,
  event: NotificationEvent,
  opts: DispatchOptions = {},
): Promise<void> {
  const settings = await loadSettings(db);
  if (!settings?.webhookUrl) {
    throw new Error("Nessun webhook configurato.");
  }
  const lang = await loadContentLanguage(db);
  const payload = formatEvent(settings.format, event, lang);
  const response = await postWebhook(settings.webhookUrl, payload, opts);
  if (!response.ok) {
    throw new Error(`Il webhook ha risposto con stato ${response.status}.`);
  }
}

/**
 * PERCORSO LEGACY, sincrono e best-effort, del solo canale webhook: legge la
 * config, applica il gating e POSTa subito.
 *
 * Dalla Fase 0 il punto d'ingresso delle notifiche è
 * `publishNotification` (`./publish.ts`), che scrive inbox e outbox e lascia
 * l'invio al poller del worker. Questa funzione resta perché i chiamanti
 * storici la usano ancora (verranno migrati) e perché il canale webhook è lo
 * stesso: stessa config, stessi toggle, comportamento invariato.
 *
 * No-op (silenzioso) quando il gating non passa. BEST-EFFORT: non lancia MAI —
 * qualunque errore (lettura config, formato, rete, risposta non-2xx) viene
 * inghiottito, una notifica mancata non deve rompere l'ingestion né un job.
 *
 * @deprecated Usa publishNotification; resta il canale webhook interno del
 * poller e di sendTest.
 */
export async function dispatchNotification(
  db: Db,
  event: NotificationEvent,
  opts: DispatchOptions = {},
): Promise<void> {
  try {
    const settings = await loadSettings(db);
    // Il secondo controllo è ridondante col gating, ma restringe `webhookUrl`
    // a string per il type checker senza asserzioni.
    if (!shouldSendWebhook(settings, event.kind) || !settings?.webhookUrl) return;

    const lang = await loadContentLanguage(db);
    const payload = formatEvent(settings.format, event, lang);
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

  const lang = await loadContentLanguage(db);
  const payload = formatEvent(settings.format, buildTestEvent(baseUrl), lang);
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
