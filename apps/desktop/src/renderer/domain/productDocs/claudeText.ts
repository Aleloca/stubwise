import type { ProductAnswerChoice, ProductQuestionReason, ProductSourceView } from "../../data/model";

// I testi di Claude sulla doc di prodotto che più superfici dicono uguali
// (11b, Task 10): la domanda per ragione (shape product-claude-questions.md
// §3.2), il nome di una risposta e la fonte come testo semplice. Si
// compongono in lettura, in en o it, dai valori stabili che il livello dati
// dà già visti da chi guarda (`forName` solo se chi guarda vede la persona,
// l'etichetta della fonte nella sua forma, R-G5): qui non si decide niente,
// si traduce. Il filo, la Home e la card li leggono da qui.

type T = (key: string, options?: Record<string, unknown>) => string;

export interface QuestionWords {
  reason: ProductQuestionReason;
  forName: string | null;
  taskCode: string | null;
  /**
   * La domanda ha una strada per «Open a request» (fix round 1, I4): senza,
   * la divergenza non la offre («…Should I update the page?»). Assente (una
   * riga nata prima) vale come sì, la frase dello shape.
   */
  canRequest?: boolean;
}

/**
 * La chiave della domanda e i suoi valori. Senza la persona (chi guarda non
 * la vede) o senza il codice della task, la frase che non nomina nessuno.
 * La divergenza ha il codice fra `<code>…</code>` (il filo lo rende con
 * `CodeLink`; il testo semplice toglie i segni).
 */
export function questionKey(q: QuestionWords): { key: string; params: Record<string, unknown> } {
  const base = `productDocs.question.reason.${q.reason}`;
  switch (q.reason) {
    case "contradicts_person":
    case "no_permission":
      return q.forName ? { key: base, params: { name: q.forName } } : { key: `${base}Someone`, params: {} };
    case "diverges": {
      const tail = q.canRequest === false ? "NoRequest" : "";
      return q.taskCode
        ? { key: `${base}${tail}`, params: { code: q.taskCode } }
        : { key: `productDocs.question.reason.divergesNoCode${tail}`, params: {} };
    }
    default:
      return { key: base, params: {} };
  }
}

/** La domanda come testo semplice (la card, il `title` della Home). */
export function questionSentence(t: T, q: QuestionWords): string {
  const { key, params } = questionKey(q);
  return t(key, params).replace(/<\/?code>/g, "");
}

/** Il nome di una risposta: «Update it», «Leave it as is», «Open a request». */
export function answerLabel(t: T, option: ProductAnswerChoice): string {
  return t(`productDocs.question.option.${option}`);
}

/**
 * Le forme visibili della fonte che non portano la data nell'etichetta: chi
 * le mostra la aggiunge dal dato (`SourceLine` e `sourceText`, una regola sola).
 */
export const DATED_SOURCE_LABELS: ReadonlySet<string> = new Set([
  "productDocs.source.email",
  "productDocs.source.meeting",
  "productDocs.source.decision",
]);

/**
 * La fonte come testo semplice, nella forma che il livello dati ha scelto
 * per chi guarda: l'etichetta, la data dove `SourceLine` la aggiunge, il
 * codice di una task o di un rilascio. Per una card, dove un link non può
 * stare (tutta la card è il bottone che apre).
 */
export function sourceText(t: T, source: ProductSourceView): string {
  const parts = [t(source.label.key, source.label.params ?? {})];
  if (source.at && DATED_SOURCE_LABELS.has(source.label.key)) parts.push(t("productDocs.mark.date", { date: Date.parse(source.at) }));
  if (source.code) parts.push(source.code);
  return parts.join(" · ");
}
