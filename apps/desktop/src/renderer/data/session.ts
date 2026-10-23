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
