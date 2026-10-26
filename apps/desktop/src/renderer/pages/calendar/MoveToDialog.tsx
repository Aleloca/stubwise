import { localDayKey } from "@stubwise/shared";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CalendarEventView } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { DAY_MS, inWindowSpan, iso } from "./blockMove";
import { shortDate, timeInputValue } from "./calendarFormat";
import type { WindowDays } from "./calendarParams";
import type { GridMove } from "./useBlockMove";

// «Move to…» dal menu ⋯ di un blocco (shape calendar.md §6): giorno e ora
// nuovi, la durata resta. È l'alternativa a trascinare per chi non usa il
// puntatore; poi lo stesso percorso dello spostamento (serie, «Undo»).

export function MoveToDialog({
  event,
  win,
  onMove,
  onClose,
}: {
  event: CalendarEventView;
  win: WindowDays;
  onMove: (move: GridMove) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ids = { date: useId(), time: useId() };
  const start = new Date(event.startsAt);
  const [date, setDate] = useState(event.allDay ? event.startsAt.slice(0, 10) : localDayKey(start));
  const [time, setTime] = useState(timeInputValue(start));
  const [error, setError] = useState<string | null>(null);
  const duration = Date.parse(event.endsAt) - Date.parse(event.startsAt);

  const submit = () => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const [h, min] = time.split(":").map(Number) as [number, number];
    const startMs = event.allDay ? Date.UTC(y, m - 1, d) : new Date(y, m - 1, d, h, min).getTime();
    // Un campo vuoto o incompleto: prima di farne una data ISO, che lancerebbe.
    if (Number.isNaN(startMs)) {
      setError(t("calendar.editor.invalidDate"));
      return;
    }
    const next = {
      startsAt: iso(startMs),
      endsAt: iso(startMs + (event.allDay ? Math.max(DAY_MS, duration) : duration)),
    };
    if (!inWindowSpan(next, event.allDay, win)) {
      setError(t("calendar.editor.outsideWindow", { date: shortDate(win.last, i18n.language) }));
      return;
    }
    onClose();
    if (next.startsAt !== event.startsAt) onMove({ event, ...next });
  };

  return (
    <Dialog
      title={t("calendar.moveTo.title", { title: event.title })}
      width={400}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("calendar.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={submit}>
            {t("calendar.scope.confirm.move")}
          </button>
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <DialogField label={t("calendar.editor.date")} htmlFor={ids.date}>
          <input
            id={ids.date}
            type="date"
            data-autofocus
            value={date}
            min={win.first}
            max={win.last}
            onChange={(e) => setDate(e.target.value)}
            className={`${inputClass} num w-40`}
          />
        </DialogField>
        {!event.allDay && (
          <DialogField label={t("calendar.editor.start")} htmlFor={ids.time}>
            <input
              id={ids.time}
              type="time"
              step={900}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={`${inputClass} num w-28`}
            />
          </DialogField>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
    </Dialog>
  );
}
