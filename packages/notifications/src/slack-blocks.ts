/**
 * BLOCK KIT del DM d'inbox: il messaggio Slack che porta una notifica e i
 * bottoni per agirci sopra.
 *
 * Modulo puro (solo `@stubwise/i18n`): lo usa il poller delle consegne del
 * worker per comporre il DM e lo usa il server per riscriverlo dopo un'azione.
 * La forma dei blocchi è un CONTRATTO con l'handler `block_actions`
 * (`apps/server/src/slack/routes.ts`), che rilegge:
 *
 *  - `action_id = "inbox:<ActionId>"` — quale azione è stata premuta. Fanno
 *    eccezione i bottoni DINAMICI della domanda dell'agente
 *    (`inbox:answer:<indice>` e `inbox:answer_free`, vedi
 *    {@link buildQuestionBlocks}): non sono `ActionId`, ma eseguono `answer`;
 *  - `block_id = "inbox:<notificationId>"` — su QUALE notifica. È il carrier
 *    autorevole dell'id: Slack rimanda il `value` dei bottoni ma NON quello di
 *    un `static_select` (di cui manda `selected_option.value`), quindi il menù
 *    dello snooze non potrebbe portarsi dietro l'id in altro modo;
 *  - `value = notificationId` sui bottoni (ridondante col `block_id`, comodo
 *    per l'handler che legge solo `actions[0]`);
 *  - `selected_option.value` = la durata dello snooze (`1h|tomorrow|3d`).
 *
 * LINGUA: le etichette seguono la lingua del DESTINATARIO (`users.language`),
 * non quella dell'istanza — il DM è personale.
 */
import { t, type Language } from "@stubwise/i18n";
import { SNOOZE_OPTIONS, type ActionId, type SnoozeUntil } from "./actions.js";
import { escapeSlackMrkdwn, type AgentQuestionOption } from "./format.js";

/**
 * Un blocco Block Kit. Non tipizziamo l'intero schema di Slack: il payload è
 * JSON che viaggia verso l'API, e la forma la garantiscono i test.
 */
export type SlackBlock = Record<string, unknown>;

/** Prefisso degli `action_id` dell'inbox: distingue i nostri dai bottoni del flusso ticket. */
const ACTION_PREFIX = "inbox:";

/** `block_id` del blocco azioni: `inbox:<notificationId>`. */
export function inboxBlockId(notificationId: string): string {
  return `${ACTION_PREFIX}${notificationId}`;
}

/**
 * Estrae il `notificationId` da un `block_id` dell'inbox, o `null` se il blocco
 * non è nostro (interazione di un altro flusso, o messaggio di una versione
 * precedente). Speculare a {@link inboxBlockId}.
 */
export function parseInboxBlockId(blockId: string | undefined | null): string | null {
  if (!blockId?.startsWith(ACTION_PREFIX)) return null;
  const id = blockId.slice(ACTION_PREFIX.length);
  return id === "" ? null : id;
}

/** Chiave i18n dell'etichetta di ciascuna azione. */
const LABEL_KEY: Record<ActionId, string> = {
  approve_plan: "notify.action.approvePlan",
  reject_plan: "notify.action.rejectPlan",
  relaunch: "notify.action.relaunch",
  // FALLBACK: i bottoni della domanda sono uno per opzione e li compone il
  // renderer dedicato del kind `job.awaiting_input`. Questa etichetta generica
  // vale solo se `answer` finisce fra le azioni di un DM standard.
  answer: "notify.action.answer",
  open: "notify.action.open",
  snooze: "notify.action.snooze",
  handled: "notify.action.handled",
};

/** Chiave i18n dell'etichetta di ciascuna durata di snooze. */
const SNOOZE_LABEL_KEY: Record<SnoozeUntil, string> = {
  "1h": "notify.action.snooze1h",
  tomorrow: "notify.action.snoozeTomorrow",
  "3d": "notify.action.snooze3d",
};

/**
 * Stile del bottone: verde su "approva", rosso su "rifiuta", neutro su tutto il
 * resto (Slack ammette solo `primary`/`danger`, e usarli ovunque li svuota).
 */
const STYLE: Partial<Record<ActionId, "primary" | "danger">> = {
  approve_plan: "primary",
  reject_plan: "danger",
};

/** Testo `plain_text` di Slack (emoji abilitate: le etichette non ne hanno, ma è il default). */
function plainText(text: string): SlackBlock {
  return { type: "plain_text", text, emoji: true };
}

/**
 * Un elemento interattivo dell'inbox, o `null` se non c'è nulla da mostrare
 * (`open` senza URL). Condiviso fra i DM standard e quelli della domanda, così
 * apri/rinvia/gestita hanno una definizione sola.
 */
function actionElement(
  action: ActionId,
  ctx: { notificationId: string; url?: string; lang: Language },
): SlackBlock | null {
  const { notificationId, url, lang } = ctx;
  if (action === "open") {
    // Senza URL non c'è nulla da aprire: meglio nessun bottone che un link
    // rotto.
    if (!url) return null;
    return {
      type: "button",
      action_id: `${ACTION_PREFIX}open`,
      text: plainText(t(lang, LABEL_KEY.open)),
      url,
      value: notificationId,
    };
  }
  if (action === "snooze") {
    return {
      type: "static_select",
      action_id: `${ACTION_PREFIX}snooze`,
      placeholder: plainText(t(lang, LABEL_KEY.snooze)),
      options: SNOOZE_OPTIONS.map((until) => ({
        text: plainText(t(lang, SNOOZE_LABEL_KEY[until])),
        value: until,
      })),
    };
  }
  const style = STYLE[action];
  return {
    type: "button",
    action_id: `${ACTION_PREFIX}${action}`,
    text: plainText(t(lang, LABEL_KEY[action])),
    value: notificationId,
    ...(style ? { style } : {}),
  };
}

export interface InboxBlocksInput {
  /** Testo mrkdwn della notifica (da `formatNotification(event, "slack", lang)`). */
  text: string;
  /** Azioni offerte al DESTINATARIO, già filtrate da `actionsFor`. */
  actions: ActionId[];
  /** Riga d'inbox a cui i bottoni si riferiscono. */
  notificationId: string;
  /** Dove porta il bottone "Apri". Assente ⇒ nessun bottone link. */
  url?: string;
  /** Lingua del destinatario. */
  lang: Language;
}

/**
 * Compone i blocchi del DM: una `section` col testo della notifica e — se c'è
 * almeno un elemento interattivo — un blocco `actions` con i bottoni nell'ordine
 * in cui `actionsFor` li ha calcolati (decisioni prima, igiene dopo).
 *
 * `open` diventa un bottone LINK (`url`): Slack lo apre da solo. Genera comunque
 * un `block_actions` verso di noi, che l'handler ignora (ack e basta) — per
 * questo ha un `action_id` come gli altri.
 *
 * Senza elementi interattivi (aggiornamento post-azione: `actions: []`) NON si
 * emette un blocco `actions` vuoto, che Slack rifiuterebbe.
 */
export function buildInboxBlocks(input: InboxBlocksInput): SlackBlock[] {
  const { text, actions, notificationId, url, lang } = input;
  const blocks: SlackBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];

  const elements: SlackBlock[] = [];
  for (const action of actions) {
    const element = actionElement(action, { notificationId, lang, ...(url ? { url } : {}) });
    if (element) elements.push(element);
  }

  if (elements.length > 0) {
    blocks.push({ type: "actions", block_id: inboxBlockId(notificationId), elements });
  }
  return blocks;
}

// --- DM della DOMANDA dell'agente (`job.awaiting_input`) -------------------

/**
 * `action_id` del bottone di una singola opzione: `inbox:answer:<indice>`.
 * L'indice è l'unico dato che il click deve portarsi dietro — l'etichetta la
 * legge il servizio dalla domanda persistita, non dal payload di Slack.
 */
export function answerActionId(optionIndex: number): string {
  return `${ACTION_PREFIX}answer:${optionIndex}`;
}

/** `action_id` del bottone "Altro…", che apre il modal del testo libero. */
export const ANSWER_FREE_ACTION_ID = `${ACTION_PREFIX}answer_free`;

/**
 * Opzioni rese come bottoni. Il contratto del tool `ask_user` ne ammette 2–4:
 * il tetto qui è una cintura di sicurezza su un payload jsonb scritto da
 * chissà quale versione, non un limite di Slack (un blocco `actions` ne regge
 * fino a 25).
 */
const MAX_OPTIONS = 4;

/** Tetto Slack al `plain_text` di un bottone. */
const BUTTON_TEXT_MAX = 75;

/** Tetto Slack al testo mrkdwn di una `section`. */
const SECTION_TEXT_MAX = 3000;

/**
 * Quanto di una conseguenza entra nella sezione. Non è un limite di Slack: è
 * leggibilità: il DM si legge dal telefono, e un paragrafo per opzione lo
 * renderebbe un muro.
 */
const CONSEQUENCE_MAX = 240;

/** Marcatore dell'opzione consigliata dall'agente (bottone e sezione). */
const RECOMMENDED_MARK = "⭐";

/**
 * Tronca entro `max` caratteri, con l'ellissi finale. La PAROLA in coda può
 * restare a metà — quello che conta è stare dentro i tetti di Slack — ma un
 * CARATTERE no: si accumula per punto di codice, così un'etichetta che contiene
 * un'emoji non viene spezzata a metà della coppia di surrogati (uno `slice`
 * secco lo farebbe, e sul bottone arriverebbe un carattere rotto).
 *
 * Il tetto resta contato in code unit UTF-16 (`length`), che è la misura più
 * prudente rispetto a quella di Slack.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = "";
  for (const point of text) {
    // -1: l'ellissi occupa l'ultimo posto.
    if (kept.length + point.length > max - 1) break;
    kept += point;
  }
  return `${kept.trimEnd()}…`;
}

/** La domanda come serve a questi blocchi, estratta dal payload dell'evento. */
interface QuestionForBlocks {
  options: AgentQuestionOption[];
  recommendedIndex: number | null;
  allowFreeText: boolean;
}

/**
 * Le opzioni da rendere come bottoni, o `[]` se l'elenco non è utilizzabile.
 *
 * L'INDICE È IL DATO: `inbox:answer:<i>` viaggia da solo fino ad
 * `answerQuestion`, che lo valida contro le opzioni PERSISTITE guardandone solo
 * il range. Se il payload e la riga `agent_questions` divergessero, un elenco
 * ricompattato qui registrerebbe in silenzio una scelta DIVERSA da quella
 * letta — il fallimento peggiore per un recinto difensivo.
 *
 * Perciò: una sola voce inutilizzabile ⇒ `[]`, cioè nessun bottone di opzione
 * (resta "Altro…" se c'è il testo libero, altrimenti i blocchi standard). Il
 * taglio a {@link MAX_OPTIONS} invece resta: è un taglio di PREFISSO, gli
 * indici 0…3 restano quelli della riga persistita.
 */
function readOptions(raw: unknown): AgentQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AgentQuestionOption[] = [];
  for (const item of raw.slice(0, MAX_OPTIONS)) {
    if (typeof item !== "object" || item === null) return [];
    const { label, consequence } = item as { label?: unknown; consequence?: unknown };
    if (typeof label !== "string" || label.trim() === "") return [];
    options.push({
      label: label.trim(),
      ...(typeof consequence === "string" && consequence.trim() !== ""
        ? { consequence: consequence.trim() }
        : {}),
    });
  }
  return options;
}

/**
 * RECINTO attorno al payload: `notifications.event` è jsonb e può venire da una
 * versione precedente o essere marcio. Ritorna `null` quando non c'è nulla di
 * rispondibile (nessuna opzione utilizzabile e nessun testo libero): il
 * chiamante degrada ai blocchi standard invece di mostrare bottoni che non
 * possono funzionare.
 */
function readQuestion(event: unknown): QuestionForBlocks | null {
  if (typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;
  const allowFreeText = raw.allowFreeText === true;
  const options = readOptions(raw.options);
  if (options.length === 0 && !allowFreeText) return null;
  const recommended = raw.recommendedIndex;
  return {
    options,
    recommendedIndex:
      typeof recommended === "number" &&
      Number.isInteger(recommended) &&
      recommended >= 0 &&
      recommended < options.length
        ? recommended
        : null,
    allowFreeText,
  };
}

export interface QuestionBlocksInput {
  /** Testo mrkdwn della notifica: contiene già la domanda e il link al ticket. */
  text: string;
  /** Payload GREZZO della notifica `job.awaiting_input` (jsonb, non fidato). */
  event: unknown;
  /** Azioni offerte al DESTINATARIO (`actionsFor`): senza `answer` non si risponde. */
  actions: ActionId[];
  notificationId: string;
  /** Dove porta il bottone "Apri". Assente ⇒ nessun bottone link. */
  url?: string;
  /** Lingua del destinatario. */
  lang: Language;
}

/**
 * Blocchi del DM di una DOMANDA dell'agente: al posto del bottone generico
 * "Rispondi" ci sono i bottoni delle opzioni, uno per scelta, più "Altro…" se
 * l'agente accetta anche il testo libero.
 *
 * Tre blocchi: il testo della notifica (che porta già la domanda), la SEZIONE
 * delle opzioni con le conseguenze — che nei bottoni non ci starebbero, e sono
 * metà del significato di una scelta — e i bottoni. Il click esegue subito, di
 * proposito: la conferma a due passi è della card web, qui la corsa la protegge
 * il "ha già risposto X" del servizio.
 *
 * DEGRADO: se il destinatario non può rispondere (job ripartito) o il payload
 * non contiene una domanda utilizzabile, tornano i blocchi standard SENZA
 * `answer` — un bottone generico non potrebbe portare né un'opzione né un
 * testo, e premerlo darebbe sempre errore. Si risponde dal ticket, che il
 * bottone "Apri" raggiunge.
 */
export function buildQuestionBlocks(input: QuestionBlocksInput): SlackBlock[] {
  const { text, actions, notificationId, url, lang } = input;
  const question = actions.includes("answer") ? readQuestion(input.event) : null;
  if (!question) {
    return buildInboxBlocks({
      text,
      actions: actions.filter((action) => action !== "answer"),
      notificationId,
      lang,
      ...(url ? { url } : {}),
    });
  }

  const lines = question.options.map((option, index) => {
    const recommended =
      index === question.recommendedIndex
        ? ` ${RECOMMENDED_MARK} _(${t(lang, "comment.agentQuestionRecommended")})_`
        : "";
    const consequence = option.consequence
      ? `\n${escapeSlackMrkdwn(truncate(option.consequence, CONSEQUENCE_MAX))}`
      : "";
    return `${index + 1}. *${escapeSlackMrkdwn(option.label)}*${recommended}${consequence}`;
  });

  const elements: SlackBlock[] = question.options.map((option, index) => {
    const prefix = `${index + 1}. `;
    const suffix = index === question.recommendedIndex ? ` ${RECOMMENDED_MARK}` : "";
    return {
      type: "button",
      action_id: answerActionId(index),
      // L'etichetta è dell'agente: sta nei 75 caratteri del bottone, prefisso e
      // stella compresi (il numero la lega alla riga della sezione, che è dove
      // si leggono le conseguenze).
      text: plainText(
        `${prefix}${truncate(option.label, BUTTON_TEXT_MAX - prefix.length - suffix.length)}${suffix}`,
      ),
      value: notificationId,
    };
  });
  if (question.allowFreeText) {
    elements.push({
      type: "button",
      action_id: ANSWER_FREE_ACTION_ID,
      text: plainText(t(lang, "notify.inbox.answerOther")),
      value: notificationId,
    });
  }
  for (const action of actions) {
    if (action === "answer") continue;
    const element = actionElement(action, { notificationId, lang, ...(url ? { url } : {}) });
    if (element) elements.push(element);
  }

  const blocks: SlackBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (lines.length > 0) {
    blocks.push({
      type: "section",
      // Riga vuota fra un'opzione e l'altra: il DM si legge dal telefono, e
      // senza respiro le conseguenze si confondono con l'etichetta successiva.
      text: { type: "mrkdwn", text: truncate(lines.join("\n\n"), SECTION_TEXT_MAX) },
    });
  }
  blocks.push({ type: "actions", block_id: inboxBlockId(notificationId), elements });
  return blocks;
}
