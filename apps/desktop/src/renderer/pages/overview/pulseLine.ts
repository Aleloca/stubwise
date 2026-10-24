import type { TFunction } from "i18next";
import type { ProjectPulse } from "../../data/types";
import { formatDue } from "../../tasks-ui/TaskRow";

/**
 * La riga di polso di un progetto, in prosa breve: «Waiting on you · Claude
 * working · 3 stalled · next: Launch · Nov 14». UNA formula per due
 * superfici (shape overview.md §7): la testata dell'Overview e la riga del
 * portafoglio (Task 14) usano questa funzione, così non dicono due verità.
 *
 * Restituisce i pezzi in ordine di priorità (il primo è il più importante):
 * chi ha poco spazio li accorcia dalla coda — il traguardo cade per primo,
 * «3 stalled» resta. Un progetto senza nulla da dire ha un pezzo solo, quieto.
 */
export function pulseParts(pulse: ProjectPulse, t: TFunction, language: string): string[] {
  const parts: string[] = [];
  if (pulse.waitingOnMe) parts.push(t("overview.pulse.waitingOnYou"));
  if (pulse.claudeWorking) parts.push(t("overview.pulse.claudeWorking"));
  if (pulse.stalled > 0) parts.push(t("overview.pulse.stalled", { count: pulse.stalled }));
  const next = pulse.nextMilestone;
  if (next) {
    parts.push(
      next.dueDate
        ? t("overview.pulse.nextDated", {
            name: next.name,
            date: formatDue(next.dueDate, language),
          })
        : t("overview.pulse.next", { name: next.name }),
    );
  }
  if (parts.length === 0) parts.push(t("overview.pulse.quiet"));
  return parts;
}

/** I pezzi uniti dal punto mediano: la riga intera. */
export function pulseLine(pulse: ProjectPulse, t: TFunction, language: string): string {
  return pulseParts(pulse, t, language).join(" · ");
}
