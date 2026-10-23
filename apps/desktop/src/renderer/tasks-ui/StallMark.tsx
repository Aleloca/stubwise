import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { usePeople, useTasks } from "../data/queries";
import type { Stall } from "../domain/stalled";

/** Come risolvere i riferimenti di un motivo; ciò che non si trova ha una frase generica. */
export interface StallNames {
  personName?(id: string): string | undefined;
  taskCode?(id: string): string | undefined;
}

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/**
 * La frase del motivo per cui una task è ferma, con da quanto:
 * «Waiting for Elena's decision · 4 days». «Nessuno la tocca» porta i giorni
 * dentro la frase; il motivo manuale è il testo di chi l'ha segnata.
 */
export function stallText(stall: Stall, t: TFunction, names: StallNames = {}): string {
  const r = stall.reason;
  if (r.kind === "idle") return t("taskUi.stall.idle", { count: stall.days });
  let reason: string;
  switch (r.kind) {
    case "manual":
      reason = r.reason;
      break;
    case "decision": {
      const name = names.personName?.(r.personId);
      reason = t("taskUi.stall.decision", {
        name: name ? firstName(name) : t("taskUi.stall.someone"),
      });
      break;
    }
    case "claude_question":
      reason = t("taskUi.stall.claudeQuestion");
      break;
    case "blocked_by": {
      const code = names.taskCode?.(r.taskId);
      reason = code
        ? t("taskUi.stall.blockedBy", { code })
        : t("taskUi.stall.blockedByUnknown");
      break;
    }
    case "unassigned":
      reason = t("taskUi.stall.unassigned");
      break;
  }
  const since =
    stall.days === 0 ? t("taskUi.stall.today") : t("taskUi.stall.days", { count: stall.days });
  return `${reason} · ${since}`;
}

/** Il segno «ferma»: un cerchio con la pausa, in ambra (stato «a rischio»). */
function StallSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-warning"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 5.75v4.5M9.5 5.75v4.5" />
    </svg>
  );
}

type Variant = "compact" | "full";

/**
 * Segno «ferma» con il motivo. `compact` (righe e carte): il segno e i
 * giorni brevi («4d»), la frase intera nel `title` e per i lettori di
 * schermo. `full` (pannello, Overview): segno e frase intera. Il colore non
 * è mai solo: c'è la forma del segno e la frase.
 */
export function StallMark({ stall, variant = "compact" }: { stall: Stall; variant?: Variant }) {
  // Solo una bloccata ha bisogno di leggere le task (per il codice della bloccante).
  return stall.reason.kind === "blocked_by" ? (
    <BlockedStallMark stall={stall} variant={variant} />
  ) : (
    <StallMarkView stall={stall} variant={variant} />
  );
}

function BlockedStallMark({ stall, variant }: { stall: Stall; variant: Variant }) {
  const tasks = useTasks().data;
  return (
    <StallMarkView
      stall={stall}
      variant={variant}
      taskCode={(id) => tasks?.find((task) => task.id === id)?.code}
    />
  );
}

function StallMarkView({
  stall,
  variant,
  taskCode,
}: {
  stall: Stall;
  variant: Variant;
  taskCode?: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const text = stallText(stall, t, {
    personName: (id) => people?.find((p) => p.id === id)?.name,
    taskCode,
  });
  return (
    <span
      data-stall-mark
      data-stall-reason={stall.reason.kind}
      title={variant === "compact" ? text : undefined}
      className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted"
    >
      <StallSign />
      {variant === "compact" ? (
        <>
          <span aria-hidden="true" className="num text-xs whitespace-nowrap">
            {t("taskUi.stall.short", { count: stall.days })}
          </span>
          <span className="sr-only">{text}</span>
        </>
      ) : (
        <span className="min-w-0 text-ink">{text}</span>
      )}
    </span>
  );
}
