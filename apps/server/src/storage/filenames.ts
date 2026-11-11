/**
 * Il nome MOSTRATO di un file caricato (Drive e Chat; review della fetta 2):
 * l'ultimo segmento, senza i caratteri di controllo (NUL compreso, che
 * Postgres rifiuta in un `text`) e senza i caratteri di direzione del testo
 * (bidi: U+200E/F, U+061C, U+202A–202E, U+2066–2069), con cui «fattura‮fdp.exe»
 * si legge «fatturaexe.pdf». Vuoto diventa «file».
 */
const UNSAFE = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

export function displayFileName(filename: string): string {
  return (filename.replace(UNSAFE, "").split(/[/\\]/).pop() ?? "").trim() || "file";
}

/** I primi `max` caratteri (unità UTF-16) senza spezzare una coppia surrogata. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
