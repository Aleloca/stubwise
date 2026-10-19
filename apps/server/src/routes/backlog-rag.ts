/**
 * Prompt builder del backlog di discovery: dalla dismissione della chat della
 * voce (19 ott 2026) resta solo la chiamata one-shot "fondi documenti" di
 * `POST /api/backlog/:id/merge`, così la route ({@link ./backlog.ts}) resta
 * concentrata su trasporto/persistenza.
 */

/** Sottoinsieme dei campi della voce necessari a comporre il prompt. */
export interface BacklogItemContext {
  title: string;
  document: string;
}

/**
 * System prompt della chiamata one-shot di fusione ("Fondi con…").
 *
 * Integra il documento della voce ASSORBITA in quella di destinazione,
 * restituendo il documento fuso come MARKDOWN PURO (non JSON): la route lo salva
 * direttamente come nuovo documento del target.
 */
export function buildMergeDocumentPrompt(
  target: BacklogItemContext,
  absorbed: BacklogItemContext,
): string {
  return [
    "Sei un co-progettista di prodotto. Devi FONDERE due voci del backlog che descrivono la stessa idea (o idee molto vicine) in un unico documento di design.",
    "",
    "REGOLE:",
    "- Produci il documento della voce DI DESTINAZIONE, arricchito con ciò che la voce ASSORBITA aggiunge (requisiti, casi, vincoli, punti aperti).",
    "- Niente duplicati: unisci i punti equivalenti. Mantieni la struttura Markdown.",
    "- Restituisci SOLO il Markdown del documento fuso, senza commenti né testo attorno, senza racchiuderlo in un blocco di codice.",
    "",
    `--- VOCE DI DESTINAZIONE: "${target.title}" ---\n${target.document || "(vuoto)"}`,
    "",
    `--- VOCE ASSORBITA: "${absorbed.title}" ---\n${absorbed.document || "(vuoto)"}`,
  ].join("\n");
}
