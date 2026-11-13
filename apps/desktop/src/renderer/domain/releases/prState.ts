
// Il conteggio delle correzioni (`countedRound`, `correctionsFromRecords`) e il
// tetto di default stanno in `@stubwise/shared` (`claude/pr-corrections.ts`,
// integrazione area 3, fetta 3a): li legge anche la sezione Claude della task.
export { correctionsFromRecords, countedRound, DEFAULT_CORRECTION_CAP } from "@stubwise/shared";
export type { PrCorrectionInput } from "@stubwise/shared";

// Lo stato di una PR e se Claude può correggerla: UN motore per tutte (spec
// «PR», scelta E). Il motore sta in `@stubwise/shared` (`prStateOf`,
// `colleaguePrBlock`, `isReadyForRelease`, area 8 F1), lo stesso del server e
// del worker: il prototipo usa quello, coi suoi nomi.

import { prStateOf, type OpenPrState } from "@stubwise/shared";
export {
  colleaguePrBlock,
  isReadyForRelease,
  type NotFixableReason,
  type PrStateInput,
  type PrStateKind,
} from "@stubwise/shared";

export type PrState = OpenPrState;

export const prState = prStateOf;
