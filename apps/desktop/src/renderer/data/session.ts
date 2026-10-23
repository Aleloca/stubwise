/**
 * Sessione finta del livello dati: chi sta guardando. È la «persona» del
 * server — ogni lettura dell'api filtra per lei — e la imposta solo
 * `ViewerProvider`, nello stesso render in cui cambia la persona «vedi come».
 */

export const DEFAULT_SESSION_PERSON_ID = "p-giulia";

let currentPersonId = DEFAULT_SESSION_PERSON_ID;

export function getSessionPersonId(): string {
  return currentPersonId;
}

export function setSessionPersonId(id: string): void {
  currentPersonId = id;
}

const beforeChange = new Set<() => void>();

/**
 * Lavoro della persona corrente da chiudere PRIMA che la sessione passi a
 * un'altra (es. una risposta in attesa dell'«Undo»): chi si registra parte
 * mentre la sessione è ancora la sua. Restituisce la cancellazione.
 */
export function onBeforePersonaChange(fn: () => void): () => void {
  beforeChange.add(fn);
  return () => beforeChange.delete(fn);
}

/** Da chiamare subito prima di cambiare persona (lo fa `ViewerProvider`). */
export function runBeforePersonaChange(): void {
  for (const fn of beforeChange) fn();
}
