// Il lavoro di Claude su una task, letto dalle sue sessioni: il modulo puro
// sta in `@stubwise/shared` (`claude/task-work.ts`, integrazione area 3,
// fetta 3a), con i suoi test. Qui l'adattatore del prototipo, coi nomi di
// prima: i tipi del desktop (`data/model.ts`, `data/types.ts`) restano più
// ricchi e devono restare assegnabili a quelli condivisi (`claude/work.ts`).
export {
  correctionHeld,
  correctionsOf,
  lastMessage,
  lastReview,
  latestCorrection,
  openCard,
  phaseOf,
  prCycles,
  prKey,
  prLines,
  pullRequestsOf,
  statusOf,
  workStory,
} from "@stubwise/shared";
export type {
  CorrectionLine,
  CorrectionRecord,
  PrLine,
  StoryEntry,
  WorkPrCycle as PrCycle,
  WorkSource,
  WorkStatus,
} from "@stubwise/shared";
