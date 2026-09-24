import type {
  CalendarAttendeeResponseStatus,
  CalendarEventItem,
  CalendarSeriesAction,
  CalendarSeriesPatch,
  Reader,
} from "@stubwise/shared";
import {
  attendeeResponseOf,
  formatRecurrence,
  isSafeJoinUrl,
  isUnknown,
  parseRecurrence,
} from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { LinkedText } from "../LinkedText";
import { SectionLabel } from "../SectionLabel";
import { useCalendarSeries, useSeriesMutation } from "../../lib/calendar-mutations";
import { clockTime } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Il dettaglio di un appuntamento, e — se appartiene a una serie ricorrente
 * — la sua CONFIGURAZIONE (App M3, Fase D, Task 12; design §6, come sul web
 * dalla fase 9). Un foglio modale invece di una rotta: il dettaglio di un
 * evento è breve e si chiude tornando alla griglia, non è una destinazione
 * in cui si naviga.
 *
 * ⚠️ **Una serie è SPENTA di default, e accenderla non è un dettaglio**: da
 * quel momento Stubwise agisce su OGNI occorrenza futura, non solo su
 * quella che si sta guardando (design fase 7b §4 — è la lezione
 * dell'incidente del 9 settembre 2026). Il testo lo dice prima
 * dell'interruttore, non dopo.
 *
 * ⚠️ **La UI non deve poter comporre `enabled: true` senza `projectId`.** Il
 * server lo rifiuta con un 400 `project_required`, ma quel 400 è la rete
 * sotto il trapezio: qui «Salva» resta disabilitato finché il progetto non
 * c'è, e il motivo è scritto accanto. Il `PUT` è una SOSTITUZIONE
 * INTEGRALE, quindi il corpo parte sempre con tutti i campi presi dal form.
 */

const ACTIONS: CalendarSeriesAction[] = ["milestone", "backlog_item", "reminder"];
const LEAD_DAYS_MIN = 0;
const LEAD_DAYS_MAX = 30;

export function EventSheet({
  event,
  visible,
  onRequestClose,
}: {
  event: Reader<CalendarEventItem>;
  visible: boolean;
  onRequestClose: () => void;
}) {
  const { t } = useTranslation();
  const link = event.eventUrl ?? event.url;
  // La TUA risposta, ricavata in lettura da `attendees` + l'indirizzo della
  // casella (design 15 set 2026 §1): nessuna colonna nuova, e `null` quando
  // non c'è una risposta leggibile — non sei fra i partecipanti, oppure
  // Google non l'ha mandata.
  const myResponse = attendeeResponseOf(event.attendees, event.accountEmail);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID="event-sheet">
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
          accessibilityLabel={t("mobile.calendar.sheet.close")}
        />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={styles.headerRow}>
              <Text style={styles.title}>{event.title ?? t("mobile.calendar.noTitle")}</Text>
              <Pressable accessibilityRole="button" onPress={onRequestClose} testID="event-sheet-close">
                <Text style={styles.close}>{t("mobile.calendar.sheet.close")}</Text>
              </Pressable>
            </View>

            <Text style={styles.when}>{whenLabel(event, t)}</Text>
            {event.organizer !== null && <Text style={styles.meta}>{event.organizer}</Text>}
            {event.projectName !== null && <Text style={styles.meta}>{event.projectName}</Text>}

            {/*
              SEPARATA dall'elenco dei partecipanti, non una riga fra le
              altre: «ci vado?» è una domanda di un altro ordine rispetto a
              «chi altro c'è».
            */}
            {myResponse !== null && (
              <View style={styles.section}>
                <SectionLabel>{t("mobile.calendar.sheet.yourResponse")}</SectionLabel>
                <Text
                  style={[styles.yourResponse, myResponse === "declined" && styles.yourResponseDeclined]}
                  testID="event-sheet-your-response"
                >
                  {t(`mobile.calendar.attendeeStatus.${myResponse}`)}
                </Text>
                {myResponse === "declined" && (
                  <Text style={styles.hint}>{t("mobile.calendar.sheet.declinedNotice")}</Text>
                )}
              </View>
            )}

            {event.attendees.length > 0 && (
              <View style={styles.section}>
                <SectionLabel>{t("mobile.calendar.sheet.attendees")}</SectionLabel>
                {event.attendees.map((attendee) => (
                  <View key={attendee.email} style={styles.attendeeRow}>
                    <Text style={styles.attendeeEmail} numberOfLines={1}>
                      {attendee.email}
                    </Text>
                    <Text style={styles.attendeeStatus}>{attendeeStatusLabel(attendee.responseStatus, t)}</Text>
                  </View>
                ))}
              </View>
            )}

            {/*
              ⚠️ `!= null` (LASCO) e non `!== null` su tutti i campi del 15
              set 2026: in produzione `packages/api-client` parsa davvero e
              il `.default()` dello schema li riempie, ma un server più
              vecchio — o un rollback — manda una risposta SENZA, e allora
              qui arriva `undefined`. `LinkedText` su `undefined` lancia e
              React smonta l'intero foglio, non una riga. I test lo fissano
              con una fixture che quei campi non li ha, apposta.
            */}
            {event.location != null && (
              <View style={styles.section}>
                <SectionLabel>{t("mobile.calendar.sheet.location")}</SectionLabel>
                <Text style={styles.body}>{event.location}</Text>
              </View>
            )}

            <JoinBlock hangoutLink={event.hangoutLink} entryPoints={event.conferenceEntryPoints} />

            {event.descriptionText != null && (
              <View style={styles.section}>
                <SectionLabel>{t("mobile.calendar.sheet.description")}</SectionLabel>
                {/*
                  ⚠️ TESTO, non HTML — e non è un ripiego. La descrizione di
                  un evento è scritta da chiunque abbia creato l'invito:
                  sul web si rende nell'`<iframe sandbox>`, qui non c'è un
                  recinto equivalente, quindi si usa il percorso che l'app ha
                  già per il corpo delle email (`LinkedText`, solo
                  `http`/`https` toccabili). Il testo arriva dal server, che
                  lo ricava dalla STESSA colonna con `htmlToText`.
                */}
                <LinkedText style={styles.body} text={event.descriptionText} testID="event-sheet-description" />
              </View>
            )}

            <RecurrenceBlock recurrence={event.recurrence} />

            <RemindersBlock reminders={event.reminders} useDefault={event.remindersUseDefault} />

            {link !== null && (
              <View style={styles.openButton}>
                <GhostButton
                  label={t("mobile.calendar.sheet.openInGoogle")}
                  onPress={() => void Linking.openURL(link)}
                  testID="event-sheet-open-google"
                />
              </View>
            )}

            {event.recurringEventId !== null && (
              <View style={styles.section}>
                <SectionLabel>{t("mobile.calendar.series.heading")}</SectionLabel>
                <SeriesConfig
                  // Senza questa `key`, aprire un evento della serie A e poi
                  // uno della serie B riuserebbe la stessa istanza: lo stato
                  // locale resterebbe quello di A mentre `recurringEventId`
                  // è già B, e «Salva» scriverebbe la configurazione di A
                  // (`auto: true` compreso) sulla serie B. È il bug
                  // bloccante trovato dalla review sul web
                  // (`calendar-detail-panel.tsx`, stessa `key`): non
                  // riscoprirlo qui.
                  key={`${event.accountId}-${event.recurringEventId}`}
                  accountId={event.accountId}
                  recurringEventId={event.recurringEventId}
                />
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * "Quando" leggibile. Un evento TUTTO IL GIORNO non mostra un'ora — sarebbe
 * inventata: è una DATA fissata a mezzanotte UTC, e il giorno giusto si
 * legge coi getter UTC (vedi `calendar-grid.ts` in `@stubwise/shared`).
 */
function whenLabel(event: Reader<CalendarEventItem>, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const start = new Date(event.startsAt);
  if (event.allDay) {
    const day = `${start.getUTCDate()} ${t(`mobile.calendar.months.${start.getUTCMonth()}`)}`;
    return t("mobile.calendar.sheet.allDayOn", { date: day });
  }
  const day = `${start.getDate()} ${t(`mobile.calendar.months.${start.getMonth()}`)}`;
  const from = clockTime(event.startsAt);
  if (event.endsAt === null) return `${day}, ${from}`;
  return `${day}, ${from} – ${clockTime(event.endsAt)}`;
}

/**
 * «Per partecipare»: Meet più gli altri modi. `uri` viene dall'invito, cioè
 * da chiunque, quindi passa dall'allowlist di schemi prima di diventare
 * toccabile — `javascript:` in un link è il modo classico di trasformare un
 * tap in esecuzione.
 */
function JoinBlock({
  hangoutLink,
  entryPoints,
}: {
  hangoutLink: string | null | undefined;
  entryPoints: Reader<CalendarEventItem>["conferenceEntryPoints"];
}) {
  const { t } = useTranslation();
  const meet = hangoutLink != null && isSafeJoinUrl(hangoutLink) ? hangoutLink : null;
  // Il Meet è già fra gli entry point in quasi tutti gli eventi: due volte
  // sarebbe rumore.
  const extra = (entryPoints ?? []).filter(
    (point) => isSafeJoinUrl(point.uri) && point.uri !== hangoutLink,
  );
  if (meet === null && extra.length === 0) return null;

  return (
    <View style={styles.section}>
      <SectionLabel>{t("mobile.calendar.sheet.join")}</SectionLabel>
      {meet !== null && (
        <View style={styles.openButton}>
          <GhostButton
            label={t("mobile.calendar.sheet.joinMeet")}
            onPress={() => void Linking.openURL(meet)}
            testID="event-sheet-join-meet"
          />
        </View>
      )}
      {extra.map((point) => (
        <Pressable
          key={point.uri}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(point.uri)}
          style={styles.joinRow}
          testID={`event-sheet-join-${point.type}`}
        >
          <Text style={styles.joinLabel}>{point.label ?? point.uri}</Text>
          {point.pin != null && <Text style={styles.meta}>PIN {point.pin}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * «Si ripete», o NIENTE: `parseRecurrence` tace su tutto ciò che non sa dire
 * con certezza, e una frase sbagliata su quando si ripete un appuntamento è
 * peggio di nessuna frase.
 */
function RecurrenceBlock({ recurrence }: { recurrence: Reader<CalendarEventItem>["recurrence"] }) {
  const { t } = useTranslation();
  const rule = parseRecurrence(recurrence ?? []);
  if (rule === null) return null;
  const label = formatRecurrence(rule, (key, params) =>
    key.startsWith("weekday.")
      ? t(`mobile.calendar.weekdaysLong.${key.slice("weekday.".length)}`)
      : t(`mobile.calendar.recurrence.${key}`, params),
  );
  return (
    <View style={styles.section}>
      <SectionLabel>{t("mobile.calendar.sheet.recurrence")}</SectionLabel>
      <Text style={styles.body} testID="event-sheet-recurrence">
        {label}
      </Text>
    </View>
  );
}

/**
 * I promemoria, ATTRIBUITI A GOOGLE (design §2).
 *
 * ⚠️ Stubwise non li fa scattare e la copy non deve lasciar credere il
 * contrario: la riga finale dice che è Google a farli scattare. Chi un
 * domani volesse farli scattare sta aggiungendo una funzione, non riempiendo
 * un campo.
 */
function RemindersBlock({
  reminders,
  useDefault,
}: {
  reminders: Reader<CalendarEventItem>["reminders"];
  useDefault: boolean | undefined;
}) {
  const { t } = useTranslation();
  const list = reminders ?? [];
  const usesDefault = useDefault === true;
  if (list.length === 0 && !usesDefault) return null;
  return (
    <View style={styles.section} testID="event-sheet-reminders">
      <SectionLabel>{t("mobile.calendar.sheet.reminders")}</SectionLabel>
      {list.map((reminder) => (
        <Text key={`${reminder.method}-${reminder.minutes}`} style={styles.body}>
          {t("mobile.calendar.sheet.reminderMinutes", { count: reminder.minutes })}
        </Text>
      ))}
      {usesDefault && <Text style={styles.body}>{t("mobile.calendar.sheet.remindersUseDefault")}</Text>}
      <Text style={styles.hint}>{t("mobile.calendar.sheet.remindersOnGoogle")}</Text>
    </View>
  );
}

function attendeeStatusLabel(
  status: CalendarAttendeeResponseStatus | null | ReturnType<typeof String>,
  t: (key: string) => string,
): string {
  // `null` = Google non ha mandato lo stato (o è una riga anteriore alla
  // fase 9, dove non veniva conservato); `UNKNOWN` = un valore che questa
  // build non conosce. Sono due cose diverse da "non ha risposto", e
  // nessuna delle due va travestita da un valore del vocabolario.
  if (status === null || isUnknown(status)) return t("mobile.calendar.attendeeStatus.unknown");
  return t(`mobile.calendar.attendeeStatus.${String(status)}`);
}

function SeriesConfig({ accountId, recurringEventId }: { accountId: string; recurringEventId: string }) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const seriesQuery = useCalendarSeries(accountId);
  const series = seriesQuery.data?.items.find((item) => item.recurringEventId === recurringEventId);

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("SeriesConfig richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const mutation = useSeriesMutation(accountId, recurringEventId);

  const [enabled, setEnabled] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [action, setAction] = useState<CalendarSeriesAction>("milestone");
  const [leadDays, setLeadDays] = useState(2);
  const [auto, setAuto] = useState(false);
  // La serie arrivata dalla query riempie i campi UNA VOLTA SOLA: un refetch
  // non deve sovrascrivere ciò che si sta toccando. (Il montaggio è già
  // legato alla serie dalla `key` del chiamante, quindi "una volta sola"
  // significa davvero "per questa serie".)
  const [initialized, setInitialized] = useState(false);
  if (!initialized && series !== undefined) {
    setEnabled(series.enabled);
    setProjectId(series.projectId);
    setAction(isUnknown(series.action) ? "milestone" : series.action);
    setLeadDays(series.leadDays);
    setAuto(series.auto);
    setInitialized(true);
  }

  if (seriesQuery.isPending) {
    return <Text style={styles.hint} testID="series-loading">{t("mobile.calendar.series.loading")}</Text>;
  }

  // L'unico stato che «Salva» non deve poter produrre: acceso senza progetto.
  const missingProject = enabled && projectId === null;

  return (
    <View style={styles.seriesBox} testID="series-config">
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: enabled }}
        onPress={() => setEnabled((value) => !value)}
        style={styles.toggleRow}
        testID="series-enabled"
      >
        <View style={[styles.checkbox, enabled && styles.checkboxOn]}>
          {enabled && <Text style={styles.checkmark}>×</Text>}
        </View>
        <Text style={styles.toggleLabel}>{t("mobile.calendar.series.enableLabel")}</Text>
      </Pressable>
      <Text style={styles.hint}>{t("mobile.calendar.series.offByDefaultHint")}</Text>

      <View style={styles.field}>
        <SectionLabel>{t("mobile.calendar.series.project")}</SectionLabel>
        <View style={styles.chipRow}>
          {(projectsQuery.data ?? []).map((project) => (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              accessibilityState={{ selected: projectId === project.id }}
              onPress={() => setProjectId(projectId === project.id ? null : project.id)}
              style={[styles.chip, projectId === project.id && styles.chipOn]}
              testID={`series-project-${project.id}`}
            >
              <Text style={[styles.chipLabel, projectId === project.id && styles.chipLabelOn]}>{project.name}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.field}>
        <SectionLabel>{t("mobile.calendar.series.action")}</SectionLabel>
        <View style={styles.chipRow}>
          {ACTIONS.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityState={{ selected: action === option }}
              onPress={() => setAction(option)}
              style={[styles.chip, action === option && styles.chipOn]}
              testID={`series-action-${option}`}
            >
              <Text style={[styles.chipLabel, action === option && styles.chipLabelOn]}>
                {t(`mobile.calendar.series.actionOption.${option}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.field}>
        <SectionLabel>{t("mobile.calendar.series.leadDays")}</SectionLabel>
        {/* Uno stepper, non un campo di testo: i valori validi sono 0..30 e
            un dito non deve poter comporne uno fuori range. */}
        <View style={styles.stepperRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: leadDays <= LEAD_DAYS_MIN }}
            disabled={leadDays <= LEAD_DAYS_MIN}
            onPress={() => setLeadDays((value) => Math.max(LEAD_DAYS_MIN, value - 1))}
            style={[styles.stepperButton, leadDays <= LEAD_DAYS_MIN && styles.stepperDisabled]}
            testID="series-lead-minus"
          >
            <Text style={styles.stepperLabel}>−</Text>
          </Pressable>
          <Text style={styles.stepperValue} testID="series-lead-value">
            {t("mobile.calendar.series.leadDaysValue", { count: leadDays })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: leadDays >= LEAD_DAYS_MAX }}
            disabled={leadDays >= LEAD_DAYS_MAX}
            onPress={() => setLeadDays((value) => Math.min(LEAD_DAYS_MAX, value + 1))}
            style={[styles.stepperButton, leadDays >= LEAD_DAYS_MAX && styles.stepperDisabled]}
            testID="series-lead-plus"
          >
            <Text style={styles.stepperLabel}>+</Text>
          </Pressable>
        </View>
      </View>

      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: auto }}
        onPress={() => setAuto((value) => !value)}
        style={styles.toggleRow}
        testID="series-auto"
      >
        <View style={[styles.checkbox, auto && styles.checkboxOn]}>{auto && <Text style={styles.checkmark}>×</Text>}</View>
        <Text style={styles.toggleLabel}>{t("mobile.calendar.series.autoLabel")}</Text>
      </Pressable>
      <Text style={styles.hint}>{t("mobile.calendar.series.autoHint")}</Text>

      {missingProject && (
        <Text style={styles.warning} testID="series-project-required">
          {t("mobile.calendar.series.projectRequired")}
        </Text>
      )}
      {mutation.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.warning} testID="series-error">
          {mutation.errorMessage}
        </Text>
      )}

      <View style={styles.actionsRow}>
        <View style={styles.saveButton}>
          <PrimaryButton
            label={t("mobile.calendar.series.save")}
            onPress={() => {
              // Il corpo parte INTERO: il `PUT` sostituisce la
              // configurazione, un corpo parziale azzererebbe il resto.
              // `projectId` viaggia solo se la serie è accesa — spegnendola
              // il progetto non serve più, ed è ciò che fa anche il web.
              const patch: CalendarSeriesPatch = {
                accountId,
                enabled,
                projectId: enabled ? projectId : null,
                action,
                leadDays,
                auto,
              };
              mutation.save(patch);
            }}
            disabled={mutation.disabled || missingProject}
            testID="series-save"
          />
        </View>
        {enabled && (
          <View style={styles.disableButton}>
            <GhostButton besidePrimary
              label={t("mobile.calendar.series.disable")}
              onPress={() => {
                setEnabled(false);
                mutation.disable();
              }}
              disabled={mutation.disabled}
              testID="series-disable"
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(5,7,10,0.7)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: "88%",
  },
  sheetContent: {
    padding: 20,
    paddingBottom: 32,
  },
  headerRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  title: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sansBold,
    fontSize: 17,
    fontWeight: "700",
  },
  close: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    paddingTop: 2,
  },
  when: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
  meta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  section: {
    marginTop: 22,
  },
  attendeeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginTop: 8,
  },
  attendeeEmail: {
    color: colors.muted,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  attendeeStatus: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  yourResponse: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 14,
    marginTop: 6,
  },
  yourResponseDeclined: {
    color: colors.danger,
  },
  openButton: {
    alignSelf: "flex-start",
    marginTop: 18,
  },
  body: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  joinRow: {
    justifyContent: "center",
    marginTop: 10,
    minHeight: 44,
  },
  joinLabel: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  seriesBox: {
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 10,
    padding: 14,
  },
  toggleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    minHeight: 44,
  },
  checkbox: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: 4,
    borderWidth: 1,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  checkboxOn: {
    backgroundColor: colors.signal,
    borderColor: colors.signal,
  },
  checkmark: {
    color: colors.ink950,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    lineHeight: 15,
  },
  toggleLabel: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  hint: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  field: {
    marginTop: 18,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  chip: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  chipOn: {
    borderColor: colors.signal,
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  chipLabelOn: {
    color: colors.signal,
  },
  stepperRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  stepperButton: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 44,
  },
  stepperDisabled: {
    opacity: 0.3,
  },
  stepperLabel: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 16,
  },
  stepperValue: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  warning: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 12,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
  },
  saveButton: {
    flex: 1,
  },
  disableButton: {
    flex: 1,
  },
});
