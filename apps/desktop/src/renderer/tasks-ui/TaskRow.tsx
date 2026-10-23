import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../data/dates";
import { useProjectStatuses } from "../data/queries";
import type { Task } from "../data/types";
import type { Stall } from "../domain/stalled";
import { DeptStrip, useDeptLabel } from "../layout/DeptStrip";
import { PersonChip } from "./PersonChip";
import { SizeMark } from "./SizeMark";
import { StallMark } from "./StallMark";
import { StatusLabel } from "./StatusLabel";

/** «Oct 24» / «24 ott», sempre in UTC: le scadenze sono date, non istanti. */
export function formatDue(date: string, language: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(language, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Un orologio: accompagna la data scaduta, perché il rosso non sia il solo segno. */
function OverdueSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2 1.5" />
    </svg>
  );
}

/** Scadenza in cifre tabellari; scaduta (e non chiusa) in rosso con l'orologio. */
export function DueDate({ date, overdue }: { date: string | null; overdue: boolean }) {
  const { t, i18n } = useTranslation();
  if (!date) return null;
  const text = formatDue(date, i18n.language);
  const label = overdue ? t("taskUi.due.overdue", { date: text }) : t("taskUi.due.label", { date: text });
  return (
    <span
      title={label}
      className={`num flex items-center justify-end gap-1 text-xs whitespace-nowrap ${overdue ? "font-semibold text-critical" : "text-ink-muted"}`}
    >
      {overdue && <OverdueSign />}
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

const HEIGHT = { compact: "h-9", regular: "h-11" } as const;

/**
 * Una task in un elenco, nell'ordine condiviso con carta e pannello:
 * striscia · codice · titolo · stato · persona · taglia · scadenza · ferma.
 * Il titolo è elastico (una riga, ellissi, intero nel `title`); le colonne a
 * destra hanno larghezza fissa (stato 140, persona 120, taglia 32, scadenza
 * 64) così si allineano riga per riga. La riga è un contenitore: quando è
 * stretta (finestra minima, pannello aperto) cade prima la scadenza e la
 * persona resta con le sole iniziali, poi la taglia e il nome dello stato.
 *
 * Tutta la riga apre la task: il bottone (codice e titolo, raggiungibile da
 * tastiera) si estende con `after:` sotto le celle, e le celle con un
 * `title` (stato, persona, taglia, scadenza, ferma) stanno SOPRA quello
 * strato (`relative`), così il loro tooltip si raggiunge col mouse; un clic
 * su di loro apre la task dal contenitore. Un controllo aggiunto in riga
 * (menu in riga) è un `button`: il contenitore lo lascia fare da sé.
 * Il motivo «ferma» lo passa chi ha già calcolato le ferme (`useStalled`).
 *
 * Per l'elenco delle task (selezione multipla, modifica in riga):
 * `onModifiedClick` riceve i clic con Maiusc o ⌘/Ctrl al posto di `onOpen`
 * (selezionano senza aprire); `statusCell` e `assigneeCell` sostituiscono il
 * contenuto delle due celle (un menu in riga), lasciandone la larghezza.
 */
export function TaskRow({
  task,
  density = "compact",
  selected = false,
  current,
  stall = null,
  onOpen,
  onModifiedClick,
  statusCell,
  assigneeCell,
}: {
  task: Task;
  density?: "compact" | "regular";
  selected?: boolean;
  /**
   * La task aperta (`aria-current`). Se chi chiama non la distingue vale
   * `selected`; l'elenco a selezione multipla la passa a parte, e allora
   * `selected` si dice ai lettori di schermo con «Selected».
   */
  current?: boolean;
  stall?: Stall | null;
  onOpen: (task: Task) => void;
  onModifiedClick?: (task: Task, mods: { range: boolean; toggle: boolean }) => void;
  statusCell?: ReactNode;
  assigneeCell?: ReactNode;
}) {
  const { t } = useTranslation();
  const statuses = useProjectStatuses(task.projectId).data;
  const status = statuses?.find((s) => s.id === task.statusId);
  const deptLabel = useDeptLabel(task.departmentId);
  const overdue = !!task.dueDate && task.dueDate < TODAY && status?.family !== "closed";
  const activate = (e: MouseEvent) => {
    const toggle = e.metaKey || e.ctrlKey;
    if (onModifiedClick && (e.shiftKey || toggle)) {
      onModifiedClick(task, { range: e.shiftKey, toggle });
    } else {
      onOpen(task);
    }
  };

  return (
    <div
      data-task-row={task.code}
      data-selected={selected ? "true" : undefined}
      title={deptLabel}
      onClick={(e) => {
        // Un clic su una cella (stato, persona…) apre la task come il bottone;
        // un controllo dentro la riga (bottone, link, menu) fa da sé.
        if (!(e.target as Element).closest("button, a, input, [role='menu']")) activate(e);
      }}
      className={`@container relative cursor-default border-b border-rule transition-colors duration-[var(--duration-fast)] ease-out has-[[data-row-open]:focus-visible]:outline-2 has-[[data-row-open]:focus-visible]:-outline-offset-2 has-[[data-row-open]:focus-visible]:outline-focus ${selected ? "bg-ink/10" : "hover:bg-ink/4"}`}
    >
      <div className={`flex items-center gap-3 pr-3 pl-4 ${HEIGHT[density]}`}>
        <DeptStrip departmentId={task.departmentId} />
        <button
          type="button"
          data-row-open
          aria-current={(current ?? selected) ? "true" : undefined}
          title={task.title}
          onClick={activate}
          className="flex min-w-0 flex-1 items-baseline gap-3 text-left outline-none after:absolute after:inset-0"
        >
          <span className="num w-16 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
            {task.code}
          </span>
          <span title={task.title} className="min-w-0 truncate text-md text-ink">
            {task.title}
          </span>
          {current !== undefined && selected && (
            <span className="sr-only">, {t("taskUi.selected")}</span>
          )}
        </button>
        <span className="relative flex w-[140px] shrink-0 @max-[560px]:w-4">
          {statusCell ?? <StatusLabel status={status} nameClassName="@max-[560px]:sr-only" />}
        </span>
        <span className="relative flex w-[120px] shrink-0 @max-[700px]:w-[22px]">
          {assigneeCell ?? (
            <PersonChip personId={task.assigneeId} nameClassName="@max-[700px]:sr-only" />
          )}
        </span>
        <span className="relative flex w-8 shrink-0 justify-center @max-[560px]:hidden">
          <SizeMark size={task.size} />
        </span>
        <span className="relative w-16 shrink-0 @max-[820px]:hidden">
          <DueDate date={task.dueDate} overdue={overdue} />
        </span>
        <span className="relative flex w-12 shrink-0">{stall && <StallMark stall={stall} />}</span>
      </div>
    </div>
  );
}
