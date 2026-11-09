// Un elenco di nomi in una frase (area 10b, Task 7; minore T5 e M6 del 10a):
// la frase sopra una scheda («I'm asking first: it notifies …») e la riga
// «Notifies» della scheda dicono le stesse persone allo stesso modo. Una
// funzione sola, pura: i nomi li sceglie il chiamante (solo quelli che chi
// legge vede, R-G5).

/** La `t` della lingua di chi legge. */
type T = (key: string, options?: Record<string, unknown>) => string;

/** Quanti nomi prima di «and N more» [CA 4]. */
const NAMED = 3;

/** «Marco Bellini», «Marco Bellini and Laura Costa», «A, B, C and 2 more»: una funzione sola per scheda e motivi. */
export function nameList(t: T, names: string[], max = NAMED): string {
  if (names.length > max) {
    return t("claude.conversation.proposal.reasons.andMore", {
      names: names.slice(0, max).join(", "),
      count: names.length - max,
    });
  }
  if (names.length < 2) return names[0] ?? "";
  const and = t("claude.conversation.proposal.reasons.and");
  return `${names.slice(0, -1).join(", ")}${and}${names.at(-1)}`;
}
