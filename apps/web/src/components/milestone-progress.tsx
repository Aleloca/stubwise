import { useTranslation } from "react-i18next";
import type { MilestoneWithCounts } from "../lib/api";
import { formatDate } from "../lib/format";

/**
 * Una milestone aperta nella pagina Roadmap: nome, scadenza e avanzamento.
 *
 * L'avanzamento NON è ricalcolato qui: `counts` arriva già dal server
 * (`GET /api/milestones`), che sa quali stati contano come "completato". Un
 * secondo conteggio lato client sarebbe una seconda definizione di "fatto",
 * pronta a divergere dalla prima.
 *
 * `now` è iniettabile perché "scaduta" dipende dall'istante, e un test non può
 * asserire su un confronto che scorre mentre gira.
 */
export function MilestoneProgress({
  milestone,
  now = new Date(),
}: {
  milestone: MilestoneWithCounts;
  now?: Date;
}) {
  const { t } = useTranslation();
  const { total, completed } = milestone.counts;
  // Zero ticket è uno stato reale (milestone appena creata), non un errore:
  // 0% e una didascalia esplicita, mai una divisione per zero.
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  const overdue =
    milestone.dueDate !== null && new Date(milestone.dueDate).getTime() < now.getTime();

  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] font-medium text-fg">{milestone.name}</span>
        <span
          className={`font-mono text-[11px] ${overdue ? "text-danger" : "text-fg-faint"}`}
        >
          {milestone.dueDate === null
            ? t("projects:roadmap.noDueDate")
            : overdue
              ? `${t("projects:roadmap.overdue")} · ${formatDate(milestone.dueDate)}`
              : t("projects:roadmap.dueOn", { date: formatDate(milestone.dueDate) })}
        </span>
      </div>

      {milestone.description !== null && (
        <p className="mt-1 text-[12px] text-fg-muted">{milestone.description}</p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={milestone.name}
          className="h-1.5 min-w-0 flex-1 rounded-sm bg-ink-800"
        >
          <div className="h-full rounded-sm bg-signal" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-fg-faint">
          {total === 0
            ? t("projects:roadmap.progressEmpty")
            : t("projects:roadmap.progress", { completed, total })}
        </span>
      </div>
    </li>
  );
}
