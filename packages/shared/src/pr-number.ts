/**
 * Il numero di una PR dal suo URL. UNA sola regola per tutto il monorepo
 * (`parsePrNumberFromUrl` di @stubwise/git delega qui; `derivePrCycle` la
 * importa): due copie divergevano già — una riconosceva `/pulls/N`, l'altra no.
 *
 * È la stessa forma del backfill della migrazione 0081: GitHub `/pull/N`,
 * Bitbucket `/pull-requests/N` e in più `/pulls/N`. A differenza dell'SQL
 * della 0081 richiede il confine di parola dopo il numero (`/pull/42abc` →
 * null), come le copie JS di prima; gli URL salvati sono quelli html dei
 * provider, quindi nella pratica le due danno lo stesso risultato.
 *
 * `null` se il formato non è riconosciuto o il numero non è un intero sicuro —
 * MAI lancia e mai inventa un numero: chi la chiama legge URL salvati da run
 * precedenti e non deve rompersi su un formato imprevisto.
 */
export function prNumberFromUrl(url: string): number | null {
  const match = /\/pull(?:-requests|s)?\/(\d+)\b/.exec(url);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}
