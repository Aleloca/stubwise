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
export function pulseParts(pulse: ProjectPulse, t: TFunction, language: string): PulsePart[] {
  const parts: PulsePart[] = [];
  if (pulse.waitingOnMe) parts.push({ kind: "waiting", text: t("overview.pulse.waitingOnYou") });
  if (pulse.claudeWorking) parts.push({ kind: "claude", text: t("overview.pulse.claudeWorking") });
  // Area 9b: lavoro di Claude nato ma fermo (coda in pausa, budget): aspetta, non lavora.
  if (pulse.claudeWaiting) {
    parts.push({
      kind: "claude",
      text: t(
        pulse.claudeWaiting.reason === "queue_paused"
          ? "instanceEffects.pulse"
          : "instanceEffects.pulseBudget",
      ),
    });
  }
  if (pulse.stalled > 0) {
    parts.push({ kind: "stalled", text: t("overview.pulse.stalled", { count: pulse.stalled }) });
  }
  const next = pulse.nextMilestone;
  if (next) {
    parts.push({
      kind: "next",
      text: next.dueDate
        ? t("overview.pulse.nextDated", {
            name: next.name,
            date: formatDue(next.dueDate, language),
          })
        : t("overview.pulse.next", { name: next.name }),
    });
  }
  if (parts.length === 0) parts.push({ kind: "quiet", text: t("overview.pulse.quiet") });
  return parts;
}

/**
 * Un pezzo della riga: `kind` dice a chi la mostra cosa è, così può farne un
 * link (le ferme aprono le Tasks filtrate) senza rileggere il testo.
 */
export interface PulsePart {
  kind: "waiting" | "claude" | "stalled" | "next" | "quiet";
  text: string;
}

/** I pezzi uniti dal punto mediano: la riga intera. */
export function pulseLine(pulse: ProjectPulse, t: TFunction, language: string): string {
  return pulseParts(pulse, t, language)
    .map((p) => p.text)
    .join(" · ");
}
