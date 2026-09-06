/**
 * Formattazione PURA delle notifiche in uscita di Stubwise.
 *
 * Questo modulo è la SINGOLA fonte di verità su COME un evento diventa il body
 * postato al webhook (Slack / Discord / JSON generico). Il dispatch effettivo
 * (lettura config, gating, POST best-effort) vive in `./dispatch.ts` e riusa
 * `formatNotification`.
 *
 * ⚠️ LA PUREZZA QUI NON È UNA CONVENZIONE, È UN INVARIANTE VERIFICATO. Questo
 * file sta nel grafo dell'entry client `./pure.ts`, quindi non può importare
 * `@stubwise/db`, `drizzle-orm` o un builtin di Node — né direttamente né
 * attraverso un modulo che importa. Non è una raccomandazione da soppesare:
 * `pure.test.ts` ricostruisce quel grafo e diventa rosso, perché un import di
 * troppo qui rompe il bundle dell'app mobile.
 */

import { t, type Language } from "@stubwise/i18n";

/** Formato del messaggio: combacia con l'enum DB `notification_format`. */
export type NotificationFormat = "slack" | "discord" | "generic";

/** Lingua dei testi della notifica (riusa il type di `@stubwise/i18n`). */
export type { Language };

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

/**
 * La pianificazione AI ha prodotto un piano in attesa di approvazione umana
 * (gate `plan_approval_min_effort`): il job è parcheggiato finché un umano
 * approva o rifiuta il piano.
 */
export interface JobPlanReviewEvent {
  kind: "job.plan_review";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  ticketUrl: string;
}

/**
 * Una singola scelta offerta dalla domanda dell'agente: l'etichetta che l'umano
 * vede sul bottone e, quando serve, la conseguenza che quella scelta comporta.
 */
export interface AgentQuestionOption {
  label: string;
  consequence?: string;
}

/**
 * La pianificazione AI si è fermata su un bivio: l'agente ha posto una domanda
 * strutturata e il job è parcheggiato in `awaiting_input` finché non arriva una
 * risposta.
 *
 * L'evento porta la domanda INTERA (non solo il suo id) perché ogni superficie
 * — inbox web, DM Slack, webhook — deve poterla rendere senza risalire ad
 * `agent_questions`.
 */
export interface JobAwaitingInputEvent {
  kind: "job.awaiting_input";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  ticketUrl: string;
  /** Id della riga `agent_questions`: è l'ancora su cui si risponde. */
  questionId: string;
  /** Round di domanda del run di pianificazione (1 = la prima). */
  round: number;
  question: string;
  /** Da 2 a 4 opzioni, nell'ordine in cui vanno mostrate. */
  options: AgentQuestionOption[];
  /** Indice dell'opzione consigliata dall'agente, se ne ha una. */
  recommendedIndex?: number;
  /** L'agente accetta anche una risposta in testo libero. */
  allowFreeText: boolean;
}

/**
 * Il budget di spesa AI è stato superato: il job resta in pausa finché un umano
 * non lo avvia manualmente per forzare. Lo `scope` indica se il limite sforato è
 * quello del singolo ticket o quello mensile dell'istanza.
 */
export interface JobBudgetHeldEvent {
  kind: "job.budget_held";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  /** Ambito del limite sforato: del singolo ticket o mensile. */
  scope: "ticket" | "monthly";
  /** Limite di spesa USD configurato. */
  limitUsd: number;
  /** Spesa USD effettiva che ha superato il limite. */
  spentUsd: number;
  ticketUrl: string;
}

/** Review AI di una PR completata (automazione PR Review). */
export interface ReviewCompletedEvent {
  kind: "review.completed";
  ticketNumber: number;
  ticketTitle: string;
  projectName: string;
  ticketUrl: string;
  prUrl: string;
  /** Verdetto della review. */
  verdict: "approve" | "request_changes";
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

/** Generazione Docs in pausa per limite di utilizzo del provider (nessun ticket). */
export interface DocsLimitPausedEvent {
  kind: "docs.limit_paused";
  projectName: string;
  repositoryName: string;
  /** URL della pagina Docs del repository (al posto del ticketUrl). */
  docsUrl: string;
  reason: string;
}

/** Condizione che ha scatenato un alert di monitoraggio (o il suo rientro). */
export type MonitorCondition = "offline" | "cpu" | "mem" | "disk" | "check_down";

/**
 * Un server monitorato ha superato una soglia (CPU/memoria/disco), è andato
 * offline o un suo check è caduto. Evento SENZA ticket: il link porta alla
 * pagina del server nella SPA.
 */
export interface MonitorAlertEvent {
  kind: "monitor.alert";
  serverName: string;
  condition: MonitorCondition;
  /** Descrizione già leggibile, es. "disco al 93% (soglia 90%)". */
  detail: string;
  /** Link alla pagina del server nella SPA (al posto del ticketUrl). */
  url: string;
}

/** Il server (o il suo check) è rientrato entro le soglie: alert risolto. */
export interface MonitorRecoveredEvent {
  kind: "monitor.recovered";
  serverName: string;
  condition: MonitorCondition;
  /** Descrizione già leggibile, es. "disco rientrato al 72%". */
  detail: string;
  /** Link alla pagina del server nella SPA (al posto del ticketUrl). */
  url: string;
}

/**
 * Urgenza di una proposta del pulse: gli stessi valori dell'enum DB
 * `ticket_priority` (che `backlog_items.urgency` riusa). Ridichiarata qui — e
 * non importata — perché questo modulo non deve dipendere da `@stubwise/db`
 * (vedi il docblock in cima).
 */
export type PulseUrgency = "low" | "medium" | "high" | "urgent";

/**
 * Una voce di backlog PROPOSTA dal pulse: l'ancora alla voce più i metadati che
 * spiegano perché sta lì (sono anche ciò che ne ha deciso l'ordine).
 *
 * `urgency` ed `effort` sono nullable come le colonne che li portano: una voce
 * appena nata può non averli ancora.
 *
 * ⚠️ `title` è TESTO NON FIDATO: lo scrive chi ha creato la voce, e le voci
 * nascono anche dai ticket del widget pubblico, cioè da estranei. Non entra mai
 * nella frase della notifica (vedi {@link KEY_FOR_KIND}); sul DM Slack ci arriva
 * come etichetta dell'opzione, ed è `./slack-blocks.ts` a escaparlo — una volta
 * sola.
 */
export interface PulseProposal {
  backlogItemId: string;
  title: string;
  urgency: PulseUrgency | null;
  effort: number | null;
  /** La voce ha già la sezione "## Analisi tecnica" del deep dive. */
  hasAnalysis: boolean;
}

/**
 * PULSE PROATTIVO: il progetto è fermo da un po' e il backlog ha voci
 * candidabili. Evento SENZA ticket — è ancorato al PROGETTO — il cui link porta
 * alla pagina backlog.
 *
 * Il payload è modellato sulla DOMANDA della fase 1 ({@link
 * JobAwaitingInputEvent}): `question`, `options`, `recommendedIndex`,
 * `allowFreeText`. Non è un'analogia estetica ma la ragione per cui pannello
 * web, blocchi Slack, modal e schemi condivisi funzionano sul pulse senza una
 * riga di codice in più. Le differenze sono deliberate: `allowFreeText` è
 * SEMPRE `false` (si sceglie una proposta o si archivia, non si scrive), e
 * accanto ci sono i campi propri del pulse.
 */
export interface ProjectPulseEvent {
  kind: "project.pulse";
  /**
   * Identifica QUESTO pulse: è la chiave con cui si ritrovano tutte le copie
   * della stessa notifica quando qualcuno sceglie una proposta. Il pulse non ha
   * un job dietro, quindi è l'unica ancora disponibile per la propagazione.
   */
  pulseId: string;
  projectName: string;
  /** Pagina backlog del progetto (al posto del ticketUrl). */
  projectUrl: string;
  /** Da quanti giorni il progetto non ha lavoro in corso. */
  idleDays: number;
  question: string;
  /** Una opzione per proposta, nello stesso ordine di {@link proposals}. */
  options: AgentQuestionOption[];
  /** Indice della proposta consigliata dal ranking (di norma la prima). */
  recommendedIndex?: number;
  /** Sempre `false`: dal pulse si sceglie, non si scrive. */
  allowFreeText: false;
  /** Le voci di backlog dietro le opzioni: è ciò su cui agisce "Procedi". */
  proposals: PulseProposal[];
}

/** Unione tipata di tutti gli eventi che generano una notifica. */
export type NotificationEvent =
  | TicketCreatedEvent
  | PrOpenedEvent
  | PrClosedEvent
  | JobHeldEvent
  | JobPlanReviewEvent
  | JobBudgetHeldEvent
  | ReviewCompletedEvent
  | JobFailedEvent
  | DocsLimitPausedEvent
  | MonitorAlertEvent
  | MonitorRecoveredEvent
  | JobAwaitingInputEvent
  | ProjectPulseEvent;

/**
 * Eventi SENZA ticket (`docs.limit_paused`, `monitor.*`, `project.pulse`): non
 * hanno `ticketNumber`/`ticketTitle`/`ticketUrl`, portano una superficie
 * propria.
 */
type NonTicketedEvent =
  | DocsLimitPausedEvent
  | MonitorAlertEvent
  | MonitorRecoveredEvent
  | ProjectPulseEvent;

/**
 * Eventi ANCORATI A UN TICKET: hanno `ticketNumber`/`ticketTitle`/`ticketUrl`.
 * Il narrowing per-kind dei punti comuni (ref `#n`, base del payload generico)
 * passa da {@link hasTicket}.
 */
type TicketedEvent = Exclude<NotificationEvent, NonTicketedEvent>;

/** Type guard: l'evento è ancorato a un ticket (ha `ticketNumber` & co.). */
function hasTicket(event: NotificationEvent): event is TicketedEvent {
  return (
    event.kind !== "docs.limit_paused" &&
    event.kind !== "monitor.alert" &&
    event.kind !== "monitor.recovered" &&
    event.kind !== "project.pulse"
  );
}

/** Chiave catalogo dell'etichetta condizione per il monitoraggio. */
const MONITOR_CONDITION_KEY: Record<MonitorCondition, string> = {
  offline: "notify.monitorCondition.offline",
  cpu: "notify.monitorCondition.cpu",
  mem: "notify.monitorCondition.mem",
  disk: "notify.monitorCondition.disk",
  check_down: "notify.monitorCondition.checkDown",
};

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
//
// I TESTI delle frasi vivono in `@stubwise/i18n` (chiavi `notify.*`), una sola
// chiave per evento valida per tutti i formati. Ciò che differisce tra Slack /
// Discord / generic — l'emoji, il rendering del riferimento al ticket (`#42`) e
// dei link — è MARKUP, non testo, e resta gestito qui per formato:
//   - `{ref}`  → `*#42*` (Slack) · `**#42**` (Discord) · `#42` (generic)
//   - `{link}` → `<url|label>` (Slack) · `[label](url)` (Discord) · "" (generic)
//   - `{cost}` → suffisso costo localizzato (`notify.costSuffix`) o vuoto
//   - emoji    → anteposta per Slack/Discord, assente nel payload generico

/** Emoji prefisso (Slack/Discord) per ciascun evento. */
const EMOJI: Record<NotificationKind, string> = {
  "ticket.created": "🐛",
  "job.pr_opened": "✅",
  "job.pr_closed": "🔁",
  "job.held": "⏸️",
  "job.plan_review": "📝",
  "job.budget_held": "💸",
  "review.completed": "🔎",
  "job.failed": "❌",
  "docs.limit_paused": "⏸️",
  "monitor.alert": "🔴",
  "monitor.recovered": "🟢",
  "job.awaiting_input": "❓",
  "project.pulse": "📣",
};

/**
 * Escape mrkdwn del testo NON FIDATO che finisce in un messaggio Slack: Slack
 * vuole `&`, `<` e `>` come entità HTML, ed è anche ciò che impedisce a un
 * testo scritto da altri di iniettare un link (`<https://…|Fidati>`) o di
 * fingersi un'altra parte del messaggio. `*` e `_` restano: al massimo sballano
 * il corsivo, non fingono nulla.
 *
 * Vive QUI, insieme al resto della conoscenza del markup Slack ({@link
 * renderLink}), e lo riusa `./slack-blocks.ts` per le etichette dei bottoni
 * della domanda: una sola definizione, applicata UNA SOLA VOLTA per ogni pezzo
 * di testo (il testo della notifica lo escapa {@link formatNotification}, i
 * blocchi lo inseriscono verbatim).
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Rende un link nel markup del formato (mai chiamato per `generic`). */
function renderLink(
  format: "slack" | "discord",
  url: string,
  label: string,
): string {
  return format === "slack" ? `<${url}|${label}>` : `[${label}](${url})`;
}

/** Suffisso costo localizzato, o stringa vuota se assente. */
function costParam(
  lang: Language,
  costUsd: number | null | undefined,
): string {
  return costUsd != null ? t(lang, "notify.costSuffix", { cost: costUsd }) : "";
}

/** Riferimento al ticket (`#42`) nel markup del formato. */
function refParam(format: NotificationFormat, ticketNumber: number): string {
  const ref = `#${ticketNumber}`;
  switch (format) {
    case "slack":
      return `*${ref}*`;
    case "discord":
      return `**${ref}**`;
    case "generic":
      return ref;
  }
}

/** I link (già renderizzati) che chiudono la frase, per evento e formato. */
function linkParam(
  format: "slack" | "discord",
  lang: Language,
  event: NotificationEvent,
): string {
  switch (event.kind) {
    case "ticket.created":
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkOpen"));
    case "job.pr_opened":
    case "job.pr_closed":
    case "review.completed":
      return (
        `${renderLink(format, event.prUrl, t(lang, "notify.linkPr"))} · ` +
        `${renderLink(format, event.ticketUrl, t(lang, "notify.linkTicket"))}`
      );
    case "job.held":
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkOpen"));
    case "job.plan_review":
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkReview"));
    case "job.budget_held":
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkOpen"));
    case "job.failed":
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkOpen"));
    case "job.awaiting_input":
      // Si risponde dalla pagina del ticket (o dalla card d'inbox): il link
      // porta lì, come per gli altri eventi che chiedono un intervento umano.
      return renderLink(format, event.ticketUrl, t(lang, "notify.linkOpen"));
    case "docs.limit_paused":
      // Nessun ticket: il link porta alla pagina Docs del repository.
      return renderLink(format, event.docsUrl, t(lang, "notify.linkDocs"));
    case "monitor.alert":
    case "monitor.recovered":
      // Nessun ticket: il link porta alla pagina del server nella SPA.
      return renderLink(format, event.url, t(lang, "notify.linkServer"));
    case "project.pulse":
      // Nessun ticket: il link porta al backlog del progetto, che è dove si
      // guardano le proposte per intero (la notifica ne porta solo le prime).
      return renderLink(format, event.projectUrl, t(lang, "notify.linkBacklog"));
  }
}

/** Chiave catalogo `notify.*` per ciascun evento. */
const KEY_FOR_KIND: Record<NotificationKind, string> = {
  "ticket.created": "notify.ticketCreated",
  "job.pr_opened": "notify.prOpened",
  "job.pr_closed": "notify.prClosed",
  "job.held": "notify.jobHeld",
  "job.plan_review": "notify.planReview",
  "job.budget_held": "notify.budgetHeld",
  "review.completed": "notify.reviewCompleted",
  "job.failed": "notify.jobFailed",
  "docs.limit_paused": "notify.docsLimitPaused",
  "monitor.alert": "notify.monitorAlert",
  "monitor.recovered": "notify.monitorRecovered",
  "job.awaiting_input": "notify.awaitingInput",
  "project.pulse": "notify.pulse",
};

/** Params (oltre a ref/link/cost) specifici per evento, passati a `t()`. */
function textParams(
  event: NotificationEvent,
  lang: Language,
): Record<string, string | number> {
  // Eventi senza ticket: parametri propri, niente base ticketTitle.
  if (!hasTicket(event)) {
    // Niente `reason`: i template docsLimitPaused non lo interpolano (resta nel
    // payload generic via formatGeneric).
    if (event.kind === "docs.limit_paused") {
      return {
        repositoryName: event.repositoryName,
        projectName: event.projectName,
      };
    }
    // Il pulse nomina il progetto e da quanti giorni è fermo. I TITOLI delle
    // proposte non entrano nella frase: vivono nelle opzioni, che ogni
    // superficie rende a modo suo (bottoni Slack, pannello web).
    if (event.kind === "project.pulse") {
      return { project: event.projectName, idleDays: event.idleDays };
    }
    // monitor.alert | monitor.recovered: la condizione è resa come etichetta
    // localizzata; il detail è già una frase leggibile.
    return {
      serverName: event.serverName,
      condition: t(lang, MONITOR_CONDITION_KEY[event.condition]),
      detail: event.detail,
    };
  }
  const base: Record<string, string | number> = {
    ticketTitle: event.ticketTitle,
    projectName: event.projectName,
  };
  switch (event.kind) {
    case "ticket.created":
      return { ...base, source: event.source };
    case "job.held":
      return { ...base, type: event.type, effort: event.effort };
    case "job.budget_held":
      return {
        ...base,
        scope: t(
          lang,
          event.scope === "ticket" ? "notify.scopeTicket" : "notify.scopeMonthly",
        ),
        limit: event.limitUsd.toFixed(2),
        spent: event.spentUsd.toFixed(2),
      };
    case "review.completed":
      return {
        ...base,
        verdict: t(
          lang,
          event.verdict === "approve"
            ? "notify.verdict.approve"
            : "notify.verdict.requestChanges",
        ),
      };
    case "job.failed":
      return { ...base, error: event.error };
    case "job.awaiting_input":
      return { ...base, question: event.question };
    default:
      return base;
  }
}

/**
 * Parametri il cui contenuto NON è nostro e va escapato prima di finire in un
 * messaggio Slack (vedi {@link escapeSlackMrkdwn}). Solo per il formato
 * `slack`: il testo piano dell'inbox web e il payload `generic` devono restare
 * leggibili, e il markdown di Discord non ha questa sintassi.
 *
 * `question` la scrive l'AGENTE (tool `ask_user`): nasce con la pianificazione
 * interattiva ed è chiusa qui.
 *
 * ⚠️ NON è l'elenco completo dei parametri non fidati: `ticketTitle` (lo scrive
 * chi apre il ticket, widget pubblico incluso), `error` (messaggio d'eccezione
 * o output dell'agente) e `detail` (nome del check e ultimo errore riportato
 * dall'agente sull'host monitorato) hanno la stessa origine. È un vettore
 * PRE-ESISTENTE che riguarda quasi tutti i kind e va chiuso a parte, non di
 * straforo insieme a una feature: finché non lo si fa, questa mappa dice quali
 * pezzi sono coperti e quali no.
 *
 * `project.pulse` NON ha una voce, e non è una dimenticanza: i suoi testi non
 * fidati sono i TITOLI delle voci di backlog (li scrivono gli utenti, widget
 * pubblico compreso), ma quei titoli non passano di qui — la frase del pulse
 * nomina solo progetto e giorni di fermo. Su Slack arrivano come etichette
 * delle opzioni, e le escapa `./slack-blocks.ts`. Aggiungerli qui non
 * escaperebbe nulla oggi, e il giorno in cui la frase li includesse produrrebbe
 * un doppio escape (entità `&amp;amp;`) invece di proteggerli meglio.
 */
const UNTRUSTED_SLACK_PARAMS: Partial<Record<NotificationKind, readonly string[]>> = {
  "job.awaiting_input": ["question"],
};

/**
 * Frase localizzata per un formato con markup (Slack/Discord), inclusi emoji,
 * riferimento `#n` e link. Unica fonte testuale: le chiavi `notify.*`.
 */
function renderText(
  format: "slack" | "discord",
  lang: Language,
  event: NotificationEvent,
): string {
  const cost = event.kind === "job.pr_opened" ? costParam(lang, event.costUsd) : "";
  const params = textParams(event, lang);
  if (format === "slack") {
    for (const name of UNTRUSTED_SLACK_PARAMS[event.kind] ?? []) {
      const value = params[name];
      if (typeof value === "string") params[name] = escapeSlackMrkdwn(value);
    }
  }
  const sentence = t(lang, KEY_FOR_KIND[event.kind], {
    ...params,
    // `{ref}` esiste solo per gli eventi ancorati a un ticket.
    ...(hasTicket(event) ? { ref: refParam(format, event.ticketNumber) } : {}),
    cost,
    link: linkParam(format, lang, event),
  });
  return `${EMOJI[event.kind]} ${sentence}`;
}

/** Corpo Slack: `{ text }` in mrkdwn, link in stile `<url|label>`. */
function formatSlack(event: NotificationEvent, lang: Language): Record<string, unknown> {
  return { text: renderText("slack", lang, event) };
}

/** Corpo Discord: `{ content }` in markdown, link in stile `[label](url)`. */
function formatDiscord(event: NotificationEvent, lang: Language): Record<string, unknown> {
  return { content: renderText("discord", lang, event) };
}

/**
 * Frase di riepilogo localizzata, senza markup né link: il testo PIANO
 * dell'evento. È ciò che finisce nel campo `message` del payload generico ed è
 * anche il testo che l'inbox per-utente mostra nella lingua del destinatario
 * (l'URL su cui portare l'utente è un dato a parte, non un link nella frase).
 *
 * Riusa la stessa chiave `notify.*` degli altri formati — unica fonte testuale:
 * `{link}` è vuoto (gli URL sono campi a parte) e `{ref}` è il `#n` nudo; lo
 * spazio finale lasciato da `{link}` vuoto viene rifilato.
 */
export function formatNotificationText(event: NotificationEvent, lang: Language = "en"): string {
  const cost = event.kind === "job.pr_opened" ? costParam(lang, event.costUsd) : "";
  return t(lang, KEY_FOR_KIND[event.kind], {
    ...textParams(event, lang),
    ...(hasTicket(event) ? { ref: refParam("generic", event.ticketNumber) } : {}),
    cost,
    link: "",
  }).trim();
}

/** Payload generico machine-readable: campi piatti, niente markup. */
function formatGeneric(event: NotificationEvent, lang: Language): Record<string, unknown> {
  // Eventi senza ticket: base propria (superficie dedicata al posto di
  // ticketNumber/title/ticketUrl). Gli eventi con ticket restano INVARIATI.
  if (!hasTicket(event)) {
    if (event.kind === "docs.limit_paused") {
      return {
        event: event.kind,
        projectName: event.projectName,
        repositoryName: event.repositoryName,
        message: formatNotificationText(event, lang),
        docsUrl: event.docsUrl,
        reason: event.reason,
      };
    }
    if (event.kind === "project.pulse") {
      // Payload AUTOSUFFICIENTE: la domanda con le sue opzioni (come per
      // `job.awaiting_input`) più le proposte con l'ancora alla voce di
      // backlog, così chi consuma il webhook sa QUALI voci sono in ballo.
      return {
        event: event.kind,
        pulseId: event.pulseId,
        projectName: event.projectName,
        idleDays: event.idleDays,
        message: formatNotificationText(event, lang),
        projectUrl: event.projectUrl,
        question: event.question,
        options: event.options,
        recommendedIndex: event.recommendedIndex ?? null,
        allowFreeText: event.allowFreeText,
        proposals: event.proposals,
      };
    }
    // monitor.alert | monitor.recovered: la `condition` resta l'enum grezzo
    // (machine-readable), il `detail` la descrizione, `serverUrl` la pagina
    // server (uniforme a ticketUrl/docsUrl degli altri eventi).
    return {
      event: event.kind,
      serverName: event.serverName,
      condition: event.condition,
      detail: event.detail,
      message: formatNotificationText(event, lang),
      serverUrl: event.url,
    };
  }
  const base = {
    event: event.kind,
    ticketNumber: event.ticketNumber,
    title: event.ticketTitle,
    projectName: event.projectName,
    message: formatNotificationText(event, lang),
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
    case "job.plan_review":
      return base;
    case "job.budget_held":
      return {
        ...base,
        scope: event.scope,
        limitUsd: event.limitUsd,
        spentUsd: event.spentUsd,
      };
    case "review.completed":
      return { ...base, prUrl: event.prUrl, verdict: event.verdict };
    case "job.failed":
      return { ...base, error: event.error };
    case "job.awaiting_input":
      // La domanda INTERA nel payload: un consumatore del webhook deve poter
      // capire cosa si sta chiedendo senza chiamare l'API.
      return {
        ...base,
        questionId: event.questionId,
        round: event.round,
        question: event.question,
        options: event.options,
        recommendedIndex: event.recommendedIndex ?? null,
        allowFreeText: event.allowFreeText,
      };
  }
}

/**
 * Compone il body posto al webhook per il formato dato, nella lingua `lang`
 * (default `"en"`). Unica fonte di verità condivisa da dispatch reale, anteprima
 * web e documentazione. I testi vengono da `@stubwise/i18n`; il markup
 * (emoji/ref/link) è applicato per formato.
 */
export function formatNotification(
  event: NotificationEvent,
  format: NotificationFormat,
  lang: Language = "en",
): FormattedNotification {
  const contentType = "application/json";
  switch (format) {
    case "slack":
      return { contentType, body: formatSlack(event, lang) };
    case "discord":
      return { contentType, body: formatDiscord(event, lang) };
    case "generic":
      return { contentType, body: formatGeneric(event, lang) };
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
      kind: "job.plan_review",
      ticketNumber: 131,
      ticketTitle: "Aggiungere export CSV allo storico ordini",
      projectName: "negozio-web",
      ticketUrl: `${base}/tickets/131`,
    },
    {
      kind: "job.budget_held",
      ticketNumber: 131,
      ticketTitle: "Aggiungere export CSV allo storico ordini",
      projectName: "negozio-web",
      scope: "ticket",
      limitUsd: 2,
      spentUsd: 2.34,
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
    {
      kind: "review.completed",
      ticketNumber: 133,
      ticketTitle: "Review PR #351 — refactor del carrello",
      projectName: "negozio-web",
      prUrl: "https://github.com/acme/negozio-web/pull/351",
      ticketUrl: `${base}/tickets/133`,
      verdict: "approve",
    },
    {
      kind: "docs.limit_paused",
      projectName: "negozio-web",
      repositoryName: "negozio-web-api",
      docsUrl: `${base}/docs/8b1f6c2e-1111-4222-8333-444455556666`,
      reason: "limite di rate/usage del provider AI",
    },
    {
      kind: "monitor.alert",
      serverName: "web-prod-1",
      condition: "disk",
      detail: "disco al 93% (soglia 90%)",
      url: `${base}/monitor/servers/9c2f7d3a-2222-4333-8444-555566667777`,
    },
    {
      kind: "monitor.recovered",
      serverName: "web-prod-1",
      condition: "disk",
      detail: "disco rientrato al 72%",
      url: `${base}/monitor/servers/9c2f7d3a-2222-4333-8444-555566667777`,
    },
    {
      kind: "job.awaiting_input",
      ticketNumber: 131,
      ticketTitle: "Aggiungere export CSV allo storico ordini",
      projectName: "negozio-web",
      ticketUrl: `${base}/tickets/131`,
      questionId: "7d4e9a1b-3333-4444-8555-666677778888",
      round: 1,
      question: "L'export deve includere gli ordini annullati?",
      options: [
        { label: "Solo gli ordini validi", consequence: "Il totale coincide con il fatturato." },
        { label: "Tutti, con una colonna di stato" },
      ],
      recommendedIndex: 0,
      allowFreeText: true,
    },
    {
      kind: "project.pulse",
      pulseId: "5b7c2e10-4444-4555-8666-777788889999",
      projectName: "negozio-web",
      projectUrl: `${base}/projects/2e5a8c4b-9999-4aaa-8bbb-ccccddddeeee/backlog`,
      idleDays: 4,
      question: "Nessun lavoro in corso su negozio-web da 4 giorni. Da quale proposta partiamo?",
      options: [
        {
          label: "Aggiungere export CSV allo storico ordini",
          consequence: "urgenza alta · effort 2 · analisi pronta",
        },
        { label: "Filtro per stato nella lista ordini", consequence: "urgenza media · effort 1" },
      ],
      recommendedIndex: 0,
      allowFreeText: false,
      proposals: [
        {
          backlogItemId: "6a155c3a-1111-4222-8333-444455556666",
          title: "Aggiungere export CSV allo storico ordini",
          urgency: "high",
          effort: 2,
          hasAnalysis: true,
        },
        {
          backlogItemId: "8931d96d-1111-4222-8333-444455556666",
          title: "Filtro per stato nella lista ordini",
          urgency: "medium",
          effort: 1,
          hasAnalysis: false,
        },
      ],
    },
  ];
}
