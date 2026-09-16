/**
 * Lo snippet di un risultato di ricerca, reso leggibile (16 set 2026).
 *
 * Il server costruisce gli snippet con `ts_headline` di Postgres
 * (`apps/server/src/routes/search.ts`), che avvolge in **`<b>…</b>`** il pezzo
 * che ha combaciato con la query. Quel testo arriva quindi al client con due
 * cose che non vanno mostrate così come sono:
 *
 *  1. i marcatori `<b>` di `ts_headline`;
 *  2. la sintassi **markdown** del corpo da cui lo snippet è ritagliato — un
 *     ticket o una pagina Docs contengono backtick, heading, link, elenchi.
 *
 * Fino a oggi questa pulizia esisteva SOLO nella palette del web
 * (`plainTextPreview` in `global-search-palette.tsx`), e l'app mostrava il
 * testo grezzo: il maintainer ha visto `<b>` scritto in chiaro nelle righe.
 * Vive qui perché la usano due superfici, ed è lo stesso ragionamento di
 * `calendar-grid.ts` e `safe-url.ts`: una regola di lettura scritta in due
 * posti è una regola che diverge.
 *
 * ⚠️ **Non è un parser**, né deve diventarlo: taglia la sintassi che
 * renderizzata grezza confonde, e tanto basta a un'anteprima di due righe.
 * Un limite noto e accettato (ereditato dal web): un marcatore che cade DENTRO
 * una coppia markdown — `**gras<b>setto</b>**` — non viene ricomposto.
 *
 * ⚠️ **Il testo è NON FIDATO.** Un `<b>` scritto a mano da chi manda un'email
 * finisce evidenziato come se l'avesse marcato Postgres. È grassetto finto in
 * un'anteprima, non un rischio: i segmenti si rendono in `<Text>` (app) o come
 * testo (web), mai come HTML, quindi non esiste una strada per cui questo
 * diventi markup eseguito. Il web si comportava già così, buttandoli via.
 */

/** Un pezzo di snippet: `highlighted` quando `ts_headline` l'ha marcato. */
export interface SearchSnippetSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Toglie la sintassi markdown, **lasciando in piedi i marcatori `<b>`**.
 *
 * L'ordine conta: la pulizia gira sull'INTERA stringa, marcatori compresi, e
 * la separazione viene dopo. Ripulire segmento per segmento romperebbe il
 * collasso degli spazi ai bordi — `"durante l'" + "export" + " del CSV"`
 * perderebbe lo spazio prima di «del», perché ogni pezzo verrebbe rifilato per
 * conto suo. Nessuna di queste regex produce o consuma `<b>`, quindi i
 * marcatori attraversano la pulizia intatti.
 */
function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ") // blocchi di codice
    .replace(/`([^`]+)`/g, "$1") // codice inline
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // immagini
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → testo
    .replace(/^#{1,6}\s+/gm, "") // heading
    .replace(/^\s{0,3}>\s?/gm, "") // citazioni
    .replace(/^\s*[-*+]\s+/gm, "") // elenchi puntati
    .replace(/^\s*\d+\.\s+/gm, "") // elenchi numerati
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // grassetto
    .replace(/(\*|_)(.*?)\1/g, "$2") // corsivo
    .replace(/~~(.*?)~~/g, "$2") // barrato
    .replace(/\s+/g, " ") // collassa spazi/newline
    .trim();
}

/** Separa i pezzi marcati da `ts_headline`, già ripuliti dal markdown. */
const HIGHLIGHT_RE = /<b>([\s\S]*?)<\/b>/g;

/**
 * Lo snippet spezzato in segmenti, per renderlo con la parte trovata in
 * evidenza. I segmenti vuoti sono scartati: concatenandoli si riottiene
 * esattamente {@link plainSearchSnippet}.
 */
export function searchSnippetSegments(raw: string): SearchSnippetSegment[] {
  const cleaned = stripMarkdown(raw);
  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;

  HIGHLIGHT_RE.lastIndex = 0;
  let match = HIGHLIGHT_RE.exec(cleaned);
  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ text: cleaned.slice(cursor, match.index), highlighted: false });
    }
    const inner = match[1] ?? "";
    if (inner !== "") segments.push({ text: inner, highlighted: true });
    cursor = match.index + match[0].length;
    match = HIGHLIGHT_RE.exec(cleaned);
  }
  if (cursor < cleaned.length) {
    segments.push({ text: cleaned.slice(cursor), highlighted: false });
  }

  // Un marcatore spaiato (`<b>` senza chiusura) non viene catturato dalla
  // regex e resterebbe visibile: è il difetto che questo modulo esiste per
  // togliere, quindi si ripulisce comunque.
  return segments
    .map((segment) => ({ ...segment, text: segment.text.replace(/<\/?b>/g, "") }))
    .filter((segment) => segment.text !== "");
}

/**
 * Lo stesso snippet come testo semplice, senza evidenziazione: è ciò che usa
 * la palette del web, dove le righe sono di UNA riga sola e il grassetto
 * costerebbe più di quanto renda.
 */
export function plainSearchSnippet(raw: string): string {
  return searchSnippetSegments(raw)
    .map((segment) => segment.text)
    .join("");
}
