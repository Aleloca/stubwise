// Area 11, F3: le regole della ricerca nelle pagine di prodotto, una per il
// server (che cerca) e il client. Dal prototipo (`domain/textSearch.ts`,
// `data/docs/reads.ts` `passageIn`, `data/productDocs/search.ts`).
import type { ProductBlock } from "../schemas/product-docs.js";
import { plainTextOf } from "./blocks.js";

/** Senza maiuscole né accenti: «caffe» trova «Caffè». */
export const foldSearchText = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Le parole della ricerca, piegate. */
export const productSearchWords = (q: string): string[] => foldSearchText(q).split(/\s+/).filter(Boolean);

/** Quanto è lungo, al più, il passaggio di un risultato. */
export const PRODUCT_PASSAGE_MAX = 160;

/**
 * La frase che ha corrisposto: la prima riga del testo semplice (`plainTextOf`:
 * mai segni né indirizzi) in cui compare una delle parole, tagliata intorno a
 * lei; senza corrispondenza nel testo (il codice, il titolo, o un risultato
 * per significato) l'estratto. Sempre UNA riga.
 */
export function productPassage(rawLines: readonly string[], words: readonly string[], fallback: string): string {
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const found = lines
    .map((line) => ({ line, at: Math.min(...words.map((w) => foldSearchText(line).indexOf(w)).filter((i) => i >= 0)) }))
    .find((l) => Number.isFinite(l.at));
  if (!found) return fallback.replace(/\s+/g, " ").trim().slice(0, PRODUCT_PASSAGE_MAX);
  const { line, at } = found;
  if (line.length <= PRODUCT_PASSAGE_MAX) return line;
  const start = Math.max(0, Math.min(at - 40, line.length - PRODUCT_PASSAGE_MAX));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + PRODUCT_PASSAGE_MAX).trim()}…`;
}

/**
 * Il testo cercabile di una pagina, già PIEGATO (`product_pages.search_text`):
 * il titolo e il testo semplice (`plainTextOf`: frasi, celle, didascalie, mai
 * un `href`). Lo piega TypeScript e non il database: `lower` e `translate`
 * dipendono dalla codifica del database, e una ricerca che trova «Caffè» in
 * produzione e non nei test (o viceversa) non si può provare.
 */
export function productSearchText(title: string, blocks: readonly ProductBlock[]): string {
  return foldSearchText(`${title}\n${plainTextOf(blocks)}`);
}
