/**
 * Sessione finta del livello dati: chi sta guardando. È la «persona» del
 * server — ogni lettura dell'api filtra per lei — e la imposta solo
 * `ViewerProvider`, nello stesso render in cui cambia la persona «vedi come».
 */

export const DEFAULT_SESSION_PERSON_ID = "p-giulia";

/**
 * «Nessuno» (area 9a): la sessione dopo «Reset to empty instance», quando la
 * persona di prima non esiste più. Non è una persona: ogni lettura risponde
 * come per chi non vede niente, e la UI dell'ingresso (Task 6) manda al
 * primo avvio. Il prossimo `setPersona` la sostituisce.
 */
export const NO_SESSION_PERSON_ID = "p-nobody";

let currentPersonId = DEFAULT_SESSION_PERSON_ID;

export function getSessionPersonId(): string {
  return currentPersonId;
}

export function setSessionPersonId(id: string): void {
  currentPersonId = id;
}

/**
 * Con che cosa arriva la chiamata in corso (area 9a): la sessione dell'app
 * oppure un token personale (PAT). Nel prototipo nessuna pagina chiama via
 * PAT: lo fa solo `callWithToken` di `data/me/tokens.ts`, che simula un tool
 * (Claude Code col plugin) per la durata di una chiamata. Serve a
 * `requireReauth`: un PAT non soddisfa MAI la riconferma
 * (`second-factor.md`), nemmeno dentro la finestra di grazia della persona.
 */
export type SessionCredential = "session" | "pat";

let credential: SessionCredential = "session";

export function getSessionCredential(): SessionCredential {
  return credential;
}

export function setSessionCredential(next: SessionCredential): void {
  credential = next;
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
