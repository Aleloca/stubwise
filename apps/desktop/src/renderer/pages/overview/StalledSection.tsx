import { useTranslation } from "react-i18next";
import { usePeople, useStalled, useTasks } from "../../data/queries";
import type { FilterCriteria, Task } from "../../data/types";
import type { Stall } from "../../domain/stalled";
import { DeptLegend, DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { StallSign, stallReason, stallText, type StallNames } from "../../tasks-ui/StallMark";
import { ghostButton } from "../task/parts";
import { BlockSection, queryState, useOpenTask } from "../home/blocks/BlockSection";
import { TasksLink, countLinkClass } from "./links";

/** Quante ferme si vedono prima di «Show all N» (shape overview.md §5). */
export const STALLED_CAP = 5;

/** Le Tasks filtrate sulle ferme: il conteggio, «Show all N» e il polso ci portano. */
export const STALLED: FilterCriteria = { stalled: true };

/**
 * «Stalled»: in cima all'Overview, e SOLO se qualcosa è fermo (nessuna
 * sezione e nessuna frase quando non c'è niente). Dalla più vecchia: i
 * giorni in cifre tabellari a sinistra — il momento focale della pagina —
 * poi la task e il motivo vero in chiaro («Waiting for Elena's decision»,
 * «Blocked by AUD-12»). Clic su una riga → il pannello della task. Oltre
 * cinque, «Show all N» apre le Tasks filtrate sulle ferme.
 */
export function StalledSection({
  projectId,
  projectCode,
}: {
  projectId: string;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const stalled = useStalled({ projectIds: [projectId] });
  const people = usePeople().data;
  const tasks = useTasks({ projectIds: [projectId] }).data;
  const openTask = useOpenTask();
  const rows = stalled.data ?? [];
  // Mentre carica non si annuncia nulla: se poi non c'è niente, la sezione non c'era.
  if (!stalled.isError && rows.length === 0) return null;
  const names: StallNames = {
    personName: (id) => people?.find((p) => p.id === id)?.name,
    taskCode: (id) => tasks?.find((x) => x.id === id)?.code,
  };
  const shown = rows.slice(0, STALLED_CAP);
  return (
    <BlockSection
      title={t("overview.stalled.title")}
      count={rows.length}
      countLink={(n) => (
        <TasksLink
          projectCode={projectCode}
          criteria={STALLED}
          label={t("overview.stalled.countLink", { count: rows.length })}
          className={countLinkClass}
        >
          {n}
        </TasksLink>
      )}
      state={queryState([stalled])}
      action={<DeptLegend departmentIds={shown.map((r) => r.task.departmentId)} />}
    >
      <ul aria-label={t("overview.stalled.title")} className="border-t border-rule">
        {shown.map(({ task, stall }) => (
          <StalledRow
            key={task.id}
            task={task}
            stall={stall}
            names={names}
            onOpen={() => openTask(task.code)}
          />
        ))}
      </ul>
      {rows.length > STALLED_CAP && (
        <TasksLink
          projectCode={projectCode}
          criteria={STALLED}
          className={`${ghostButton} mt-1 ml-2`}
        >
          {t("overview.stalled.showAll", { count: rows.length })}
        </TasksLink>
      )}
    </BlockSection>
  );
}

/**
 * Una ferma: striscia del reparto · giorni · codice e titolo · motivo. Il
 * motivo manuale porta la nota fra virgolette. Tutta la riga apre la task
 * (il bottone si estende sotto le celle); la frase intera — motivo e da
 * quanto — è il nome accessibile, così i giorni non si leggono due volte.
 */
export function StalledRow({
  task,
  stall,
  names,
  onOpen,
  compact = false,
}: {
  task: Task;
  stall: Stall;
  names: StallNames;
  onOpen: () => void;
  /**
   * Per una colonna stretta (la scheda di preparazione nel pannello): il
   * motivo va a capo sotto il titolo invece di stargli accanto.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const deptLabel = useDeptLabel(task.departmentId);
  const reason = stallReason(stall, t, names);
  const note = stall.reason.kind === "manual" && stall.reason.note ? stall.reason.note : null;
  return (
    <li
      data-task-row={task.code}
      data-stall-reason={stall.reason.kind}
      title={deptLabel}
      className={`relative grid items-center border-b border-rule pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 ${compact ? "grid-cols-[40px_minmax(0,1fr)] gap-x-3 py-2 pr-4" : "h-11 grid-cols-[48px_minmax(0,1fr)_minmax(0,1.1fr)] gap-4 pr-3"}`}
    >
      <DeptStrip departmentId={task.departmentId} />
      <span
        aria-hidden="true"
        className={`num text-right text-lg font-semibold text-ink ${compact ? "row-span-2" : ""}`}
      >
        {t("taskUi.stall.short", { count: stall.days })}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${task.code} ${task.title} · ${stallText(stall, t, names)}${note ? ` · ${t("overview.stalled.note", { note })}` : ""}`}
        className="flex min-w-0 items-baseline gap-3 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
      >
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
          {task.code}
        </span>
        <span className="min-w-0 truncate text-md text-ink" title={task.title}>
          {task.title}
        </span>
      </button>
      <span
        aria-hidden="true"
        title={note ? `${reason} · ${t("overview.stalled.note", { note })}` : reason}
        className={`flex min-w-0 items-center gap-1.5 text-sm ${compact ? "col-start-2" : ""}`}
      >
        <StallSign />
        <span className="min-w-0 truncate">
          <span className="text-ink">{reason}</span>
          {note && (
            <span className="text-ink-muted"> · {t("overview.stalled.note", { note })}</span>
          )}
        </span>
      </span>
    </li>
  );
}
