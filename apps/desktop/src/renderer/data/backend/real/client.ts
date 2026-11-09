import type { StubwiseClient } from "@stubwise/api-client";
import { emitSessionLost } from "../../sessionEvents";
import { createAppClient } from "./transport";

// Il client unico della build app e lo stato della sessione (integrazione
// area 2, fetta 1). Lo stato è solo ciò che serve a rispondere SUBITO (il
// cancello delle rotte legge `auth.readEntry` a ogni render): chi è dentro,
// e se si è a metà del secondo fattore. I dati veri li danno le query.

export interface SessionState {
  /** Chi è dentro (id dell'utente), o `null`. */
  personId: string | null;
  /** A metà del login: manca il secondo fattore. */
  partial: boolean;
}

export const session: SessionState = { personId: null, partial: false };


/**
 * Un 401 mentre si era dentro: la sessione è finita (scaduta, revocata, o il
 * token cancellato dal processo main). Si esce, e chi ascolta azzera la cache.
 * Fuori (il primo `/me`, un login sbagliato) un 401 è la risposta attesa.
 */
function unauthorized(): void {
  if (session.personId === null) return;
  session.personId = null;
  session.partial = false;
  emitSessionLost();
}

let client: StubwiseClient | null = null;

export function appClient(): StubwiseClient {
  client ??= createAppClient({ onUnauthorized: unauthorized });
  return client;
}

/** Solo per i test: un client finto (con `fetch` iniettato) e la sessione da capo. */
export function setAppClientForTests(next: StubwiseClient | null): void {
  client = next;
  session.personId = null;
  session.partial = false;
}

/** Solo per i test: come se il trasporto avesse visto un 401. */
export const notifyUnauthorizedForTests = unauthorized;
