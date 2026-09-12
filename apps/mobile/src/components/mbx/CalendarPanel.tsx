import {
  eventsForDay,
  localDayKey,
  monthGridDays,
  rangeForView,
  startOfLocalDay,
  stepAnchor,
  type CalendarEventItem,
  type Reader,
} from "@stubwise/shared";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SectionLabel } from "../SectionLabel";
import { Skeleton } from "../Skeleton";
import { GhostButton } from "../GhostButton";
import { EventSheet } from "./EventSheet";
import { useCalendarRange } from "../../lib/calendar-mutations";
import { canStepMonth, ingestionWindow, monthEdge } from "../../lib/calendar-window";
import { clockTime } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Il CALENDARIO dell'app (App M3, Fase D, Task 11 — design §6,
 * architettura §6b): una griglia MENSILE con un puntino sui giorni pieni e
 * il dettaglio del giorno scelto sotto. Non una vista settimanale e non tre
 * viste come sul web: su un telefono il mese è l'unica che risponde alla
 * domanda vera — «in che giorni c'è qualcosa?» — senza chiedere di scorrere.
 *
 * **Lo stato vuoto è il caso NORMALE, non l'eccezione.** Questo calendario
 * mostra il lavoro RICONOSCIUTO, non la settimana di chi guarda: entrano
 * solo gli appuntamenti che combaciano con le regole di smistamento di un
 * progetto. Un giorno senza niente non dice «nessun evento» — dice cosa si
 * vede qui e dove si cambiano le regole che lo decidono.
 *
 * **La navigazione si ferma ai bordi della finestra di ingestione**
 * (`now − 30gg → now + 60gg`, `lib/calendar-window.ts`): oltre, i mesi
 * sarebbero vuoti non perché non ci siano impegni ma perché lì Stubwise non
 * guarda, e sembrerebbe un guasto. Al bordo la riga sotto le frecce dice
 * perché — PRIMA che qualcuno prema una freccia che non risponde.
 *
 * ⚠️ **I fusi sono già decisi, e si riusano**: eventi con orario nel fuso
 * locale, «tutto il giorno» con i getter UTC. La scelta è presa e motivata
 * nel docblock di `calendar-grid.ts` (`@stubwise/shared`) e vive dentro
 * `eventsForDay`/`localDayKey`, che questo componente usa senza
 * rideciderla: l'unica ora che questo file calcola da sé è `clockTime`, che
 * è locale apposta e non tocca mai un evento `allDay`.
 */

/** Le iniziali dei giorni, lunedì→domenica: l'ordine è quello di `monthGridDays`. */
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function CalendarPanel({
  /** `now` iniettabile per i test, stesso pattern di `relativeTimeCompact`. */
  now = new Date(),
}: {
  now?: Date;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState(() => startOfLocalDay(now));
  const [selectedDay, setSelectedDay] = useState(() => startOfLocalDay(now));
  // L'evento APERTO nel foglio (Task 12): `null` = foglio chiuso.
  const [openEvent, setOpenEvent] = useState<Reader<CalendarEventItem> | null>(null);

  const range = useMemo(() => {
    const { from, to } = rangeForView("month", anchor);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [anchor]);
  const query = useCalendarRange(range);

  const events = query.data?.items ?? [];
  const days = useMemo(() => monthGridDays(anchor), [anchor]);
  const selectedKey = localDayKey(selectedDay);
  const todayKey = localDayKey(now);
  const edge = monthEdge(anchor, now);

  const move = (direction: 1 | -1) => {
    if (!canStepMonth(anchor, direction, now)) return;
    const next = stepAnchor("month", anchor, direction);
    setAnchor(next);
    // Il giorno scelto segue il mese: restare su un giorno che non è più
    // nella griglia mostrerebbe un'agenda scollegata da ciò che si vede.
    setSelectedDay(next);
  };

  return (
    <View testID="calendar-panel">
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStepMonth(anchor, -1, now) }}
          disabled={!canStepMonth(anchor, -1, now)}
          onPress={() => move(-1)}
          style={[styles.arrow, !canStepMonth(anchor, -1, now) && styles.arrowDisabled]}
          testID="calendar-prev-month"
        >
          <Text style={styles.arrowLabel}>←</Text>
        </Pressable>

        <Text style={styles.monthLabel} testID="calendar-month-label">
          {t(`mobile.calendar.months.${anchor.getMonth()}`)} {anchor.getFullYear()}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStepMonth(anchor, 1, now) }}
          disabled={!canStepMonth(anchor, 1, now)}
          onPress={() => move(1)}
          style={[styles.arrow, !canStepMonth(anchor, 1, now) && styles.arrowDisabled]}
          testID="calendar-next-month"
        >
          <Text style={styles.arrowLabel}>→</Text>
        </Pressable>
      </View>

      {edge !== null && <WindowEdgeNote edge={edge} now={now} />}

      <View style={styles.weekdayRow}>
        {WEEKDAY_KEYS.map((key) => (
          <Text key={key} style={styles.weekdayLabel}>
            {t(`mobile.calendar.weekdays.${key}`)}
          </Text>
        ))}
      </View>

      {query.isPending ? (
        <View style={styles.gridSkeleton} testID="calendar-skeleton">
          <Skeleton height={200} />
        </View>
      ) : (
        <View style={styles.grid} testID="calendar-grid">
          {days.map((day) => {
            const key = localDayKey(day);
            const count = eventsForDay(events, day).length;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: key === selectedKey }}
                onPress={() => setSelectedDay(day)}
                style={[styles.cell, key === selectedKey && styles.cellSelected]}
                testID={`calendar-day-${key}`}
              >
                <Text
                  style={[
                    styles.cellNumber,
                    day.getMonth() !== anchor.getMonth() && styles.cellOutside,
                    key === todayKey && styles.cellToday,
                    key === selectedKey && styles.cellNumberSelected,
                  ]}
                >
                  {day.getDate()}
                </Text>
                {/* Il puntino dice "qui c'è qualcosa", non quanto: un numero
                    su una cella da 40px si legge male e non aggiunge nulla a
                    chi poi apre il giorno. */}
                <View style={[styles.dot, count > 0 && styles.dotFull]} testID={count > 0 ? `calendar-dot-${key}` : undefined} />
              </Pressable>
            );
          })}
        </View>
      )}

      {query.isError ? (
        <View style={styles.dayBlock} testID="calendar-error">
          <Text style={styles.emptyTitle}>{t("mobile.calendar.loadError.title")}</Text>
          <View style={styles.retryButton}>
            <GhostButton
              label={t("mobile.calendar.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="calendar-retry"
            />
          </View>
        </View>
      ) : (
        <DayAgenda day={selectedDay} events={events} loading={query.isPending} onSelectEvent={setOpenEvent} />
      )}

      {openEvent !== null && (
        // `key` sull'id: il foglio (e con lui la configurazione della serie)
        // nasce insieme all'evento a cui si riferisce, mai riusato fra due
        // eventi diversi — vedi il commento su `SeriesConfig` in
        // `EventSheet.tsx`.
        <EventSheet
          key={openEvent.id}
          event={openEvent}
          visible
          onRequestClose={() => setOpenEvent(null)}
        />
      )}
    </View>
  );
}

/**
 * La riga che spiega il bordo. Non è un errore e non è un avviso: è
 * l'unica informazione che distingue «non c'è niente» da «qui non
 * guardiamo», e senza di lei un mese vuoto al bordo sembra un guasto.
 */
function WindowEdgeNote({ edge, now }: { edge: "start" | "end" | "both"; now: Date }) {
  const { t } = useTranslation();
  const { from, to } = ingestionWindow(now);
  const span = {
    from: `${from.getDate()} ${t(`mobile.calendar.months.${from.getMonth()}`)}`,
    to: `${to.getDate()} ${t(`mobile.calendar.months.${to.getMonth()}`)}`,
  };
  const key =
    edge === "start"
      ? "mobile.calendar.edge.start"
      : edge === "end"
        ? "mobile.calendar.edge.end"
        : "mobile.calendar.edge.both";
  return (
    <Text style={styles.edgeNote} testID={`calendar-edge-${edge}`}>
      {t(key, span)}
    </Text>
  );
}

function DayAgenda({
  day,
  events,
  loading,
  onSelectEvent,
}: {
  day: Date;
  events: Reader<CalendarEventItem>[];
  loading: boolean;
  onSelectEvent?: (event: Reader<CalendarEventItem>) => void;
}) {
  const { t } = useTranslation();
  const ofDay = eventsForDay(events, day);
  const heading = `${t(`mobile.calendar.weekdaysLong.${WEEKDAY_KEYS[(day.getDay() + 6) % 7]!}`)} ${day.getDate()} ${t(
    `mobile.calendar.months.${day.getMonth()}`,
  )}`;

  return (
    <View style={styles.dayBlock} testID="calendar-day-agenda">
      <SectionLabel>{heading}</SectionLabel>

      {loading ? null : ofDay.length === 0 ? (
        // Lo stato vuoto di un giorno è il caso NORMALE (design §6): dice
        // cosa si vede qui e dove si cambiano le regole che lo decidono, mai
        // «nessun evento» — che suonerebbe come un calendario rotto.
        <View style={styles.emptyDay} testID="calendar-day-empty">
          <Text style={styles.emptyTitle}>{t("mobile.calendar.dayEmpty.title")}</Text>
          <Text style={styles.emptyBody}>{t("mobile.calendar.dayEmpty.body")}</Text>
        </View>
      ) : (
        <View style={styles.eventList}>
          {ofDay.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              {...(onSelectEvent ? { onPress: () => onSelectEvent(event) } : {})}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Una riga dell'agenda del giorno. Premibile SOLO se c'è davvero un
 * dettaglio da aprire (`onPress` passato): stesso pattern di `MailRow` in
 * `MbxScreen`, per non offrire un tap che non fa niente.
 */
function EventRow({ event, onPress }: { event: Reader<CalendarEventItem>; onPress?: () => void }) {
  const { t } = useTranslation();
  const content = (
    <>
      <Text style={styles.eventTime}>
        {event.allDay ? t("mobile.calendar.allDay") : clockTime(event.startsAt)}
      </Text>
      <View style={styles.eventBody}>
        <Text style={styles.eventTitle} numberOfLines={2}>
          {event.title ?? t("mobile.calendar.noTitle")}
        </Text>
        {event.projectName !== null && (
          <Text style={styles.eventProject} numberOfLines={1}>
            {event.projectName}
          </Text>
        )}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View style={styles.eventRow} testID={`calendar-event-${event.id}`}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.eventRow}
      testID={`calendar-event-${event.id}`}
    >
      {content}
    </Pressable>
  );
}

const CELL_SIZE = 40;

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    marginTop: 4,
  },
  arrow: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 44,
  },
  arrowDisabled: {
    opacity: 0.3,
  },
  arrowLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 14,
  },
  monthLabel: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    letterSpacing: 1,
    textAlign: "center",
    textTransform: "uppercase",
  },
  edgeNote: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  weekdayRow: {
    flexDirection: "row",
    marginTop: 14,
  },
  weekdayLabel: {
    color: colors.faint,
    flex: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    textAlign: "center",
    textTransform: "uppercase",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 6,
  },
  gridSkeleton: {
    marginTop: 6,
  },
  cell: {
    alignItems: "center",
    borderRadius: radii.control,
    height: CELL_SIZE,
    justifyContent: "center",
    paddingTop: 2,
    width: `${100 / 7}%`,
  },
  cellSelected: {
    backgroundColor: colors.ink850,
  },
  cellNumber: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  cellNumberSelected: {
    color: colors.fg,
  },
  cellOutside: {
    color: colors.faint,
    opacity: 0.5,
  },
  cellToday: {
    color: colors.signal,
  },
  dot: {
    backgroundColor: "transparent",
    borderRadius: 2,
    height: 4,
    marginTop: 3,
    width: 4,
  },
  dotFull: {
    backgroundColor: colors.signal,
  },
  dayBlock: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    marginTop: 18,
    paddingTop: 14,
  },
  eventList: {
    gap: 8,
    marginTop: 10,
  },
  eventRow: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 12,
  },
  eventTime: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    paddingTop: 2,
    width: 62,
  },
  eventBody: {
    flex: 1,
  },
  eventTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  eventProject: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  emptyDay: {
    marginTop: 12,
  },
  emptyTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  retryButton: {
    alignSelf: "flex-start",
    marginTop: 12,
  },
});
