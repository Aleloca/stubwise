/**
 * `callback_id` della view modale di interrogazione dei Docs: lo si ritrova
 * nell'evento `view_submission` per riconoscere il modal /docs e decidere il
 * comportamento (Task 4).
 */
export const DOCS_QUERY_CALLBACK_ID = "docs_query";

/**
 * `block_id`/`action_id` stabili dei campi del modal /docs: usati sia per
 * costruire la view sia per ripescare i valori da `view.state.values` al submit.
 * Stabili = non cambiano tra build e submit, altrimenti l'estrazione fallirebbe.
 */
export const DOCS_BLOCK_IDS = {
  project: "docs_project_block",
  question: "docs_question_block",
} as const;

export const DOCS_ACTION_IDS = {
  project: "docs_project_select",
  question: "docs_question_input",
} as const;

/** Limite di rendering di Slack per `initial_value` di un plain_text_input. */
const QUESTION_PREFILL_MAX = 150;

export interface BuildDocsQueryModalInput {
  /**
   * Testo digitato dopo `/docs` (campo `text` dello slash command), usato per
   * precompilare la domanda. Troncato a ~150 char (limite di rendering Slack).
   */
  prefillQuestion?: string;
  /**
   * Contesto serializzato (JSON) propagato fino al submit via `private_metadata`:
   * response_url, channel id e slack user id dello slash command. Indispensabile
   * per rispondere nel canale giusto e attribuire la domanda (Task 4).
   */
  privateMetadata: string;
}

/**
 * Costruisce la view Block Kit del modal di interrogazione dei Docs. Contiene:
 * - external_select PROGETTO (le option arrivano via block_suggestions, Task 3:
 *   qui NON si mettono option statiche; `min_query_length: 0` mostra subito i
 *   suggerimenti senza dover digitare);
 * - plain_text_input multiline DOMANDA (precompilabile dal testo dello slash
 *   command, troncato a 150 char per il limite di rendering Slack).
 *
 * `private_metadata` trasporta il contesto dello slash command fino al submit.
 */
export function buildDocsQueryModal(input: BuildDocsQueryModalInput): Record<string, unknown> {
  const { prefillQuestion, privateMetadata } = input;

  return {
    type: "modal",
    callback_id: DOCS_QUERY_CALLBACK_ID,
    title: { type: "plain_text", text: "Chiedi ai Docs" },
    submit: { type: "plain_text", text: "Chiedi" },
    close: { type: "plain_text", text: "Annulla" },
    private_metadata: privateMetadata,
    blocks: [
      {
        type: "input",
        block_id: DOCS_BLOCK_IDS.project,
        label: { type: "plain_text", text: "Progetto" },
        element: {
          type: "external_select",
          action_id: DOCS_ACTION_IDS.project,
          min_query_length: 0,
          placeholder: { type: "plain_text", text: "Cerca un progetto…" },
        },
      },
      {
        type: "input",
        block_id: DOCS_BLOCK_IDS.question,
        label: { type: "plain_text", text: "Domanda" },
        element: {
          type: "plain_text_input",
          action_id: DOCS_ACTION_IDS.question,
          multiline: true,
          ...(prefillQuestion
            ? { initial_value: prefillQuestion.slice(0, QUESTION_PREFILL_MAX) }
            : {}),
        },
      },
    ],
  };
}
