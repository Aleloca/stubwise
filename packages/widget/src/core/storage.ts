/**
 * Persistenza dell'id di conversazione del widget su localStorage, per slug.
 * Il client riaggancia lo storico al reload passando questo id.
 *
 * localStorage può LANCIARE (Safari private mode, cookie di terze parti bloccati,
 * quota): il widget è embeddato nei siti dei clienti e non deve mai romperli, quindi
 * ogni accesso è protetto — il getter degrada a `null`, setter e clear a no-op.
 */

/** Chiave localStorage dedicata allo slug. */
function storageKey(slug: string): string {
  return `stubwise-widget:${slug}:conversation`;
}

/** Id di conversazione salvato per lo slug, o null (assente o storage non accessibile). */
export function getConversationId(slug: string): string | null {
  try {
    return localStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}

/** Salva l'id di conversazione per lo slug. No-op se lo storage non è accessibile. */
export function setConversationId(slug: string, id: string): void {
  try {
    localStorage.setItem(storageKey(slug), id);
  } catch {
    // storage non disponibile: si perde la persistenza, non si rompe il widget
  }
}

/** Rimuove l'id salvato per lo slug. No-op se lo storage non è accessibile. */
export function clearConversationId(slug: string): void {
  try {
    localStorage.removeItem(storageKey(slug));
  } catch {
    // storage non disponibile: no-op
  }
}
