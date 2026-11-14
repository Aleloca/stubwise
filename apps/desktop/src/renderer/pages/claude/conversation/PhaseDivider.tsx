import { useTranslation } from "react-i18next";
import type { FlowItem } from "./flow";
import { minutesBetween } from "./flow";
import { usePersonName, WorkingRing } from "./parts";

const KNOWN_PHASES = new Set([
  "triage",
  "plan",
  "replanning",
  "execution",
  "correction",
  "review",
  "reply",
  "refine",
]);

/**
 * Il separatore di una fase: un filetto con l'etichetta a sinistra
 * («Execution», «Correction 2») e l'esito in parole («done · 4 min»,
 * «failed», «timed out», «stopped by Giulia Ferri»). La fase aperta e in
 * corso ha l'anello di Claude.
 */
export function PhaseDivider({
  item,
  live,
}: {
  item: Extract<FlowItem, { kind: "phase" }>;
  /** Questa fase è quella in corso adesso (la conversazione lavora e non è chiusa). */
  live: boolean;
}) {
  const { t } = useTranslation();
  const { event, ordinal, startedAt } = item;
  const stoppedBy = usePersonName(event.stoppedById);
  const closedBy = usePersonName(event.closedById);
  const name = KNOWN_PHASES.has(event.phase)
    ? t(`claude.conversation.phase.${event.phase}`)
    : event.phase;
  const label =
    event.phase === "correction" || ordinal > 1
      ? t("claude.conversation.phase.numbered", { name, n: ordinal })
      : name;

  let outcome: string | null = null;
  if (event.outcome === "ok" && event.reason === "item_closed") {
    outcome = t("claude.conversation.phase.itemClosed");
  } else if (event.outcome === "ok" && closedBy) {
    outcome = t("claude.conversation.phase.closedBy", { name: closedBy });
  } else if (event.outcome === "ok") {
    outcome = startedAt
      ? t("claude.conversation.phase.doneIn", { minutes: minutesBetween(startedAt, event.at) })
      : t("claude.conversation.phase.done");
  } else if (event.outcome === "failed") outcome = t("claude.conversation.phase.failed");
  else if (event.outcome === "timed_out") outcome = t("claude.conversation.phase.timedOut");
  else if (event.outcome === "stopped") {
    // Una fermata senza persona (correzione di un server) dice il motivo.
    const reason = event.reason && event.reason !== "item_closed" ? event.reason : null;
    outcome = stoppedBy
      ? t("claude.conversation.phase.stoppedBy", { name: stoppedBy })
      : reason
        ? t(`claude.conversation.phase.reasons.${reason}`)
        : t("claude.conversation.phase.stopped");
  }
  const critical = event.outcome === "failed" || event.outcome === "timed_out";

  return (
    <div
      role="separator"
      aria-label={outcome ? `${label} · ${outcome}` : label}
      className="event-enter flex min-w-0 items-center gap-2.5 py-1 text-xs"
    >
      {live && <WorkingRing />}
      <span className="shrink-0 font-semibold text-ink">{label}</span>
      {outcome && (
        <span className={`shrink-0 ${critical ? "font-medium text-critical" : "text-ink-muted"}`}>
          {outcome}
        </span>
      )}
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-rule" />
    </div>
  );
}
