import { t, type Language } from "@stubwise/i18n";
import { ticketTypeSchema } from "@stubwise/shared";

/**
 * `callback_id` della view modale di creazione ticket: lo si ritrova
 * nell'evento `view_submission` per riconoscere il modal e decidere il
 * comportamento.
 */
export const CREATE_TICKET_CALLBACK_ID = "create_ticket";

/**
 * `block_id`/`action_id` stabili dei campi del modal: usati sia per costruire
 * la view sia per ripescare i valori da `view.state.values` al submit. Stabili
 * = non cambiano tra build e submit, altrimenti l'estrazione fallirebbe.
 */
export const BLOCK_IDS = {
  project: "project_block",
  title: "title_block",
  description: "description_block",
  type: "type_block",
} as const;

export const ACTION_IDS = {
  project: "project_select",
  title: "title_input",
  description: "description_input",
  type: "type_select",
} as const;

/** Etichetta leggibile per ciascun tipo di ticket nel select del modal. */
const TYPE_LABELS: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  feedback: "Feedback",
};

export interface ModalProject {
  id: string;
  name: string;
}

export interface BuildTicketModalInput {
  /** Progetti selezionabili: popolano le option dello static_select progetto. */
  projects: ModalProject[];
  /** Precompilazione opzionale (message action): titolo e descrizione. */
  prefill?: { title?: string; description?: string };
}

/**
 * Costruisce la view Block Kit del modal di creazione ticket. Contiene:
 * - static_select PROGETTO (option = progetti passati);
 * - plain_text_input TITOLO (precompilabile);
 * - plain_text_input multiline DESCRIZIONE (opzionale, precompilabile);
 * - static_select TIPO (option dai valori di ticketTypeSchema, default "bug").
 *
 * Slack limita `initial_value` del titolo a 150 char nel rendering del modal;
 * il titolo verrà comunque troncato a 300 lato creazione ticket. Qui si
 * antepone un valore iniziale solo se fornito (message action).
 */
export function buildTicketModal(input: BuildTicketModalInput): Record<string, unknown> {
  const { projects, prefill } = input;

  const typeOptions = ticketTypeSchema.options.map((type) => ({
    text: { type: "plain_text", text: TYPE_LABELS[type] ?? type },
    value: type,
  }));

  return {
    type: "modal",
    callback_id: CREATE_TICKET_CALLBACK_ID,
    title: { type: "plain_text", text: "Nuovo ticket" },
    submit: { type: "plain_text", text: "Crea" },
    close: { type: "plain_text", text: "Annulla" },
    blocks: [
      {
        type: "input",
        block_id: BLOCK_IDS.project,
        label: { type: "plain_text", text: "Progetto" },
        element: {
          type: "static_select",
          action_id: ACTION_IDS.project,
          placeholder: { type: "plain_text", text: "Seleziona un progetto" },
          options: projects.map((p) => ({
            text: { type: "plain_text", text: p.name },
            value: p.id,
          })),
        },
      },
      {
        type: "input",
        block_id: BLOCK_IDS.title,
        label: { type: "plain_text", text: "Titolo" },
        element: {
          type: "plain_text_input",
          action_id: ACTION_IDS.title,
          ...(prefill?.title ? { initial_value: prefill.title.slice(0, 150) } : {}),
        },
      },
      {
        type: "input",
        block_id: BLOCK_IDS.description,
        optional: true,
        label: { type: "plain_text", text: "Descrizione" },
        element: {
          type: "plain_text_input",
          action_id: ACTION_IDS.description,
          multiline: true,
          ...(prefill?.description ? { initial_value: prefill.description } : {}),
        },
      },
      {
        type: "input",
        block_id: BLOCK_IDS.type,
        label: { type: "plain_text", text: "Tipo" },
        element: {
          type: "static_select",
          action_id: ACTION_IDS.type,
          initial_option: typeOptions[0],
          options: typeOptions,
        },
      },
    ],
  };
}

// --- Modal di RIFIUTO del piano (bottone "Rifiuta" del DM d'inbox) ---------

/**
 * `callback_id` del modal di rifiuto del piano: lo si ritrova nel
 * `view_submission` per riconoscere questa view (e non il modal ticket).
 */
export const INBOX_REJECT_PLAN_CALLBACK_ID = "inbox_reject_plan";

/** `block_id`/`action_id` del campo istruzioni del modal di rifiuto. */
export const INBOX_REJECT_BLOCK_ID = "reject_instructions_block";
export const INBOX_REJECT_ACTION_ID = "reject_instructions_input";

/**
 * Tetto alle istruzioni, allineato al `max(4000)` della rotta HTTP
 * `/api/inbox/:id/actions/reject_plan`: le due superfici accettano lo stesso
 * testo. Slack lo fa rispettare lato client, prima del submit.
 */
const INSTRUCTIONS_MAX = 4000;

/**
 * Modal di rifiuto del piano, aperto dal bottone "Rifiuta" del DM d'inbox.
 *
 * Un solo campo, OPZIONALE: le indicazioni con cui ripianificare (diventano un
 * commento sul ticket, come da `/api/inbox/:id/actions/reject_plan`). Rifiutare
 * senza dire nulla resta legittimo.
 *
 * `private_metadata` porta il SOLO `notificationId`: è ciò che serve al
 * `view_submission` per ritrovare la riga d'inbox. L'identità di chi rifiuta
 * NON viaggia qui — la si ri-risolve dallo Slack user id del submit, perché il
 * payload di Slack non è una fonte di autorizzazione.
 *
 * LINGUA: quella del DESTINATARIO (`users.language`), come le etichette dei
 * bottoni del DM: il modal è la prosecuzione del suo messaggio personale.
 */
export function buildRejectPlanModal(
  notificationId: string,
  lang: Language,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: INBOX_REJECT_PLAN_CALLBACK_ID,
    private_metadata: notificationId,
    title: { type: "plain_text", text: t(lang, "notify.inbox.rejectTitle") },
    submit: { type: "plain_text", text: t(lang, "notify.inbox.rejectSubmit") },
    close: { type: "plain_text", text: t(lang, "notify.inbox.rejectClose") },
    blocks: [
      {
        type: "input",
        block_id: INBOX_REJECT_BLOCK_ID,
        optional: true,
        label: { type: "plain_text", text: t(lang, "notify.inbox.rejectLabel") },
        element: {
          type: "plain_text_input",
          action_id: INBOX_REJECT_ACTION_ID,
          multiline: true,
          max_length: INSTRUCTIONS_MAX,
          placeholder: { type: "plain_text", text: t(lang, "notify.inbox.rejectPlaceholder") },
        },
      },
    ],
  };
}
