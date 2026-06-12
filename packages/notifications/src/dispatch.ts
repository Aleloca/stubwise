import { notificationSettings, type Db } from "@stubwise/db";

/**
 * Modulo di dispatch delle notifiche in uscita di Stubwise.
 *
 * Un singolo webhook configurabile (Slack / Discord / JSON generico) riceve un
 * messaggio sugli eventi chiave della piattaforma. I chiamanti (ingestion del
 * server, pipeline del worker) assemblano un {@link NotificationEvent} tipato
 * con tutto il necessario a comporre il messaggio: il modulo NON interroga
 * ticket/job, formatta soltanto e POSTa.
 *
 * BEST-EFFORT: {@link dispatchNotification} non lancia MAI. Un fallimento di
 * rete, una config rotta o un formato imprevisto vengono inghiottiti — una
 * notifica mancata non deve mai rompere l'ingestion né un job. La verifica
 * esplicita del webhook (che DEVE far emergere gli errori) è {@link sendTest}.
 */

/** Formato del messaggio: combacia con l'enum DB `notification_format`. */
export type NotificationFormat = "slack" | "discord" | "generic";

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
}

/** Nuovo ticket SDK (errore o feedback) appena creato. */
export interface TicketCreatedEvent {
  kind: "ticket.created";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  /** Sorgente SDK: "sdk_error" o "sdk_feedback". */
  source: string;
  ticketUrl: string;
}

/** L'AI ha aperto una PR sul ticket. */
export interface PrOpenedEvent {
  kind: "job.pr_opened";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  prUrl: string;
  ticketUrl: string;
  /** Costo USD del run di fix, se noto. */
  costUsd?: number | null;
}

/** Il job è in attesa di revisione umana (gate di automazione / soglia effort). */
export interface JobHeldEvent {
  kind: "job.held";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  /** Tipo (ri)classificato dal triage. */
  type: string;
  /** Sforzo stimato 1–5. */
  effort: number;
  ticketUrl: string;
}

/** Il fix AI è fallito. */
export interface JobFailedEvent {
  kind: "job.failed";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  error: string;
  ticketUrl: string;
}

/** Unione tipata di tutti gli eventi che generano una notifica. */
export type NotificationEvent =
  | TicketCreatedEvent
  | PrOpenedEvent
  | JobHeldEvent
  | JobFailedEvent;

/** Tipo dei `kind` degli eventi, per mappare evento → toggle. */
export type NotificationKind = NotificationEvent["kind"];

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
    })
    .from(notificationSettings)
    .limit(1);
  return rows[0] ?? null;
}

// --- Formattazione ---

/** Etichetta del costo in USD, o stringa vuota se assente. */
function costSuffixSlack(costUsd: number | null | undefined): string {
  return costUsd != null ? ` (costo $${costUsd})` : "";
}

/** Corpo Slack: `{ text }` in mrkdwn, link in stile `<url|label>`. */
function formatSlack(event: NotificationEvent): Record<string, unknown> {
  switch (event.kind) {
    case "ticket.created":
      return {
        text:
          `🐛 Nuovo ticket *#${event.ticketNumber}* — ${event.ticketTitle} ` +
          `(${event.projectName}, ${event.source}). <${event.ticketUrl}|Apri>`,
      };
    case "job.pr_opened":
      return {
        text:
          `✅ PR aperta per *#${event.ticketNumber}* — ${event.ticketTitle}` +
          `${costSuffixSlack(event.costUsd)}. ` +
          `<${event.prUrl}|Vedi PR> · <${event.ticketUrl}|Ticket>`,
      };
    case "job.held":
      return {
        text:
          `⏸️ *#${event.ticketNumber}* in attesa di revisione — ${event.ticketTitle} ` +
          `(${event.type}, effort ${event.effort}/5). <${event.ticketUrl}|Apri>`,
      };
    case "job.failed":
      return {
        text:
          `❌ Fix AI fallito su *#${event.ticketNumber}* — ${event.ticketTitle}: ` +
          `${event.error}. <${event.ticketUrl}|Apri>`,
      };
  }
}

/** Etichetta del costo per Discord/markdown. */
function costSuffixMd(costUsd: number | null | undefined): string {
  return costUsd != null ? ` (costo $${costUsd})` : "";
}

/** Corpo Discord: `{ content }` in markdown, link in stile `[label](url)`. */
function formatDiscord(event: NotificationEvent): Record<string, unknown> {
  switch (event.kind) {
    case "ticket.created":
      return {
        content:
          `🐛 Nuovo ticket **#${event.ticketNumber}** — ${event.ticketTitle} ` +
          `(${event.projectName}, ${event.source}). [Apri](${event.ticketUrl})`,
      };
    case "job.pr_opened":
      return {
        content:
          `✅ PR aperta per **#${event.ticketNumber}** — ${event.ticketTitle}` +
          `${costSuffixMd(event.costUsd)}. ` +
          `[Vedi PR](${event.prUrl}) · [Ticket](${event.ticketUrl})`,
      };
    case "job.held":
      return {
        content:
          `⏸️ **#${event.ticketNumber}** in attesa di revisione — ${event.ticketTitle} ` +
          `(${event.type}, effort ${event.effort}/5). [Apri](${event.ticketUrl})`,
      };
    case "job.failed":
      return {
        content:
          `❌ Fix AI fallito su **#${event.ticketNumber}** — ${event.ticketTitle}: ` +
          `${event.error}. [Apri](${event.ticketUrl})`,
      };
  }
}

/** Frase di riepilogo (italiano, senza markup) per il payload generico. */
function plainMessage(event: NotificationEvent): string {
  switch (event.kind) {
    case "ticket.created":
      return `Nuovo ticket #${event.ticketNumber} — ${event.ticketTitle} (${event.projectName}, ${event.source}).`;
    case "job.pr_opened":
      return `PR aperta per #${event.ticketNumber} — ${event.ticketTitle}.`;
    case "job.held":
      return `#${event.ticketNumber} in attesa di revisione — ${event.ticketTitle} (${event.type}, effort ${event.effort}/5).`;
    case "job.failed":
      return `Fix AI fallito su #${event.ticketNumber} — ${event.ticketTitle}: ${event.error}.`;
  }
}

/** Payload generico machine-readable: campi piatti, niente markup. */
function formatGeneric(event: NotificationEvent): Record<string, unknown> {
  const base = {
    event: event.kind,
    ticketNumber: event.ticketNumber,
    title: event.ticketTitle,
    projectName: event.projectName,
    message: plainMessage(event),
    ticketUrl: event.ticketUrl,
  };
  switch (event.kind) {
    case "ticket.created":
      return { ...base, source: event.source };
    case "job.pr_opened":
      return { ...base, prUrl: event.prUrl, costUsd: event.costUsd ?? null };
    case "job.held":
      return { ...base, type: event.type, effort: event.effort };
    case "job.failed":
      return { ...base, error: event.error };
  }
}

/** Compone il body JSON per il formato configurato. */
export function formatEvent(
  format: NotificationFormat,
  event: NotificationEvent,
): Record<string, unknown> {
  switch (format) {
    case "slack":
      return formatSlack(event);
    case "discord":
      return formatDiscord(event);
    case "generic":
      return formatGeneric(event);
  }
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
