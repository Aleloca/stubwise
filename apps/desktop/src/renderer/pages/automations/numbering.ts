import { visitSteps } from "../../domain/automations/fields";
import type { Step } from "../../data/types";

// R-J17: i passi si numerano 1…N nell'ordine di lettura su tutto l'albero
// (shape builder [A 6]), mai «3.2.1». Gli stessi numeri nel costruttore,
// nella prova, nel registro, in «How it works», nei problemi e nei dialoghi:
// si leggono ad alta voce («il passo 12»). Una versione ha i suoi numeri.

/** Percorso (giri al giro 0) → numero 1…N. */
export function stepNumbers(steps: Step[]): Map<string, number> {
  const out = new Map<string, number>();
  visitSteps(steps, (_, path) => out.set(path, out.size + 1));
  return out;
}

/** Id del passo → numero 1…N. */
export function numbersById(steps: Step[]): Map<string, number> {
  const out = new Map<string, number>();
  visitSteps(steps, (s) => out.set(s.id, out.size + 1));
  return out;
}

/**
 * Il numero del passo a un percorso di un'esecuzione o di un problema
 * (R-J5: `forEach[3]` e `repeat[1]` valgono come il giro 0). `null` se il
 * percorso non porta a un passo del flusso.
 */
export function numberAt(steps: Step[], path: string): number | null {
  return stepNumbers(steps).get(path.replace(/\[\d+\]/g, "[0]")) ?? null;
}
