/**
 * Apre una voce dei recenti della ricerca. Il web vecchio e la nuova app
 * scrivono le STESSE righe (`search_history`, unica per utente, tipo e
 * oggetto): una voce riaperta dalla nuova app ha la sua route, `#/p/…`, che
 * qui non è una route del web. Quella si apre nella nuova app (`/app/`), a
 * pagina intera; tutto il resto è una navigazione del web come prima
 * (revisione di feat/ritiro-buchi-minori, I1 b).
 */
export function openRecentRoute(
  route: string,
  navigate: (to: string) => void,
  assign: (url: string) => void = (url) => window.location.assign(url),
): void {
  if (route.startsWith("#/")) assign(`/app/${route}`);
  else navigate(route);
}
