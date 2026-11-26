// Area 11, F2: la frase citata di un commento della doc di prodotto, una regola
// per il server (che la salva) e il client (che la mostra prima di mandarla).
// Dal prototipo (`data/productDocs/comments.ts`, `cleanQuote`), con una riga
// in più del piano F2: la frase è UNA riga (gli a capo e gli spazi ripetuti
// diventano uno spazio), così la citazione sopra un filo non si spezza.

/** La frase citata: al più 200 caratteri. */
export const PRODUCT_QUOTE_MAX = 200;

/** Una riga, senza spazi ai lati, tagliata a `PRODUCT_QUOTE_MAX` con «…». */
export function cleanQuote(quote: string): string {
  const q = quote.replace(/\s+/g, " ").trim();
  return q.length > PRODUCT_QUOTE_MAX ? `${q.slice(0, PRODUCT_QUOTE_MAX - 1)}…` : q;
}
