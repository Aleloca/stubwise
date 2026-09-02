import type { AiJobStatus } from "./schemas/ai-job.js";

/**
 * Vocabolario "in parole" dello stato di lavorazione di un ticket: è quello che
 * legge chi non conosce la pipeline (app mobile, notifiche), al posto dei nomi
 * interni della coda (`triaging`, `pr_opened`, …).
 *
 * Sono 11, uno per stato della coda, NON 9: `skipped` e `rejected` esistono
 * apposta perché comprimerli su `failed` racconterebbe una bugia — «Fallito»
 * per un ticket che il triage ha giudicato non fixabile, o per una PR che un
 * umano ha chiuso deliberatamente.
 */
export const WORK_STATES = [
  "proposed",
  "planning",
  "working",
  "held",
  "waiting_answer",
  "waiting_approval",
  "pr_ready",
  "done",
  "failed",
  "skipped",
  "rejected",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

/**
 * Traduzione stato della coda → stato in parole.
 *
 * È un `Record` tipizzato sull'enum, non uno `switch` con default: un valore
 * nuovo in `ai_job_status` fa fallire la COMPILAZIONE (proprietà mancante)
 * invece di scivolare in un fallback silenzioso. È l'unica difesa contro il
 * prossimo che aggiunge uno stato alla pipeline e dimentica la UI.
 */
const WORK_STATE_BY_JOB_STATUS: Record<AiJobStatus, WorkState> = {
  queued: "proposed",
  triaging: "planning",
  fixing: "working",
  held: "held",
  pr_opened: "pr_ready",
  pr_merged: "done",
  failed: "failed",
  skipped: "skipped",
  pr_closed: "rejected",
  awaiting_plan_approval: "waiting_approval",
  awaiting_input: "waiting_answer",
};

/** Stato in parole del job AI. Funzione pura: nessun I/O, nessun accesso al DB. */
export function workStateFor(status: AiJobStatus): WorkState {
  return WORK_STATE_BY_JOB_STATUS[status];
}
