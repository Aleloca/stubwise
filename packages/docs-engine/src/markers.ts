/**
 * Primitive CONDIVISE del contratto a marcatori, estratte da `generate.ts` e riusate dal
 * motore ricorsivo (`recursive/*`): parser di body delimitato per-riga, euristica
 * anti-meta-summary ancorata all'apertura, e helper di slug stabili/univoci. Logica pura,
 * deterministica, senza side-effect. Sono i primitivi PROVATI del vecchio motore: NON si
 * duplicano altrove, si importano da qui.
 */

/**
 * Euristica anti-META-SUMMARY. In produzione molte pagine tornavano come la meta-summary
 * dell'agent ("The documentation page is saved to the plan file…", "I now have a thorough
 * understanding… here is the complete markdown body.") invece del contenuto. Il contratto a
 * marcatori riduce molto il problema (estraendo SOLO tra i marker), ma se l'agent mette la
 * meta-summary DENTRO i marker va comunque scartata. Le frasi qui sono segnali SPECIFICI di
 * meta (NON il generico connettore inglese), affidabili sull'APERTURA del corpo.
 */
export const META_SUMMARY_RE =
  /saved to the plan file|in the plan file|the documentation page (is|for)|let me know if|here is the (complete )?markdown|I now have a thorough/i;

/**
 * Numero di caratteri iniziali del corpo su cui valutare l'euristica anti-meta-summary.
 * Si guarda solo l'APERTURA: una meta-summary genuina sostituisce l'intera pagina e
 * inizia con frasi-meta, mentre una pagina vera inizia con un heading.
 */
const META_SUMMARY_HEAD_CHARS = 200;

/**
 * true se l'APERTURA del corpo (i primi ~`META_SUMMARY_HEAD_CHARS` caratteri, non tutto il
 * corpo) sembra una meta-summary dell'agent invece del contenuto. Ancorare l'euristica
 * all'apertura evita i falsi positivi: una pagina legittima che cita "let me know if" a
 * metà testo NON viene scartata; solo una pagina che SI APRE con frasi-meta lo è.
 */
export function isMetaSummary(body: string): boolean {
  return META_SUMMARY_RE.test(body.slice(0, META_SUMMARY_HEAD_CHARS));
}

/**
 * Estrae il testo racchiuso tra una coppia di marker start/end, riconosciuti SOLO come
 * RIGA INTERA (la riga, trimmata, è ESATTAMENTE il marker), MAI substring/indexOf — così un
 * marker a metà riga o dentro un fenced code block non è un delimitatore. Usa la PRIMA
 * riga-`start`, poi la PRIMA riga-`end` successiva. Estrarre tra i marker scarta
 * naturalmente preamboli prima dello start e chiusure dopo l'end. Ritorna `null` (corpo non
 * estraibile) se un marker manca, sono fuori ordine, o il testo tra i due è vuoto trimmato.
 */
export function parseDelimitedBody(
  output: string,
  start: string,
  end: string,
): string | null {
  const lines = output.split("\n");
  const startLine = lines.findIndex((l) => l.trim() === start);
  if (startLine === -1) return null;
  const endLine = lines.findIndex((l, i) => i > startLine && l.trim() === end);
  if (endLine === -1) return null;
  const body = lines
    .slice(startLine + 1, endLine)
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

/** Trasforma un testo (path o titolo) in uno slug base (kebab, ascii-safe). */
export function baseSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "module";
}

/**
 * Genera slug stabili e univoci. Lo slug base deriva deterministicamente dall'input; in
 * caso di collisione si appende un suffisso numerico crescente (`-2`, `-3`, …), sempre
 * deterministico a parità di ordine d'ingresso. Muta `used` aggiungendo lo slug emesso.
 */
export function makeUniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}
