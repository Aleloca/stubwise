import { stripMarkdown } from "./search-snippet.js";

/**
 * Un estratto di una riga di un testo markdown: la sintassi tolta (la stessa
 * pulizia degli snippet di ricerca, `stripMarkdown`), le righe collassate, e
 * il taglio a `maxChars` su un confine di parola con «…».
 *
 * Lo usa il server per la riga «in risposta a» di un commento
 * (`commentReplyToSchema.excerpt`): un'anteprima, non il corpo — chi vuole il
 * resto tocca la riga e va all'originale.
 *
 * Una parola sola più lunga del limite si taglia comunque a metà: meglio un
 * pezzo di URL che un estratto vuoto.
 */
export function plainExcerpt(raw: string, maxChars: number): string {
  const clean = stripMarkdown(raw);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}
