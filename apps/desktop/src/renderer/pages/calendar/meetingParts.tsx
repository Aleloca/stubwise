import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingTask } from "../../data/types";
import { DeptStrip } from "../../layout/DeptStrip";
import { formatDue } from "../../tasks-ui/TaskRow";
import { CheckGlyph } from "../claude/conversation/parts";
import type { BlockState } from "../home/blocks/BlockSection";
import { ClockGlyph } from "../mail/glyphs";
import { ghostButton, smallSecondary } from "../task/parts";

// I pezzi comuni della scheda di preparazione e del riassunto di una
// riunione (shape meeting-prep.md): il guscio di una sezione del pannello
// con i suoi stati, le righe delle cose da fare nate da una riunione con lo
// stato di ADESSO in parole, e l'apertura di una task «al posto
// dell'evento» con «Back to event» per tornare [A 4].

/**
 * Una sezione della scheda: titolo e conteggio, poi caricamento (la forma
 * vera, due righe), errore con «Retry» DENTRO la sezione, vuoto in una riga
 * calma, o il contenuto. Le sezioni accanto restano come sono.
 */
export function SheetSection({
  title,
  count,
  state,
  headingClassName = "text-md font-semibold text-ink",
  extra,
  children,
}: {
  title: string;
  count?: number;
  state: BlockState;
  headingClassName?: string;
  /** Accanto al titolo (es. «Generated text»). */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col pt-4">
      <div className="flex min-h-6 items-center gap-2 px-4 pb-1.5">
        <h4 id={id} className={headingClassName}>
          {title}
        </h4>
        {state.status === "ready" && count !== undefined && count > 0 && (
          <span className="num text-sm text-ink-faint">{count}</span>
        )}
        {extra}
      </div>
      {state.status === "loading" && <SheetSkeleton />}
      {state.status === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1">
          <p className="text-sm text-ink">{t("calendar.prep.error", { title })}</p>
          <button type="button" className={smallSecondary} onClick={state.retry}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      )}
      {state.status === "empty" && <p className="px-4 py-1 text-sm text-ink-muted">{state.text}</p>}
      {state.status === "ready" && children}
    </section>
  );
}

/** Lo scheletro di una sezione: due righe con la forma di quelle vere. */
export function SheetSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation();
  const bar = "h-2.5 rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3 px-4 py-2">
      <span role="status" className="sr-only">
        {label ?? t("taskUi.states.loading")}
      </span>
      {[72, 56].map((w) => (
        <div key={w} className="flex items-center gap-3">
          <span className={`${bar} w-12 shrink-0`} />
          <span className={bar} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Quante cose da fare si vedono per riunione prima di «N more» (shape §5). */
export const MEETING_TASKS_CAP = 6;

/**
 * Le cose da fare nate da una riunione: striscia del reparto, codice,
 * titolo, lo stato di adesso in parole a destra. Le prime 6, poi «N more»
 * che espande sul posto. `empty` è la frase quando non ne è nata nessuna.
 */
export function MeetingTaskList({
  tasks,
  projectCode,
  eventId,
  empty,
  label,
}: {
  tasks: MeetingTask[];
  /** Il progetto delle richieste nate (il loro link); `null` se chi guarda non lo vede. */
  projectCode: string | null;
  /** L'evento del pannello: la task si apre al suo posto, con «Back to event». */
  eventId: string;
  empty: string | null;
  label: string;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  if (tasks.length === 0) {
    return empty ? <p className="px-4 py-1 text-sm text-ink-muted">{empty}</p> : null;
  }
  const shown = all ? tasks : tasks.slice(0, MEETING_TASKS_CAP);
  const hidden = tasks.length - MEETING_TASKS_CAP;
  return (
    <>
      <ul aria-label={label} className="flex flex-col">
        {shown.map((task) => (
          <MeetingTaskRow key={task.id} task={task} projectCode={projectCode} eventId={eventId} />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className={`${ghostButton} mt-0.5 ml-2 self-start`}
        >
          {all ? t("calendar.prep.fewerTasks") : t("calendar.prep.moreTasks", { count: hidden })}
        </button>
      )}
    </>
  );
}

function MeetingTaskRow({
  task,
  projectCode,
  eventId,
}: {
  task: MeetingTask;
  projectCode: string | null;
  eventId: string;
}) {
  const openTask = useOpenTaskFromEvent(eventId);
  const name = (
    <>
      <span className="num w-[4.5rem] shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
        {task.code}
      </span>
      <span className="min-w-0 truncate text-sm text-ink">{task.title}</span>
    </>
  );
  const open =
    "flex min-w-0 flex-1 items-baseline gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus";
  return (
    <li
      data-meeting-task={task.code}
      title={task.title}
      className="relative flex h-9 items-center gap-3 pr-4 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <DeptStrip departmentId={task.departmentId} />
      {task.kind === "task" ? (
        <button type="button" onClick={() => openTask(task.code)} className={open}>
          {name}
        </button>
      ) : projectCode === null ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-2">{name}</span>
      ) : (
        <Link
          to="/p/$code/$section"
          params={{ code: projectCode, section: "requests" }}
          search={{ request: task.id } as never}
          className={open}
        >
          {name}
        </Link>
      )}
      <MeetingTaskStatus task={task} />
    </li>
  );
}

/**
 * Lo stato di adesso, sempre in parole: «Open», «In progress», «Done»
 * (positivo, con ✓), «Overdue · Oct 21» (critico, con l'orologio), «Request»
 * per una richiesta non ancora convertita. Il colore non è mai da solo.
 */
export function MeetingTaskStatus({ task }: { task: MeetingTask }) {
  const { t, i18n } = useTranslation();
  const base = "flex shrink-0 items-center gap-1 text-xs whitespace-nowrap";
  if (task.status === "done") {
    return (
      <span className={`${base} text-positive`}>
        <CheckGlyph size={12} />
        <span>{t("calendar.prep.taskStatus.done")}</span>
      </span>
    );
  }
  if (task.status === "late") {
    return (
      <span className={`${base} num font-semibold text-critical`}>
        <ClockGlyph />
        <span>
          {task.dueDate
            ? t("calendar.prep.taskStatus.overdue", { date: formatDue(task.dueDate, i18n.language) })
            : t("calendar.prep.taskStatus.overdueNoDate")}
        </span>
      </span>
    );
  }
  if (task.kind === "request") {
    return <span className={`${base} text-ink-muted`}>{t("calendar.prep.taskStatus.request")}</span>;
  }
  return task.inProgress ? (
    <span className={`${base} text-ink`}>{t("calendar.prep.taskStatus.inProgress")}</span>
  ) : (
    <span className={`${base} text-ink-muted`}>{t("calendar.prep.taskStatus.open")}</span>
  );
}

/** Lo stato della cronologia che ricorda l'evento da cui si è aperta una task. */
interface FromEventState {
  backToEvent?: string;
}

/**
 * Apre una task nel suo pannello AL POSTO dell'evento [A 4]: l'evento esce
 * dall'indirizzo e la cronologia ricorda da dove si veniva, così il
 * pannello della task offre «Back to event».
 */
export function useOpenTaskFromEvent(eventId: string): (code: string) => void {
  const navigate = useNavigate();
  return (code) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: code, event: undefined }),
      state: (prev: Record<string, unknown>) => ({ ...prev, backToEvent: eventId }),
    } as never);
}

/**
 * «Back to event» in testa al pannello della task, solo sul Calendario e
 * solo se la task si è aperta da un evento: toglie la task e riapre
 * l'evento.
 */
export function BackToEvent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const eventId = useRouterState({
    select: (s) =>
      s.location.pathname === "/calendar"
        ? (s.location.state as FromEventState).backToEvent
        : undefined,
  });
  if (!eventId) return null;
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-rule px-2">
      <button
        type="button"
        className={ghostButton}
        onClick={() =>
          void navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({ ...prev, task: undefined, event: eventId }),
            state: (prev: Record<string, unknown>) => ({ ...prev, backToEvent: undefined }),
          } as never)
        }
      >
        <span aria-hidden="true">←</span>
        {t("calendar.backToEvent")}
      </button>
    </div>
  );
}
