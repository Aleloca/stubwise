import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Person, Task } from "../../data/types";
import { planBlock, type PersonLoad } from "../../domain/planning";
import { LoadBar } from "../../tasks-ui/LoadBar";
import { Menu, MenuGroup, MenuNote, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useWeekRange } from "../week/WeekBoard";
import { usePlanning } from "./context";

/** Altezza massima del menu (`max-h-96`): sotto non c'è posto → si apre sopra. */
const MENU_MAX = 384;

function Back() {
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
      <path d="m9.5 4-4 4 4 4" />
    </svg>
  );
}

/**
 * Il menu «Plan» di una task, la via da tastiera del trascinamento (spec §5):
 * prima la persona — solo quelle per cui chi guarda può pianificare, ognuna
 * con la barra del suo carico nella prima settimana in vista — poi la
 * settimana, con il carico di quella persona in ognuna. «Back to To plan»
 * toglie la settimana e tiene la persona. Si apre accanto alla carta (in
 * posizione fissa: vasca e matrice scorrono e lo taglierebbero); Esc lo
 * chiude e rende il fuoco alla carta, senza chiudere il pannello sotto.
 */
export function PlanMenu({
  task,
  anchor,
  people,
  loads,
  weeks,
  firstWeek,
  max,
  onPlan,
  onClose,
}: {
  task: Task;
  anchor: HTMLElement;
  /** I candidati: i membri del progetto della task, Claude per ultimo. */
  people: Person[];
  loads: Map<string, PersonLoad>;
  /** Le settimane che si possono scegliere. */
  weeks: string[];
  /** La settimana del carico mostrato accanto alle persone. */
  firstWeek: string;
  max: number;
  onPlan: (assigneeId: string | null, week: string | null) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const range = useWeekRange();
  const ctx = usePlanning();
  const rights = ctx.rightsOf(task);
  const [person, setPerson] = useState<Person | null>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 336));
    setPos(below < MENU_MAX && r.top > below ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left });
  }, [anchor]);

  const allowed = people.filter((p) => planBlock(task, p.id, rights) === null);
  const toPool = task.plannedWeek !== null && planBlock(task, null, rights) === null;
  const loadBar = (personId: string, week: string, name: string) => {
    const cell = loads.get(personId)?.byWeek[week];
    return (
      <span className="w-20 shrink-0">
        <LoadBar
          max={max}
          unsized={0}
          weight={cell?.weight ?? 0}
          label={t("planning.loadOf", { person: name, week: week.slice(week.indexOf("-") + 1) })}
        />
      </span>
    );
  };

  return (
    // Il menu si chiude al clic fuori dal suo genitore: qui, questo contenitore.
    <div className="fixed z-50 w-80" style={pos}>
      <Menu
        key={person?.id ?? "people"}
        label={
          person
            ? t("planning.menu.weekLabel", { code: task.code, person: person.name })
            : t("planning.menu.label", { code: task.code })
        }
        placement={pos.bottom !== undefined ? "above" : "below"}
        onClose={onClose}
      >
        {person === null ? (
          <>
            <MenuGroup label={t("planning.menu.person")}>
              {allowed.map((p) => (
                <RadioItem key={p.id} checked={task.assigneeId === p.id} onSelect={() => setPerson(p)}>
                  <Avatar person={p} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {loadBar(p.id, firstWeek, p.name)}
                </RadioItem>
              ))}
              {!rights.others && <MenuNote>{t("planning.readOnlyRow")}</MenuNote>}
            </MenuGroup>
            {toPool && (
              <MenuGroup>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => onPlan(task.assigneeId, null)}
                >
                  {t("planning.menu.toPool")}
                </button>
              </MenuGroup>
            )}
          </>
        ) : (
          <>
            <MenuGroup>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${itemClass} text-ink-muted`}
                onClick={() => setPerson(null)}
              >
                <Back />
                {t("planning.menu.back")}
              </button>
            </MenuGroup>
            <MenuGroup label={t("planning.menu.week", { person: person.name })}>
              {weeks.map((week) => (
                <RadioItem
                  key={week}
                  checked={task.assigneeId === person.id && task.plannedWeek === week}
                  onSelect={() => onPlan(person.id, week)}
                >
                  <span className="num min-w-0 flex-1 truncate">{range(week)}</span>
                  {loadBar(person.id, week, person.name)}
                </RadioItem>
              ))}
            </MenuGroup>
          </>
        )}
      </Menu>
    </div>
  );
}
