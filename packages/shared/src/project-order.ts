/**
 * L'ORDINE DEI PROGETTI, in un posto solo (28 set 2026, «i progetti in ordine
 * alfabetico, ovunque»). Lo usano il server — `GET /api/projects` e il polso —
 * e i client, che non devono avere una seconda regola che poi diverge.
 *
 * ⚠️ Si ordina in TypeScript e non con un `ORDER BY name`: il Postgres del
 * compose è inizializzato con `--locale=C`, dove l'ordine è quello dei byte
 * ASCII — «Zeta» prima di «alfa», e «Èlite» dopo tutto.
 */

/**
 * Italiano, maiuscole e accenti ignorati (`sensitivity: "base"`), numeri letti
 * come numeri (`numeric`): «progetto 2» prima di «progetto 10». Creato una
 * volta: un `Collator` costa, un `localeCompare` con opzioni ne crea uno a
 * ogni confronto.
 */
const collator = new Intl.Collator("it", { sensitivity: "base", numeric: true });

/**
 * Confronto per `Array.sort`: il nome, poi l'id a parità di nome — due
 * progetti «Portale» e «portale» per il collator sono uguali, e senza lo
 * spareggio il loro ordine dipenderebbe da come arrivano.
 */
export function compareProjectNames(a: { id: string; name: string }, b: { id: string; name: string }): number {
  const byName = collator.compare(a.name, b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Qualcosa in questo progetto aspetta CHI GUARDA: una decisione
 * (`waitingForYou`) o una PR che può mergiare lui (`canMerge`, calcolato dal
 * SERVER col ruolo — qui si legge, mai si deduce). È il confine fra «Needs
 * you» e «All projects» nella lista principale, e lo stesso conteggio del
 * badge «Tocca a te» del dettaglio.
 *
 * Tipizzato sulla sola forma che legge, così va bene sia al riepilogo del
 * server sia a quello letto dai client. `waitingForMerge` è opzionale apposta:
 * il web non parsa le risposte, e un server più vecchio non lo manda.
 */
export function needsViewer(summary: {
  waitingForYou: readonly unknown[];
  waitingForMerge?: readonly { canMerge: boolean }[];
}): boolean {
  return summary.waitingForYou.length > 0 || (summary.waitingForMerge ?? []).some((item) => item.canMerge);
}
