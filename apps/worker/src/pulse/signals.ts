/**
 * RE-EXPORT SOTTILE. I segnali del pulse (`isProjectIdle`, `listCandidates` e
 * le costanti/tipi che li accompagnano) sono stati spostati in
 * `@stubwise/notifications` (`project-signals.ts`, Fase 4 Task 11): il
 * consumatore non è più solo questo poller, ma anche `summarizeProject` del
 * server (`GET /api/projects/pulse`). `IN_FLIGHT_JOB_STATUSES` era già in
 * `@stubwise/notifications`, quindi tenere i segnali nello stesso package evita
 * un giro di dipendenza fra worker e notifications.
 *
 * Questo file resta solo perché `./poller.ts` e `./poller.test.ts` importano
 * ancora da `./signals.js`: nessuna logica qui, un import diretto da
 * `@stubwise/notifications` renderebbe questo file superfluo — a quel punto va
 * eliminato, non svuotato ulteriormente.
 */
export {
  isProjectIdle,
  listCandidates,
  PULSE_HELD_STATUS,
  PULSE_IN_FLIGHT_STATUSES,
  PULSE_BLOCKING_JOB_STATUSES,
  type IdleBlocker,
  type ProjectIdleness,
  type PulseCandidate,
} from "@stubwise/notifications";
