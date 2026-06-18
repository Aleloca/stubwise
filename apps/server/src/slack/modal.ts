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
