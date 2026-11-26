import type { CorrectionRecord } from "./task-work.js";

/**
 * Il conteggio delle correzioni di una PR, l'UNICO del tetto (R-K2, R-K8),
 * spostato dal prototipo (`apps/desktop/src/renderer/domain/releases/prState.ts`,
 * integrazione area 3, fetta 3a): lo leggono `prCycles` (la sezione Claude
 * della task) e `prState` (i Rilasci, area 8, che resta nel desktop finché
 * l'area 8 non è integrata).
 *
 * Il giro DERIVATO dalle sessioni dice cosa mostrare; il conto che decide se
 * una correzione parte resta del server (`derivePrCycle`,
 * `docs/invariants/pr-corrections.md`): «il contatore dei giri si DERIVA, non
 * si salva».
 */

/** Il tetto delle correzioni quando il progetto non fissa un `correctionCap` (R-K2): l'unica copia. */
export const DEFAULT_CORRECTION_CAP = 3;

export interface PrCorrectionInput {
  trigger: "auto" | "person";
  state: "running" | "pushed" | "discarded" | "stopped";
}

/**
 * Contano solo le correzioni che hanno fatto, o stanno facendo, un commit; le
 * fermate prima del push (fallite, finite senza invio) e le scartate no.
 */
export const countedRound = (corrections: readonly PrCorrectionInput[]): number =>
  corrections.filter((c) => c.state === "pushed" || c.state === "running").length;

/** Le correzioni di una PR (`repo#numero`) lette dalle sessioni della task, per il conteggio. */
export function correctionsFromRecords(records: readonly CorrectionRecord[], prKey: string): PrCorrectionInput[] {
  return records
    .filter((r) => r.pr === prKey && !r.cancelled)
    .map((r): PrCorrectionInput => {
      if (r.state === "running" || r.state === "paused") return { trigger: "auto", state: "running" };
      if (r.state === "pushed") return { trigger: "auto", state: "pushed" };
      return { trigger: "auto", state: "stopped" };
    });
}
