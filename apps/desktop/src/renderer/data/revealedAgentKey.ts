import { onBeforePersonaChange } from "./session";

// La chiave dell'agente appena creata o rigenerata (area 8, F4a, regola I2):
// si vede UNA volta, nel pannello che si apre, e poi non più. Non sta nel
// risultato della scrittura, che la cache delle mutazioni terrebbe: la si
// mette qui e il pannello la PRENDE (letta e tolta). Al cambio di persona e
// all'uscita nessuna chiave resta.

export interface RevealedAgentKey {
  key: string;
  /** L'indirizzo dell'istanza per il comando d'installazione; assente: il segnaposto del prototipo. */
  instanceUrl?: string;
}

const revealed = new Map<string, RevealedAgentKey>();

/**
 * Quanto la chiave aspetta il pannello che la prende (review F4a, M3): il
 * pannello la prende subito dopo la scrittura; se non succede (il dialogo è
 * stato chiuso), non resta in memoria.
 */
export const AGENT_KEY_KEPT_MS = 60_000;

export function revealAgentKey(serverCode: string, value: RevealedAgentKey): void {
  revealed.set(serverCode, value);
  setTimeout(() => {
    if (revealed.get(serverCode) === value) revealed.delete(serverCode);
  }, AGENT_KEY_KEPT_MS);
}

/** La chiave di `serverCode`, una volta sola: dopo non c'è più. */
export function takeAgentKey(serverCode: string): RevealedAgentKey | undefined {
  const value = revealed.get(serverCode);
  revealed.delete(serverCode);
  return value;
}

export function forgetRevealedAgentKeys(): void {
  revealed.clear();
}

onBeforePersonaChange(forgetRevealedAgentKeys);
