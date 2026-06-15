/**
 * Formattazione PURA delle notifiche in uscita di Stubwise.
 *
 * Questo modulo è la SINGOLA fonte di verità su COME un evento diventa il body
 * postato al webhook (Slack / Discord / JSON generico). Non importa `@stubwise/db`
 * né `drizzle-orm`: è riusabile lato web (anteprima dal vivo, documentazione)
 * senza trascinare il DB nel bundle. Il dispatch effettivo (lettura config,
 * gating, POST best-effort) vive in `./dispatch.ts` e riusa `formatNotification`.
 */

/** Formato del messaggio: combacia con l'enum DB `notification_format`. */
export type NotificationFormat = "slack" | "discord" | "generic";

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

/** La PR aperta dall'AI è stata chiusa senza merge: il ticket viene riaperto. */
export interface PrClosedEvent {
  kind: "job.pr_closed";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  prUrl: string;
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
  | PrClosedEvent
  | JobHeldEvent
  | JobFailedEvent;

/** Tipo dei `kind` degli eventi, per mappare evento → toggle. */
export type NotificationKind = NotificationEvent["kind"];

/**
 * Body posto al webhook per il formato dato: il `contentType` dell'header e il
 * `body` (oggetto serializzato come JSON). È esattamente ciò che riceve il
 * webhook configurato, così l'anteprima web e la documentazione combaciano col
 * dispatch reale.
 */
export interface FormattedNotification {
  contentType: string;
  body: unknown;
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
    case "job.pr_closed":
      return {
        text:
          `🔁 PR chiusa senza merge — ticket riaperto: *#${event.ticketNumber}* — ${event.ticketTitle}. ` +
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
    case "job.pr_closed":
      return {
        content:
          `🔁 PR chiusa senza merge — ticket riaperto: **#${event.ticketNumber}** — ${event.ticketTitle}. ` +
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
    case "job.pr_closed":
      return `PR chiusa senza merge — ticket riaperto: #${event.ticketNumber} — ${event.ticketTitle}.`;
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
    case "job.pr_closed":
      return { ...base, prUrl: event.prUrl };
    case "job.held":
      return { ...base, type: event.type, effort: event.effort };
    case "job.failed":
      return { ...base, error: event.error };
  }
}

/**
 * Compone il body posto al webhook per il formato dato. Unica fonte di verità
 * condivisa da dispatch reale, anteprima web e documentazione.
 */
export function formatNotification(
  event: NotificationEvent,
  format: NotificationFormat,
): FormattedNotification {
  const contentType = "application/json";
  switch (format) {
    case "slack":
      return { contentType, body: formatSlack(event) };
    case "discord":
      return { contentType, body: formatDiscord(event) };
    case "generic":
      return { contentType, body: formatGeneric(event) };
  }
}

/**
 * Un evento d'esempio REALISTICO per ciascun `kind`, con i link ancorati a
 * `baseUrl`. Usato dall'anteprima dal vivo della UI e dagli esempi nella
 * documentazione: stessa forma del dispatch reale.
 */
export function sampleEvents(baseUrl: string): NotificationEvent[] {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    {
      kind: "ticket.created",
      ticketNumber: 128,
      ticketTitle: "TypeError: cannot read 'id' of undefined al checkout",
      projectName: "negozio-web",
      source: "sdk_error",
      ticketUrl: `${base}/tickets/128`,
    },
    {
      kind: "job.pr_opened",
      ticketNumber: 128,
      ticketTitle: "TypeError: cannot read 'id' of undefined al checkout",
      projectName: "negozio-web",
      prUrl: "https://github.com/acme/negozio-web/pull/342",
      ticketUrl: `${base}/tickets/128`,
      costUsd: 0.18,
    },
    {
      kind: "job.pr_closed",
      ticketNumber: 128,
      ticketTitle: "TypeError: cannot read 'id' of undefined al checkout",
      projectName: "negozio-web",
      prUrl: "https://github.com/acme/negozio-web/pull/342",
      ticketUrl: `${base}/tickets/128`,
    },
    {
      kind: "job.held",
      ticketNumber: 131,
      ticketTitle: "Aggiungere export CSV allo storico ordini",
      projectName: "negozio-web",
      type: "feature",
      effort: 4,
      ticketUrl: `${base}/tickets/131`,
    },
    {
      kind: "job.failed",
      ticketNumber: 129,
      ticketTitle: "Pagamento non confermato dopo il redirect",
      projectName: "negozio-web",
      error: "test suite fallita dopo il fix (3 test rossi)",
      ticketUrl: `${base}/tickets/129`,
    },
  ];
}
