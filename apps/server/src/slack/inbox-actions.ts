/**
 * AZIONI DELL'INBOX PREMUTE DA SLACK: la parte non-HTTP dell'handler
 * `block_actions` (e del `view_submission` del modal di rifiuto) di
 * `./routes.ts`, tenuta fuori dalle rotte perché è la parte con delle regole.
 *
 * Il servizio `../services/inbox.ts` resta l'UNICO arbitro di permessi, stato e
 * propagazione: qui si traduce soltanto fra il mondo Slack e il suo contratto —
 * chi ha premuto (identità RI-RISOLTA, mai presa dal payload), com'è finita
 * (testo effimero o messaggio riscritto) e chi altro va avvisato.
 *
 * COME SI AGGIORNANO LE COPIE. Una decisione chiude in blocco le notifiche di
 * tutti i destinatari, e ogni copia è un DM Slack a sé. Ad accodarne
 * l'aggiornamento (una riga `slack_update` per copia, che il poller del worker
 * consuma riscrivendo quel DM: è lui a conoscere il `ts` dei messaggi, in
 * `notification_deliveries.external_ref`) è il SERVIZIO, non questo file —
 * `services/notifications-propagation.ts`, chiamato da `resolvePlan` e da
 * `executeAction`. Così i DM si aggiornano anche quando a decidere è la pagina
 * ticket o l'inbox web, che di Slack non sanno nulla.
 *
 * Qui resta solo la scorciatoia per CHI HA PREMUTO: il suo messaggio si
 * riscrive subito via `response_url` (`replace_original`), perché il feedback
 * dev'essere immediato e non fra un tick del poller.
 *
 * LINGUA: gli errori e la nota della propria copia sono nella lingua di CHI HA
 * PREMUTO (`users.language`); la nota di ogni copia altrui in quella del SUO
 * destinatario — il DM è personale, e la nota si legge dentro al suo messaggio.
 */
import { notifications, users, type Db } from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import {
  buildInboxBlocks,
  formatNotification,
  openUrl,
  type ActionId,
  type NotificationEvent,
  type NotificationKind,
  type SlackBlock,
  type SnoozeUntil,
} from "@stubwise/notifications";
import { eq } from "drizzle-orm";
import { resolveReporter, resolveReporterBySlackId } from "../ingest/reporter.js";
import { executeAction, type ExecuteActionResult } from "../services/inbox.js";
// La nota di stato e l'accodamento degli aggiornamenti vivono nel modulo
// condiviso `services/notifications-propagation.ts`: da lì li usa anche
// `resolvePlan`, così una decisione presa dalla pagina ticket aggiorna i DM
// esattamente come una presa da qui. Qui serve solo la nota, per il messaggio
// che si riscrive al volo via `response_url`.
import { inboxNote } from "../services/notifications-propagation.js";

/** Prefisso degli `action_id` dei bottoni dell'inbox (`buildInboxBlocks`). */
const ACTION_PREFIX = "inbox:";

/**
 * Azioni dell'inbox riconosciute su Slack (l'insieme di `ActionId`). Esportata
 * perché il test di parità in `../notification-kinds.test.ts` la confronta con
 * `inboxActionSchema` di `@stubwise/shared`: sono due liste della stessa cosa e
 * si disallineerebbero in silenzio.
 */
export const INBOX_ACTIONS: readonly ActionId[] = [
  "approve_plan",
  "reject_plan",
  "relaunch",
  "answer",
  "open",
  "snooze",
  "handled",
];

/**
 * Estrae l'azione da un `action_id` di Slack, o `null` se il bottone non è
 * dell'inbox (un altro flusso, o un messaggio di una versione precedente con
 * un'azione che non esiste più). Speculare al prefisso di `buildInboxBlocks`.
 */
export function parseInboxActionId(actionId: string | undefined | null): ActionId | null {
  if (!actionId?.startsWith(ACTION_PREFIX)) return null;
  const action = actionId.slice(ACTION_PREFIX.length);
  return (INBOX_ACTIONS as readonly string[]).includes(action) ? (action as ActionId) : null;
}

/**
 * Chi ha premuto, risolto dal DB. Porta il ruolo (che decide i permessi), la
 * lingua (in cui gli si risponde) e l'email (che compare nella nota vista dagli
 * altri destinatari).
 */
export interface SlackInboxActor {
  id: string;
  role: "admin" | "member";
  email: string;
  language: Language;
}

/** Il minimo del client Slack che serve qui: il profilo per il fallback email. */
export interface SlackProfileClient {
  getUserProfile(userId: string): Promise<{ email: string | null } | null>;
}

/**
 * Risolve lo Slack user id in un utente Stubwise. Prima il match diretto su
 * `users.slack_user_id` (indicizzato, nessuna chiamata a Slack), poi il
 * fallback sull'email del profilo Slack.
 *
 * NIENTE AUTO-LINK, a differenza della creazione ticket: lì il match per email
 * serve solo ad attribuire un ticket, qui autorizza una DECISIONE su un job.
 * Scrivere `slack_user_id` come effetto collaterale di un click legherebbe per
 * sempre due identità sulla base di un'email che nessuno ha verificato in
 * Stubwise: il collegamento resta un atto esplicito, dalle impostazioni.
 *
 * `null` se l'utente non è collegato (o se Slack non dà il profilo): il
 * chiamante risponde con l'effimero "collega l'account".
 */
export async function resolveSlackActor(
  db: Db,
  client: SlackProfileClient,
  slackUserId: string | undefined,
): Promise<SlackInboxActor | null> {
  if (!slackUserId) return null;
  let userId = await resolveReporterBySlackId(db, slackUserId);
  if (userId === null) {
    // Best-effort: se Slack non risponde, l'utente resta non risolto (effimero
    // "collega l'account") invece di far fallire l'interazione.
    let email: string | null = null;
    try {
      email = (await client.getUserProfile(slackUserId))?.email ?? null;
    } catch {
      email = null;
    }
    userId = await resolveReporter(db, email);
  }
  if (userId === null) return null;

  const [row] = await db
    .select({ id: users.id, role: users.role, email: users.email, language: users.language })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

/** Testo effimero dell'esito negativo, nella lingua di chi ha premuto. */
export function inboxErrorText(
  lang: Language,
  result: Extract<ExecuteActionResult, { ok: false }>,
): string {
  switch (result.error) {
    case "not_found":
      // Anche per la notifica di un ALTRO utente: non se ne rivela l'esistenza.
      return t(lang, "notify.inbox.errNotFound");
    case "forbidden":
      return t(lang, "notify.inbox.errForbidden");
    case "invalid_action":
      return t(lang, "notify.inbox.errInvalidAction");
    case "already_handled":
      return result.handledBy
        ? t(lang, "notify.inbox.errAlreadyHandled", { actor: result.handledBy.email })
        : t(lang, "notify.inbox.errAlreadyHandledUnknown");
    case "job_in_flight":
      return t(lang, "notify.inbox.errJobInFlight", { status: result.jobStatus ?? "running" });
    case "plan_not_pending":
      return t(lang, "notify.inbox.errPlanNotPending");
    case "invalid_answer":
      return t(lang, "notify.inbox.errInvalidAnswer");
    case "question_not_pending":
      // La domanda è già stata risposta da qualcuno: `already_handled` (con il
      // nome) copre il caso normale, questo resta per il job ripartito.
      return t(lang, "notify.inbox.errQuestionNotPending");
  }
}

/**
 * RECINTO attorno alla resa del testo dal jsonb, gemello di quelli del servizio
 * inbox e del poller del worker: `notifications.event` può essere stato scritto
 * da una versione precedente, e un payload marcio non deve impedire di
 * riscrivere il messaggio. Degrada al `kind` (colonna enum, affidabile).
 */
function renderSlack(
  rawEvent: Record<string, unknown>,
  kind: NotificationKind,
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

/** Testo e blocchi del messaggio riscritto: la notifica com'era, più la nota, senza bottoni. */
async function updatedMessage(
  db: Db,
  notificationId: string,
  lang: Language,
  note: string,
): Promise<{ text: string; blocks: SlackBlock[] }> {
  const [row] = await db
    .select({ kind: notifications.kind, event: notifications.event })
    .from(notifications)
    .where(eq(notifications.id, notificationId));
  // Notifica sparita fra l'azione e la riscrittura (cancellazione a cascata):
  // il messaggio porta almeno la nota.
  const { text } = row ? renderSlack(row.event, row.kind, lang) : { text: "" };
  const updated = text ? `${text}\n\n${note}` : note;
  return {
    text: updated,
    // Nessuna azione: una notifica già decisa non si ridecide dal messaggio
    // vecchio (chi ci provasse otterrebbe un `already_handled`).
    blocks: buildInboxBlocks({ text: updated, actions: [], notificationId, lang }),
  };
}

export interface InboxActionDeps {
  db: Db;
  /** POST best-effort verso il `response_url` dell'interazione. */
  postResponse: (url: string, payload: unknown) => Promise<void>;
  /** PUBLIC_URL, per i link delle notifiche che un rilancio emette. */
  publicUrl?: string;
}

export interface InboxActionInput {
  actor: SlackInboxActor;
  notificationId: string;
  /** `open` non arriva qui: è un bottone link, l'handler si ferma all'ack. */
  action: Exclude<ActionId, "open">;
  /** Durata scelta nel menù dello snooze (`selected_option.value`). */
  until?: string;
  /** `response_url` del messaggio da riscrivere. Assente ⇒ nessun feedback diretto. */
  responseUrl?: string;
}

/**
 * Esegue l'azione e rispecchia l'esito su Slack. Da chiamare DOPO l'ack (il
 * lavoro è più lento dei 3 secondi che Slack concede): non lancia mai, ogni
 * errore diventa un messaggio.
 */
export async function runInboxAction(
  deps: InboxActionDeps,
  input: InboxActionInput,
): Promise<void> {
  const { db, postResponse } = deps;
  const { actor, notificationId, action, responseUrl } = input;

  const result = await executeAction(db, {
    notificationId,
    action,
    // Identità dal DB, MAI dal payload di Slack.
    actor: { id: actor.id, role: actor.role },
    // `until` arriva dal menù: se non è una durata ammessa, il servizio
    // risponde `invalid_action` (la validazione è sua, non nostra).
    ...(action === "snooze" ? { payload: { until: input.until as SnoozeUntil } } : {}),
    ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
  });

  if (!result.ok) {
    if (responseUrl) {
      await postResponse(responseUrl, {
        response_type: "ephemeral",
        // L'effimero NON sostituisce il messaggio: i bottoni restano, l'azione
        // non è avvenuta e l'utente può riprovare (o farlo fare a un admin).
        replace_original: false,
        text: inboxErrorText(actor.language, result),
      });
    }
    return;
  }

  const noteArgs = {
    actor: actor.email,
    ...(result.snoozedUntil ? { snoozedUntil: result.snoozedUntil } : {}),
  };

  // 1) La propria copia, subito: riscritta sul posto via response_url.
  if (responseUrl) {
    const note = inboxNote(action, actor.language, noteArgs);
    const message = await updatedMessage(db, notificationId, actor.language, note);
    await postResponse(responseUrl, {
      replace_original: true,
      text: message.text,
      blocks: message.blocks,
    });
  }

  // 2) Le copie di TUTTI i destinatari (la propria inclusa) sono già in coda:
  // le accoda il servizio insieme alla chiusura delle righe, perché lo stesso
  // accada quando la decisione arriva dalla pagina ticket o dall'inbox web.
  // La riscrittura qui sopra è solo un'ottimizzazione di immediatezza: il DM di
  // chi ha premuto verrà riscritto una seconda volta dal poller con lo STESSO
  // contenuto (`sendSlackUpdate` porta il messaggio a uno stato finale
  // deterministico, quindi è idempotente). Una `chat.update` in più su
  // un'azione a ritmo umano, in cambio di un solo posto che sa chi va
  // aggiornato.
}
