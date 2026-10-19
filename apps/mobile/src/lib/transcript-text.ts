import type { TranscriptItem } from "@stubwise/shared";

/**
 * Il testo dell'agente nella trascrizione di una sessione, misurato per un
 * telefono (10 ott 2026). Un agente Docs scrive interi documenti come testo:
 * in produzione una sessione ne aveva 627 KB, con un messaggio da 177 KB, e il
 * testo dal vivo arriva a pezzi ogni ~200 ms. Rendere tutto col markdown a
 * ogni pezzo faceva andare la schermata a scatti.
 *
 * Fino al 19 ott 2026 la difesa era drastica: dal vivo testo semplice e solo
 * gli ultimi 2000 caratteri. Il prezzo lo pagava chi leggeva un turno normale
 * di una sessione di refinement: il markdown arrivava solo a fine turno, e
 * l'inizio della risposta SPARIVA dallo schermo mentre lo si stava leggendo.
 * Ora (`LiveText`) il testo dal vivo è markdown come quello completo, ma si
 * ridisegna al più ogni {@link LIVE_THROTTLE_MS}; diventa testo semplice
 * (intero) solo oltre {@link LONG_TEXT_CHARS}, e solo oltre
 * {@link LIVE_TAIL_CHARS} — un documento Docs, non una risposta — se ne
 * mostra la coda.
 */

/** Il testo dal vivo si ridisegna al più ogni tanti millisecondi. */
export const LIVE_THROTTLE_MS = 500;

/** Del testo DAL VIVO oltre questa lunghezza si mostra la coda: è un documento, il testo intero arriva col messaggio completo. */
export const LIVE_TAIL_CHARS = 20_000;

/**
 * Oltre questa lunghezza un messaggio completo si apre chiuso, con «Mostra
 * tutto», e il testo dal vivo smette di essere markdown (resta intero).
 */
export const LONG_TEXT_CHARS = 6000;

/** Non spezza una coppia surrogata (un'emoji) al taglio. */
function safeCut(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/** La coda del testo dal vivo, e se è stata tagliata. */
export function liveTail(text: string, max = LIVE_TAIL_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: text.slice(safeCut(text, text.length - max)), cut: true };
}

/**
 * L'inizio di un messaggio lungo: tagliato all'ultimo a capo prima del
 * limite, se ce n'è uno nella seconda metà (così un blocco di codice o un
 * elenco non si spezza a metà riga), altrimenti al limite.
 */
export function collapsedHead(text: string, max = LONG_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const newline = text.lastIndexOf("\n", max);
  const end = newline >= max / 2 ? newline : safeCut(text, max);
  return text.slice(0, end);
}

/**
 * Due elementi della trascrizione disegnano la stessa cosa? `buildTranscript`
 * rifà gli oggetti a ogni pezzo di testo dal vivo, ma i campi (le stringhe
 * dei testi, l'input di un tool) restano gli stessi riferimenti: un confronto
 * di superficie basta, e il risultato di un tool si confronta campo per campo.
 */
export function sameTranscriptItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (key === "result" && x !== null && y !== null && typeof x === "object" && typeof y === "object") {
      const rx = x as Record<string, unknown>;
      const ry = y as Record<string, unknown>;
      if (rx["isError"] === ry["isError"] && rx["content"] === ry["content"] && rx["truncated"] === ry["truncated"]) {
        continue;
      }
    }
    return false;
  }
  return true;
}
