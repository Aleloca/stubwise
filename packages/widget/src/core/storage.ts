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

/**
 * Posizione della bolla scelta dall'utente trascinandola: il lato a cui è
 * agganciata e il CENTRO verticale come frazione (0–1) dell'altezza del
 * viewport — una frazione e non i pixel, così sopravvive al resize e al cambio
 * di schermo.
 */
export interface BubblePosition {
  side: "left" | "right";
  y: number;
}

/** Chiave localStorage della posizione della bolla per lo slug. */
function positionKey(slug: string): string {
  return `stubwise-widget:${slug}:position`;
}

/**
 * Posizione salvata per lo slug, o null (assente, storage non accessibile, o
 * valore che non ha la forma attesa: un valore corrotto non deve portare la
 * bolla fuori schermo, quindi si torna al default).
 */
export function getPosition(slug: string): BubblePosition | null {
  try {
    const raw = localStorage.getItem(positionKey(slug));
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { side, y } = v as Record<string, unknown>;
    if (side !== "left" && side !== "right") return null;
    if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1) return null;
    return { side, y };
  } catch {
    return null;
  }
}

/** Salva la posizione per lo slug. No-op se lo storage non è accessibile. */
export function setPosition(slug: string, position: BubblePosition): void {
  try {
    localStorage.setItem(positionKey(slug), JSON.stringify(position));
  } catch {
    // storage non disponibile: la posizione vale fino al reload
  }
}
