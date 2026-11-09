import { addDays, localDayKey, startOfLocalDay } from "@stubwise/shared";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import {
  useCalendars,
  useCreateEvent,
  useFindFreeSlot,
  useFreeBusy,
  useMoveEvent,
  usePeople,
  useProjects,
  useSessionPersonId,
  useSetEventProject,
  useUpdateEvent,
} from "../../data/queries";
import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarScope,
  FreeBusy,
  MailAddress,
  Person,
} from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { RadioItem } from "../../tasks-ui/Menu";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { RecipientField } from "../mail/RecipientField";
import { MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import {
  lastAllDayKey,
  occurrenceLabel,
  shortDate,
  timeInputValue,
  timeLabel,
} from "./calendarFormat";
import type { WindowDays } from "./calendarParams";
import { SeriesScopeDialog } from "./SeriesScopeDialog";

// «New meeting» / «Edit meeting» (shape calendar.md §6, dialogo 560 px):
// Title · Date + Start + Duration (con la fine a parole) o All day · Guests
// (gli stessi suggerimenti della Posta) · Availability (libero/occupato dei
// colleghi, MAI un titolo) con «Find a time» · Add Google Meet (acceso di
// default con almeno un ospite, [A 6]) · Project · Reminders · Description
// e «From <casella>». Non si crea né si sposta oltre la fine della finestra
// ([A 8]). La modifica è dell'organizzatore; in una serie «Save» chiede lo
// scope. Le scelte sono menu del kit, non `<select>` nativi; data, inizio e
// durata stanno su una riga, alti 36 px. Il menu «Calendar» non c'è finché
// il livello dati non ha il campo: la riunione parte dalla prima casella.
// La ricorrenza resta fuori dall'editor (R-I18).

export interface EditorStart {
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** Il progetto in cui mi trovo, se si apre da lì. */
  projectId?: string | null;
}

const DURATIONS = [15, 30, 45, 60, 90, 120, 180] as const;
const STRIP_FROM = 8;
const STRIP_TO = 20;
const MIN_MS = 60_000;

type Reminder = "default" | "popup10" | "email30" | "email1440";
const REMINDERS: Record<Exclude<Reminder, "default">, CalendarEvent["reminders"]> = {
  popup10: [{ minutes: 10, method: "popup" }],
  email30: [{ minutes: 30, method: "email" }],
  email1440: [{ minutes: 1440, method: "email" }],
};
function reminderOf(r: CalendarEvent["reminders"]): Reminder {
  if (r === "default") return "default";
  const one = r[0];
  if (r.length === 1 && one) {
    if (one.method === "popup" && one.minutes === 10) return "popup10";
    if (one.method === "email" && one.minutes === 30) return "email30";
    if (one.method === "email" && one.minutes === 1440) return "email1440";
  }
  return "default";
}

/** Le ore di un `YYYY-MM-DD` + `HH:MM` locali, come istante. */
function at(day: string, time: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min).getTime();
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function EventEditor({
  start,
  event,
  win,
  onClose,
  onSaved,
}: {
  start: EditorStart;
  /** Con un evento: «Edit meeting». */
  event?: CalendarEventDetail;
  win: WindowDays;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const durationLabel = (m: number) =>
    m < 60
      ? t("calendar.editor.minutes", { count: m })
      : m % 60 === 0
        ? t("calendar.editor.hours", { count: m / 60 })
        : t("calendar.editor.hoursMinutes", { h: Math.floor(m / 60), m: m % 60 });
  const me = useSessionPersonId();
  const people = usePeople().data;
  const projects = useProjects().data;
  const calendars = useCalendars().data;
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const move = useMoveEvent();
  const setProject = useSetEventProject();
  const find = useFindFreeSlot();
  const toast = useToast();
  const ids = {
    title: useId(),
    date: useId(),
    start: useId(),
    end: useId(),
    to: useId(),
    description: useId(),
  };

  const s = new Date(start.startsAt);
  const e = new Date(start.endsAt);
  const [title, setTitle] = useState(event?.title ?? "");
  const [allDay, setAllDay] = useState(start.allDay);
  const [date, setDate] = useState(start.allDay ? start.startsAt.slice(0, 10) : localDayKey(s));
  const [toDate, setToDate] = useState(start.allDay ? lastAllDayKey(start) : localDayKey(s));
  const [time, setTime] = useState(start.allDay ? "09:00" : timeInputValue(s));
  const initialMinutes = start.allDay
    ? 30
    : Math.max(15, Math.round((e.getTime() - s.getTime()) / MIN_MS));
  const [duration, setDuration] = useState<number | "custom">(
    (DURATIONS as readonly number[]).includes(initialMinutes) ? initialMinutes : "custom",
  );
  const [endTime, setEndTime] = useState(start.allDay ? "09:30" : timeInputValue(e));
  const [guests, setGuests] = useState<MailAddress[]>(
    () =>
      event?.attendees
        .filter((a) => a.personId !== me)
        .map((a) => ({ name: a.name, email: a.email, personId: a.personId })) ?? [],
  );
  // `null` = segue la regola [A 6] (acceso con almeno un ospite) finché non lo si tocca.
  const [meetChoice, setMeetChoice] = useState<boolean | null>(event ? !!event.meetUrl : null);
  const [projectId, setProjectId] = useState<string | null>(
    event ? event.projectId : (start.projectId ?? null),
  );
  const [description, setDescription] = useState(event?.description ?? "");
  const [reminder, setReminder] = useState<Reminder>(
    event ? reminderOf(event.reminders) : "default",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState(false);
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const meet = meetChoice ?? guests.length > 0;

  const peopleMap = useMemo(
    () => new Map<string, Person>((people ?? []).map((p) => [p.id, p])),
    [people],
  );
  const mine = (projects ?? []).filter((p) => p.memberIds.includes(me));
  // Sempre la prima casella: scegliere il calendario non ha ancora un campo dati.
  const fromCalendar = calendars?.[0]?.email ?? null;
  // Il primario dice cosa succede: con ospiti NUOVI partono degli inviti.
  const known = new Set((event?.attendees ?? []).map((a) => a.email.toLowerCase()));
  const invites = guests.some((g) => !known.has(g.email.toLowerCase()));

  const startMs = allDay ? Date.parse(`${date}T00:00:00Z`) : at(date, time);
  const endMs = allDay
    ? Date.parse(`${toDate}T00:00:00Z`) + 86_400_000
    : duration === "custom"
      ? at(date, endTime)
      : startMs + duration * MIN_MS;

  const teamGuests = guests.filter((g) => g.personId && g.personId !== me);
  const dayStart = startOfLocalDay(new Date(`${date}T12:00:00`)).getTime();
  const freeBusy = useFreeBusy(
    teamGuests.map((g) => g.personId!),
    iso(dayStart),
    iso(addDays(new Date(dayStart), 1).getTime()),
  );

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = t("calendar.editor.addTitle");
    const first = allDay ? date : localDayKey(new Date(startMs));
    const last = allDay ? toDate : localDayKey(new Date(endMs - 1));
    if (endMs <= startMs || (allDay && toDate < date))
      next.time = t("calendar.editor.endBeforeStart");
    else if (first < win.first || last > win.last) {
      next.time = t("calendar.editor.outsideWindow", { date: shortDate(win.last, i18n.language) });
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const guestInput = guests.map((g) =>
    g.personId ? { personId: g.personId } : { email: g.email, name: g.name },
  );
  const reminders = reminder === "default" ? ("default" as const) : REMINDERS[reminder];

  async function apply(scope: CalendarScope) {
    if (!event) {
      // L'annuncio dopo l'esito, non prima: chi ascolta non sente «creata»
      // per una riunione rifiutata. `mutateAsync` e non le callback di
      // `mutate`, che a editor chiuso (smontato) non scatterebbero.
      await create
        .mutateAsync({
          title: title.trim(),
          startsAt: iso(startMs),
          endsAt: iso(endMs),
          allDay,
          guests: guestInput,
          addMeet: meet,
          description: description.trim() || null,
          projectId,
          reminders,
        })
        .then(
          (e) => onSaved(t("calendar.editor.created", { title: e.title })),
          () => toast.error(t("calendar.editor.failed")),
        );
      return;
    }
    // Fin dove è arrivato il salvataggio: un rifiuto dopo lo spostamento non
    // può dire «non è cambiato nulla», e uno dopo i dettagli dice cosa manca.
    let saved: "nothing" | "time" | "details" = "nothing";
    try {
      // Prima gli orari (e «tutto il giorno»): sono la parte che il livello
      // dati può rifiutare, e un rifiuto non deve lasciare salvato a metà il
      // resto (titolo, invitati).
      if (
        iso(startMs) !== event.startsAt ||
        iso(endMs) !== event.endsAt ||
        allDay !== event.allDay
      ) {
        await move.mutateAsync({
          id: event.id,
          startsAt: iso(startMs),
          endsAt: iso(endMs),
          scope,
          ...(allDay !== event.allDay ? { allDay } : {}),
        });
        saved = "time";
      }
      await update.mutateAsync({
        id: event.id,
        patch: {
          title: title.trim(),
          guests: guestInput,
          addMeet: meet,
          description: description.trim() || null,
          reminders,
        },
        scope,
      });
      saved = "details";
      if (projectId !== event.projectId) await setProject.mutateAsync({ id: event.id, projectId });
      onSaved(t("calendar.editor.updated", { title: title.trim() }));
    } catch {
      // Un rifiuto del livello dati (non un salvataggio fallito verso Google,
      // che l'evento dice da sé con «Riprova»): si dice a vista, e senza
      // annuncio di salvataggio.
      toast.error(
        saved === "details"
          ? t("calendar.editor.projectFailed", { title: title.trim() })
          : saved === "time"
            ? t("calendar.editor.updatePartial", { title: event.title })
            : t("calendar.editor.updateFailed"),
      );
    }
  }

  const submit = () => {
    if (!validate()) return;
    if (event?.seriesId) {
      setAsking(true);
      return;
    }
    void apply("one");
    onClose();
  };

  const findTime = () => {
    const ids = [me, ...teamGuests.map((g) => g.personId!)];
    const minutes = Math.max(15, Math.round((endMs - startMs) / MIN_MS));
    const from = Math.max(dayStart, Date.parse(now()));
    find.mutate(
      { personIds: ids, durationMin: minutes, from: iso(from) },
      {
        onSuccess: (slot) => {
          if (!slot) {
            setBusyNote(t("calendar.editor.noSlot"));
            return;
          }
          setBusyNote(null);
          const begin = new Date(slot.startsAt);
          setTime(timeInputValue(begin));
          if (duration === "custom") setEndTime(timeInputValue(new Date(slot.endsAt)));
        },
      },
    );
  };

  const untilLabel =
    endMs > startMs && !allDay
      ? t("calendar.editor.until", { time: timeLabel(new Date(endMs), i18n.language) })
      : null;

  if (asking && event) {
    return (
      <SeriesScopeDialog
        action="edit"
        dateLabel={occurrenceLabel(event, i18n.language)}
        onCancel={() => setAsking(false)}
        onConfirm={(scope) => {
          setAsking(false);
          void apply(scope);
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      title={event ? t("calendar.editor.editTitle") : t("calendar.editor.newTitle")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("calendar.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={submit}>
            {invites ? t("calendar.editor.send") : t("calendar.editor.save")}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
      >
        <DialogField label={t("calendar.editor.title")} htmlFor={ids.title}>
          <input
            id={ids.title}
            data-autofocus
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? `${ids.title}-err` : undefined}
            className={inputClass}
          />
          {errors.title && (
            <span id={`${ids.title}-err`} className="text-xs text-critical">
              {errors.title}
            </span>
          )}
        </DialogField>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-end gap-3">
            <DialogField label={t("calendar.editor.date")} htmlFor={ids.date}>
              <input
                id={ids.date}
                type="date"
                value={date}
                min={win.first}
                max={win.last}
                onChange={(ev) => {
                  setDate(ev.target.value);
                  if (toDate < ev.target.value) setToDate(ev.target.value);
                }}
                className={`${inputClass} num h-9 w-40`}
              />
            </DialogField>
            {allDay ? (
              <DialogField label={t("calendar.editor.to")} htmlFor={ids.to}>
                <input
                  id={ids.to}
                  type="date"
                  value={toDate}
                  min={date}
                  max={win.last}
                  onChange={(ev) => setToDate(ev.target.value)}
                  className={`${inputClass} num h-9 w-40`}
                />
              </DialogField>
            ) : (
              <>
                <DialogField label={t("calendar.editor.start")} htmlFor={ids.start}>
                  <input
                    id={ids.start}
                    type="time"
                    step={900}
                    value={time}
                    onChange={(ev) => setTime(ev.target.value)}
                    className={`${inputClass} num h-9 w-28`}
                  />
                </DialogField>
                <DialogField label={t("calendar.editor.duration")}>
                  <SelectMenu
                    label={t("calendar.editor.duration")}
                    width="w-32"
                    value={duration}
                    options={[
                      ...DURATIONS.map((d) => ({ value: d, text: durationLabel(d) })),
                      { value: "custom" as const, text: t("calendar.editor.custom") },
                    ]}
                    onChange={setDuration}
                  />
                </DialogField>
                {duration === "custom" && (
                  <DialogField label={t("calendar.editor.end")} htmlFor={ids.end}>
                    <input
                      id={ids.end}
                      type="time"
                      step={900}
                      value={endTime}
                      onChange={(ev) => setEndTime(ev.target.value)}
                      className={`${inputClass} num h-9 w-28`}
                    />
                  </DialogField>
                )}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={allDay}
                // In una serie «tutto il giorno» non si cambia da qui (vale per una data sola).
                disabled={!!event?.seriesId}
                onChange={(ev) => setAllDay(ev.target.checked)}
                className="size-3.5 accent-[var(--ink)]"
              />
              {t("calendar.editor.allDay")}
            </label>
            {untilLabel && <span className="num text-sm text-ink-muted">{untilLabel}</span>}
          </div>
          {errors.time && (
            <span role="alert" className="text-xs text-critical">
              {errors.time}
            </span>
          )}
        </div>

        <RecipientField
          variant="field"
          label={t("calendar.editor.guests")}
          placeholder={t("calendar.editor.guestsPlaceholder")}
          value={guests}
          onChange={setGuests}
          people={peopleMap}
        />

        {teamGuests.length > 0 && !allDay && (
          <Availability
            guests={teamGuests}
            data={freeBusy.data}
            dayStart={dayStart}
            startMs={startMs}
            endMs={endMs}
            peopleMap={peopleMap}
            onFind={findTime}
            finding={find.isPending}
            note={busyNote}
          />
        )}
        {guests.some((g) => !g.personId) && !allDay && (
          <p className="text-xs text-ink-muted">{t("calendar.editor.externalUnknown")}</p>
        )}

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={meet}
            onChange={(ev) => setMeetChoice(ev.target.checked)}
            className="mt-0.5 size-3.5 accent-[var(--ink)]"
          />
          <span className="flex flex-col">
            {t("calendar.editor.addMeet")}
            <span className="text-xs text-ink-muted">{t("calendar.editor.meetNote")}</span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <DialogField label={t("calendar.editor.project")}>
            <SelectMenu
              label={t("calendar.editor.project")}
              value={projectId}
              options={[
                { value: null, text: t("calendar.detail.noProject") },
                ...mine.map((p) => ({ value: p.id, text: `${p.code} ${p.name}` })),
              ]}
              onChange={setProjectId}
            />
          </DialogField>
          <DialogField label={t("calendar.editor.reminders")}>
            <SelectMenu
              label={t("calendar.editor.reminders")}
              value={reminder}
              options={[
                { value: "default" as const, text: t("calendar.editor.reminderDefault") },
                { value: "popup10" as const, text: t("calendar.detail.reminder.popup", { count: 10 }) },
                { value: "email30" as const, text: t("calendar.detail.reminder.email", { count: 30 }) },
                {
                  value: "email1440" as const,
                  text: t("calendar.detail.reminder.email", { count: 1440 }),
                },
              ]}
              onChange={setReminder}
            />
          </DialogField>
        </div>

        <DialogField label={t("calendar.editor.description")} htmlFor={ids.description}>
          <textarea
            id={ids.description}
            rows={3}
            value={description}
            onChange={(ev) => setDescription(ev.target.value)}
            className={`${inputClass} resize-y`}
          />
        </DialogField>

        {fromCalendar && (
          <p className="text-xs text-ink-muted">{t("calendar.editor.from", { email: fromCalendar })}</p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Una scelta del dialogo come menu del kit (non un `<select>` nativo): un
 * bottone alto 36 px come i campi accanto, il valore a parole e la freccia;
 * il menu con le voci a scelta singola. Il nome accessibile dice campo e
 * valore («Duration: 30 min»).
 */
function SelectMenu<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  width = "w-full",
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onChange: (value: T) => void;
  width?: string;
}) {
  const current = options.find((o) => o.value === value)?.text ?? "";
  return (
    <MenuButton
      menuLabel={label}
      ariaLabel={`${label}: ${current}`}
      wrapperClassName={`relative flex min-w-0 ${width}`}
      className={`${inputClass} flex h-9 items-center justify-between gap-2 text-left aria-expanded:border-ink/40`}
      label={
        <>
          <span className="min-w-0 truncate">{current}</span>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-muted">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      }
    >
      {(close) =>
        options.map((o) => (
          <RadioItem
            key={String(o.value)}
            checked={o.value === value}
            onSelect={() => {
              onChange(o.value);
              close();
            }}
          >
            {o.text}
          </RadioItem>
        ))
      }
    </MenuButton>
  );
}

/**
 * La disponibilità degli ospiti del team (shape §6): una riga per ospite, a
 * destra una striscia 8–20 con i tratti occupati e la fascia scelta, e la
 * parola «Free»/«Busy at that time». Mai un titolo, nemmeno nel tooltip.
 */
function Availability({
  guests,
  data,
  dayStart,
  startMs,
  endMs,
  peopleMap,
  onFind,
  finding,
  note,
}: {
  guests: MailAddress[];
  data: FreeBusy[] | undefined;
  dayStart: number;
  startMs: number;
  endMs: number;
  peopleMap: ReadonlyMap<string, Person>;
  onFind: () => void;
  finding: boolean;
  note: string | null;
}) {
  const { t, i18n } = useTranslation();
  const from = dayStart + STRIP_FROM * 60 * MIN_MS;
  const to = dayStart + STRIP_TO * 60 * MIN_MS;
  const pct = (ms: number) => `${(Math.max(0, Math.min(to, ms) - from) / (to - from)) * 100}%`;
  return (
    <section
      aria-label={t("calendar.editor.availability")}
      data-availability
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{t("calendar.editor.availability")}</span>
        <button
          type="button"
          onClick={onFind}
          disabled={finding}
          className="ml-auto rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink disabled:opacity-50"
        >
          {t("calendar.editor.findTime")}
        </button>
      </div>
      {note && (
        <p role="status" className="text-xs text-ink-muted">
          {note}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {guests.map((g) => {
          const fb = data?.find((d) => d.personId === g.personId);
          const busy = fb?.availability === "connected" ? fb.busy : [];
          const clash = busy.some(
            (b) => Date.parse(b.startsAt) < endMs && Date.parse(b.endsAt) > startMs,
          );
          const word = !fb
            ? "…"
            : fb.availability === "not_connected"
              ? t("calendar.editor.notConnected")
              : fb.availability === "expired"
                ? t("calendar.editor.unavailable")
                : clash
                  ? t("calendar.editor.busy")
                  : t("calendar.editor.free");
          return (
            <li
              key={g.email}
              data-availability-row={g.personId}
              className="flex min-w-0 items-center gap-2 text-sm"
            >
              <span className="flex w-[140px] shrink-0 items-center gap-1.5">
                <Avatar person={peopleMap.get(g.personId!)} />
                <span className="min-w-0 truncate text-ink">{g.name}</span>
              </span>
              <span className="relative h-4 min-w-0 flex-1 rounded-sm border border-rule bg-ground">
                {busy.map((b) => (
                  <span
                    key={b.startsAt}
                    title={t("calendar.editor.busyRange", {
                      from: timeLabel(b.startsAt, i18n.language),
                      to: timeLabel(b.endsAt, i18n.language),
                    })}
                    style={{
                      left: pct(Date.parse(b.startsAt)),
                      right: `calc(100% - ${pct(Date.parse(b.endsAt))})`,
                    }}
                    className="absolute inset-y-0 bg-ink/30"
                  />
                ))}
                {endMs > from && startMs < to && (
                  <span
                    aria-hidden="true"
                    style={{ left: pct(startMs), right: `calc(100% - ${pct(endMs)})` }}
                    className="absolute -inset-y-px rounded-[2px] border border-ink"
                  />
                )}
              </span>
              <span
                className={`w-36 shrink-0 text-xs ${clash ? "font-semibold text-ink" : "text-ink-muted"}`}
              >
                {word}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
