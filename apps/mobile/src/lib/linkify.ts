/**
 * Spezza un testo nei suoi pezzi, marcando quali sono collegamenti (App,
 * 13 set 2026). Funzione PURA: non apre niente, non conosce React Native —
 * decide solo dove stanno i link, e i suoi casi limite si verificano senza
 * montare nulla.
 *
 * ⚠️ **Questo non riapre la porta al markdown.** Il corpo di un'email resta
 * TESTO: un asterisco o un trattino scritti da un estraneo restano un
 * asterisco e un trattino (vedi il docblock di `MailDetailScreen`). Un URL
 * è un caso diverso e più ristretto — non è markup da interpretare, è una
 * stringa che è già un indirizzo, e nelle email di lavoro è spesso la cosa
 * per cui il messaggio è stato mandato.
 *
 * **Solo `http`/`https`.** Uno schema qualunque (`javascript:`, `file:`, uno
 * schema custom di un'altra app installata) non diventa mai un link: il
 * testo di un'email lo scrive chi vuole, compreso chi vuole male, e
 * `Linking.openURL` con uno schema arbitrario è una superficie che questa
 * funzione non offre. `www.` senza schema è ammesso perché è comunissimo, e
 * viene normalizzato a `https://`.
 */
import { isSafeWebUrl } from "@stubwise/shared";

export type TextSegment = { kind: "text"; text: string } | { kind: "link"; text: string; url: string };

/**
 * `https?://…` oppure `www.…`. La classe finale esclude la punteggiatura che
 * in italiano e in inglese chiude una frase: senza, «vai su
 * https://esempio.it/pagina.» si porterebbe dentro il punto finale e il link
 * aprirebbe un indirizzo che non esiste.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+/gi;

/** Le chiusure che vanno tolte dalla CODA di un URL, non dal mezzo. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "»", "…"]);

function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING.has(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const at = match.index;
    const visible = trimTrailing(raw);
    // Un match ridotto a nulla dalla potatura (`www.` seguito solo da
    // punteggiatura) non è un link: resta testo, e il ciclo non avanza il
    // cursore, così quel pezzo finisce nel testo che segue.
    if (visible.length === 0 || visible === "www.") continue;
    if (at > cursor) segments.push({ kind: "text", text: text.slice(cursor, at) });
    segments.push({
      kind: "link",
      text: visible,
      url: visible.toLowerCase().startsWith("www.") ? `https://${visible}` : visible,
    });
    cursor = at + visible.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/**
 * Un URL trovato dentro un testo è apribile?
 *
 * ⚠️ **La regola non vive più qui** (15 set 2026, fix di review): sta in
 * `isSafeWebUrl` (`@stubwise/shared`), insieme alla sua gemella
 * `isSafeJoinUrl`, che ammette in PIÙ `tel:` per i numeri di conferenza di
 * un appuntamento. Erano tre controlli identici-ma-non-uguali sparsi fra
 * app e web, ed è esattamente il modo in cui una regola di sicurezza
 * diverge — con la copia che diverge che è quella che lascia passare.
 *
 * Restano DUE regole, consapevolmente: qui il testo lo scrive chiunque e
 * `tel:` non deve diventare toccabile, là il numero è un campo strutturato
 * che Google dichiara come telefono. Il perché per esteso è nel docblock di
 * `safe-url.ts`.
 *
 * Il nome locale sopravvive perché dice cosa fa NEL CONTESTO di questo
 * modulo (un segmento di testo che diventa un link), e i suoi test restano
 * qui accanto a `linkify`.
 */
export const isOpenableUrl = isSafeWebUrl;
