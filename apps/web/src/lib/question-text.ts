import { stripMarkdown } from "@stubwise/shared";

/**
 * Il testo di una card `job.awaiting_input` spezzato attorno alla domanda.
 *
 * Il testo è un template localizzato («L'AI ha una domanda su {ref} —
 * {ticketTitle}: {question} {link}»): la domanda la scrive l'AGENTE e si
 * legge in markdown, il titolo del ticket lo scrive una PERSONA e resta
 * letterale, come una risposta in testo libero. Si cerca l'ULTIMA occorrenza
 * della domanda (viene dopo il titolo); se non c'è, `null`: il chiamante
 * mostra tutto come testo semplice, mai un markdown sul pezzo sbagliato.
 *
 * Gemello deliberato di `apps/mobile/src/lib/question-text.ts`.
 */
export interface QuestionTextParts {
  before: string;
  question: string;
  after: string;
}

export function splitQuestionText(
  text: string,
  question: string | undefined,
): QuestionTextParts | null {
  // Ai bordi la domanda può avere spazi o a-capo che il testo della notifica
  // non riporta: si cerca la parte che conta.
  const wanted = question?.trim() ?? "";
  if (wanted.length === 0) return null;
  const at = text.lastIndexOf(wanted);
  if (at < 0) return null;
  return { before: text.slice(0, at), question: wanted, after: text.slice(at + wanted.length) };
}

/**
 * Lo stesso testo come lo legge uno screen reader: la domanda senza i segni
 * del markdown, il resto (titolo compreso) com'è.
 */
export function questionTextLabel(text: string, question: string | undefined): string {
  const parts = splitQuestionText(text, question);
  if (parts === null) return text;
  return `${parts.before}${stripMarkdown(parts.question)}${parts.after}`;
}
