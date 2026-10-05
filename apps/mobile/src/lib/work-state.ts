import { UNKNOWN, isUnknown, workStateFor } from "@stubwise/shared";
import type { AiJob, Reader, Unknown, WorkState } from "@stubwise/shared";

/**
 * Lo stato "in parole" dell'ultimo job di un ticket — `null` se non ha ancora
 * nessun job. Restituisce il dato grezzo (`UNKNOWN` incluso) e lascia al
 * chiamante ({@link StatusBadge}, il badge di testata della schermata Lavoro)
 * decidere come mostrarlo.
 *
 * Stava in `lib/timeline.ts`, accanto alla timeline a sei passi; quella esce
 * dall'app (piano `2026-10-05-ticket-history-and-replies`, B3), questa regola
 * regge la testata e resta.
 */
export function resolveWorkState(job: Reader<AiJob> | undefined): WorkState | Unknown | null {
  if (!job) return null;
  if (isUnknown(job.status)) return UNKNOWN;
  return workStateFor(job.status);
}
