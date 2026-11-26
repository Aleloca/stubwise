/**
 * «Open in web» (integrazione area 2, fetta 1): una pagina del web vecchio
 * dell'istanza, per ciò che la nuova app non fa ancora (piani, domande di
 * Claude, proposte della posta…), o una pagina fuori dall'istanza che una
 * card nomina (la PR su GitHub, la conversazione in Gmail).
 *
 * - Un URL http(s) assoluto si apre nel browser: sul web in una scheda nuova,
 *   sul desktop dal gestore delle finestre del main, che manda gli http(s)
 *   al browser di sistema (`setWindowOpenHandler`).
 * - Un percorso dell'istanza (`/tickets/…`): sul desktop lo apre il main
 *   (`open:web`, solo percorsi dell'istanza); sul web il web vecchio sta
 *   sulla stessa origine, e ci si va.
 * - Ogni altro schema non si apre.
 */
export function openInWeb(href: string): void {
  if (/^https?:\/\//i.test(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  if (!href.startsWith("/") || href.startsWith("//")) return;
  if (window.stubwise?.openWeb) {
    void window.stubwise.openWeb(href);
    return;
  }
  window.location.assign(href);
}
