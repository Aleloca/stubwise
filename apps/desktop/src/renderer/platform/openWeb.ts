/**
 * «Open in web» (integrazione area 2, fetta 1): una pagina del web vecchio
 * dell'istanza, per ciò che la nuova app non fa ancora (piani, domande di
 * Claude, proposte della posta…). Sul desktop la apre il processo main nel
 * browser di sistema (`open:web`, solo percorsi dell'istanza); nel browser il
 * web vecchio sta sulla stessa origine, e ci si va.
 */
export function openInWeb(path: string): void {
  if (window.stubwise?.openWeb) {
    void window.stubwise.openWeb(path);
    return;
  }
  window.location.assign(path);
}
