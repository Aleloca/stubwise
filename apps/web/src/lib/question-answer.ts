import type { AgentQuestionAnswer } from "@stubwise/shared";

/**
 * La risposta da mostrare per una domanda già chiusa, e se è l'ETICHETTA di
 * un'opzione (scritta dall'agente: markdown inline, come nel pannello) o il
 * testo libero di chi ha risposto (una persona: si mostra com'è stato scritto).
 *
 * `null` quando non è (più) leggibile — nessuna risposta, una risposta di una
 * versione precedente, o un indice che non cade più nelle opzioni salvate. Non
 * si mostra mai l'indice nudo: un "2" non dice niente a chi legge.
 *
 * Una sola regola per la pagina ticket (storico delle Q&A) e per la sessione
 * dell'agente. `answer` può essere `undefined`: il web fa un cast, non un parse
 * (`lib/api.ts`), e un server più vecchio non manda il campo.
 */
export function answerLabel(question: {
  answer?: AgentQuestionAnswer | null;
  options?: ReadonlyArray<{ label: string }>;
}): { text: string; option: boolean } | null {
  const answer = question.answer ?? null;
  if (answer === null) return null;
  if ("text" in answer) return { text: answer.text, option: false };
  const label = (question.options ?? [])[answer.optionIndex]?.label;
  return label === undefined ? null : { text: label, option: true };
}
