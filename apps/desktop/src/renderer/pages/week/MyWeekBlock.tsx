import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { currentWeek, weekDays } from "../../domain/weeks";
import { TaskRow } from "../../tasks-ui/TaskRow";
import { ghostButton } from "../task/parts";
import { useStallsByCode } from "../home/blocks/MyTasksBlock";
import {
  BlockSection,
  Capped,
  queryState,
  useOpenTask,
  useReportDepartments,
} from "../home/blocks/BlockSection";
import { SLOTS, WeekLoad, dayName, todaySlot, useMyWeek, useWeekRange } from "./WeekBoard";

/**
 * «My week» nella Home: la versione compatta della pagina, solo per la
 * settimana corrente (shape home.md §3). Accanto al titolo la settimana;
 * sotto, quante task ho per giorno («This week» senza giorno per primo,
 * oggi detto a parole, i giorni vuoti col trattino) e il mio carico in
 * taglie con «+N no estimate»; poi le task che ho messo oggi, come righe.
 * «Open my week» apre la pagina intera.
 */
export function MyWeekBlock() {
  const { t, i18n } = useTranslation();
  const week = currentWeek();
  const data = useMyWeek(week);
  const range = useWeekRange();
  const openTask = useOpenTask();
  const stalls = useStallsByCode();
  const today = todaySlot(week);
  const todayTasks = today === 0 ? [] : data.bySlot[today]!;
  useReportDepartments("myWeek", todayTasks);
  const dates = weekDays(week);

  const state = queryState(data.queries, {
    when: data.tasks.length === 0,
    text: t("week.emptyThis"),
    body: t("week.emptyBody"),
  });
  return (
    <BlockSection
      title={t("home.blocks.myWeek")}
      count={data.tasks.length}
      meta={<span className="num">{range(week)}</span>}
      action={
        <Link to="/home" search={{ view: "week" }} className={ghostButton}>
          {t("week.open")}
        </Link>
      }
      state={state}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-rule py-3 pr-3 pl-4">
        <ul aria-label={t("week.perDay")} className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {SLOTS.map((slot) => {
            const count = data.bySlot[slot]!.length;
            const isToday = slot !== 0 && slot === today;
            const name =
              slot === 0
                ? t("week.anyDay")
                : isToday
                  ? t("week.today")
                  : dayName(dates[slot - 1]!, i18n.language, "short");
            return (
              <li key={slot} className="flex items-baseline gap-1.5 text-sm whitespace-nowrap">
                <span className={isToday ? "font-semibold text-ink" : "text-ink-muted"}>{name}</span>
                <span className={`num ${count === 0 ? "text-ink-faint" : "font-semibold text-ink"}`}>
                  {count === 0 ? "—" : count}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto max-w-[280px] min-w-[160px] flex-1">
          <WeekLoad tasks={data.tasks} busiest={data.busiest} />
        </div>
      </div>
      {/* Niente per oggi: lo dice già il conteggio («Today —»), senza una sezione vuota. */}
      {todayTasks.length > 0 && (
        <div className="mt-1">
          <h3 className="heading-group flex items-center gap-2 px-4 pt-2 pb-1.5">
            {t("week.today")}
            <span className="num text-ink-faint">{todayTasks.length}</span>
          </h3>
          <Capped
            items={todayTasks}
            label={t("week.today")}
            render={(task) => (
              <li key={task.id}>
                <TaskRow
                  task={task}
                  density="regular"
                  stall={stalls.get(task.code) ?? null}
                  onOpen={(x) => openTask(x.code)}
                />
              </li>
            )}
          />
        </div>
      )}
    </BlockSection>
  );
}
