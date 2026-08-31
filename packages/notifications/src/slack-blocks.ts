/**
 * BLOCK KIT del DM d'inbox: il messaggio Slack che porta una notifica e i
 * bottoni per agirci sopra.
 *
 * Modulo puro (solo `@stubwise/i18n`): lo usa il poller delle consegne del
 * worker per comporre il DM e potrà usarlo il server per riscriverlo dopo
 * un'azione. La forma dei blocchi è un CONTRATTO con l'handler `block_actions`
 * (Task 10), che rilegge:
 *
 *  - `action_id = "inbox:<ActionId>"` — quale azione è stata premuta;
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
    if (action === "open") {
      // Senza URL non c'è nulla da aprire: meglio nessun bottone che un link
      // rotto.
      if (!url) continue;
      elements.push({
        type: "button",
        action_id: `${ACTION_PREFIX}open`,
        text: plainText(t(lang, LABEL_KEY.open)),
        url,
        value: notificationId,
      });
      continue;
    }
    if (action === "snooze") {
      elements.push({
        type: "static_select",
        action_id: `${ACTION_PREFIX}snooze`,
        placeholder: plainText(t(lang, LABEL_KEY.snooze)),
        options: SNOOZE_OPTIONS.map((until) => ({
          text: plainText(t(lang, SNOOZE_LABEL_KEY[until])),
          value: until,
        })),
      });
      continue;
    }
    const style = STYLE[action];
    elements.push({
      type: "button",
      action_id: `${ACTION_PREFIX}${action}`,
      text: plainText(t(lang, LABEL_KEY[action])),
      value: notificationId,
      ...(style ? { style } : {}),
    });
  }

  if (elements.length > 0) {
    blocks.push({ type: "actions", block_id: inboxBlockId(notificationId), elements });
  }
  return blocks;
}
