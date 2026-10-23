import { useSearch } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { addWeeks, compareWeeks, currentWeek } from "../../domain/weeks";
import { DeptLegend } from "../../layout/DeptStrip";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { secondaryButton, quietButton } from "../tasks/controls";
import { shortWeek } from "../tasks/pickers";
import { useTaskKeys } from "../tasks/useTaskKeys";
import { queryState, useOpenTask } from "../home/blocks/BlockSection";
import { SLOTS, WeekBoard, WeekLoad, useMyWeek, useWeekRange } from "./WeekBoard";

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d={dir === "left" ? "m9.5 4-4 4 4 4" : "m6.5 4 4 4-4 4"} />
    </svg>
  );
}

/** Lo scheletro della settimana: sei colonne con l'intestazione e qualche carta. */
function WeekSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe grid grid-cols-6 gap-2">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {SLOTS.map((slot) => (
        <div key={slot} className="flex flex-col gap-2">
          <span className="flex flex-col gap-1.5 border-b border-rule px-1.5 pb-2">
            <span className={`h-3 w-10 ${bar}`} />
            <span className={`h-2.5 w-14 ${bar}`} />
          </span>
          {Array.from({ length: 1 + ((slot * 2) % 3) }, (_, i) => (
            <span key={i} className="flex h-[68px] flex-col gap-2 rounded-md border border-rule p-2.5">
              <span className={`h-2.5 w-12 ${bar}`} />
              <span className={`h-2.5 w-4/5 ${bar}`} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * La mia settimana a pagina intera (`/home?view=week`, shape home.md §6):
 * h1, sotto la settimana mostrata, la navigazione «Previous · This week ·
 * Next», la barra del mio carico con «+N no estimate» e, sulla settimana
 * corrente, «Plan next week» (= la settimana dopo). Poi le sei colonne. La
 * settimana precedente si guarda in sola lettura. Aprire una carta apre il
 * pannello (`?task=`), J/K scorrono le carte.
 */
export function MyWeekPage() {
  const { t } = useTranslation();
  const now = currentWeek();
  const [week, setWeek] = useState(now);
  const data = useMyWeek(week);
  const range = useWeekRange();
  const search = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  const body = useRef<HTMLDivElement>(null);
  useTaskKeys({ body, openCode: search.task, onOpen: openTask });

  const past = compareWeeks(week, now) < 0;
  const state = queryState(data.queries);
  const go = (n: number) => setWeek((w) => addWeeks(w, n));

  let content;
  if (state.status === "error") {
    content = <PageError message={t("week.error")} onRetry={state.retry} />;
  } else if (state.status === "loading") {
    content = <WeekSkeleton />;
  } else if (data.tasks.length === 0) {
    content = (
      <PageEmpty
        title={week === now ? t("week.emptyThis") : t("week.emptyOther", { week: shortWeek(week) })}
        body={t("week.emptyBody")}
      />
    );
  } else {
    content = (
      <>
        {past && <p className="pb-3 text-sm text-ink-muted">{t("week.readOnly")}</p>}
        <WeekBoard
          // Cambiare settimana smonta la board: nessuna carta presa resta a metà.
          key={week}
          week={week}
          bySlot={data.bySlot}
          readOnly={past}
          openCode={search.task}
          onOpen={(task) => openTask(task.code)}
        />
      </>
    );
  }

  return (
    <section className="flex min-h-full flex-col pr-8 pb-16 pl-8">
      <header className="page-header flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 pb-4 [--page-header-pr:0px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("week.title")}</h1>
        <nav aria-label={t("week.nav.label")} className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={quietButton}
            aria-label={t("week.nav.previousLabel")}
            onClick={() => go(-1)}
          >
            <Arrow dir="left" />
            {t("week.nav.previous")}
          </button>
          <button
            type="button"
            className={`${quietButton} disabled:text-ink-faint`}
            disabled={week === now}
            onClick={() => setWeek(now)}
          >
            {t("week.nav.thisWeek")}
          </button>
          <button
            type="button"
            className={quietButton}
            aria-label={t("week.nav.nextLabel")}
            onClick={() => go(1)}
          >
            {t("week.nav.next")}
            <Arrow dir="right" />
          </button>
        </nav>
      </header>
      <div className="flex min-h-8 flex-wrap items-center gap-x-6 gap-y-2 border-t border-rule py-3">
        <p className="num shrink-0 text-md font-semibold text-ink" aria-live="polite">
          {range(week)}
        </p>
        <div className="max-w-[320px] min-w-[160px] flex-1">
          {state.status === "ready" && <WeekLoad tasks={data.tasks} busiest={data.busiest} />}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-4">
          {state.status === "ready" && <DeptLegend departmentIds={data.tasks.map((x) => x.departmentId)} />}
          {week === now && (
            <button type="button" className={secondaryButton} onClick={() => go(1)}>
              {t("week.nav.planNext")}
              <Arrow dir="right" />
            </button>
          )}
        </span>
      </div>
      <div ref={body} className="pt-2">
        {content}
      </div>
    </section>
  );
}
