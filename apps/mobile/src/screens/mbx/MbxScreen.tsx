import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MailThreadItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { MbxStackParamList } from "../../app/navigation";
import { CalendarPanel } from "../../components/mbx/CalendarPanel";
import { GhostButton } from "../../components/GhostButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { relativeTimeCompact } from "../../lib/format";
import { useMailRejections, useMailThreads } from "../../lib/mail-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { mailKeys } from "../../lib/query-keys";
import { calendarKeys } from "../../lib/calendar-mutations";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.content.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

type MbxTab = "mail" | "calendar";

const TABS: { tab: MbxTab; i18nKey: string }[] = [
  { tab: "mail", i18nKey: "mobile.mbx.tabs.mail" },
  { tab: "calendar", i18nKey: "mobile.mbx.tabs.calendar" },
];

/**
 * Scheda **MBX** (App M3, Fase C, Task 7-8 — architettura di navigazione
 * §3/§6a): la quinta destinazione, per ciò che arriva dalla CASELLA e non
 * appartiene a un progetto. Posta e Calendario condividono lo stesso
 * schermo con uno scambio in alto, non due schede — sono la stessa origine
 * vista da due lati (§3 "Perché Posta e Calendario stanno insieme").
 *
 * Il Calendario (Fase D, Task 11) è una griglia MENSILE coi puntini sui
 * giorni pieni e il giorno scelto sotto — `CalendarPanel`, che porta con sé
 * anche i bordi della finestra di ingestione e lo stato vuoto che si spiega.
 *
 * Con un `day` nei params (un deep link di calendario) questo screen nasce
 * sul CALENDARIO e su quel giorno, non sulla Posta: è la regola 2
 * dell'architettura — da una notifica si arriva all'oggetto — applicata a una
 * scheda che di oggetti ne mostra due tipi.
 *
 * La lista Posta è corta PER COSTRUZIONE (33 messaggi su quattro caselle in
 * produzione, al momento in cui questo screen è stato scritto — solo la
 * posta AMMESSA entra): disegnata per venti righe in un unico `ScrollView`,
 * come `BacklogScreen`/`ProjectsScreen`, non per una lista virtualizzata da
 * client di posta.
 */
export function MbxScreen({ navigation, route }: NativeStackScreenProps<MbxStackParamList, "List">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  // Un deep link di calendario (`stubwise://calendar/:day[/:eventId]`) porta
  // un giorno nei params: allora si nasce sul Calendario, non sulla Posta —
  // altrimenti chi tocca la notifica di un appuntamento si troverebbe davanti
  // la lista della posta, e dovrebbe capire da sé di dover cambiare scheda.
  const [tab, setTab] = useState<MbxTab>(route.params?.day !== undefined ? "calendar" : "mail");
  // `source: "email"` — qui il Calendario ha già la sua vista, lo scambio in
  // alto: un appuntamento nella lista della POSTA era contenuto duplicato, e
  // per di più impaginato male. La lista è ordinata per data decrescente, ma
  // «data» vuol dire l'ARRIVO per un'email (sempre nel passato) e l'INIZIO
  // per un appuntamento (quasi sempre nel futuro): i 25 appuntamenti dei due
  // mesi a venire finivano quindi SOPRA ogni messaggio, e chi apriva MBX si
  // trovava davanti venticinque righe di calendario che non si aprono (il
  // calendario non ha un dettaglio, vedi `mailDetailSourceFor`) prima della
  // prima email.
  // La posta si legge per CONVERSAZIONE (§4): una riga per thread, non per
  // messaggio. Il filtro `source=email` non serve più — questa rotta è già
  // solo posta, e il calendario ha la sua scheda qui accanto.
  const query = useMailThreads();
  // Lettura ACCESSORIA (25 set 2026): fuori dai gate della lista, così un suo
  // guasto — un server che la rotta non ce l'ha, per esempio — non costa la
  // Posta. Vedi `RejectionsRow`.
  const rejections = useMailRejections();

  const refreshControl = usePullToRefresh([mailKeys.all, calendarKeys.all], "mbx-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.content, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader title={t("mobile.mbx.title")} />

        <View style={styles.switchRow} testID="mbx-switch">
          {TABS.map((option) => {
            const active = tab === option.tab;
            return (
              <Pressable
                key={option.tab}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setTab(option.tab)}
                style={[styles.switchOption, active && styles.switchOptionActive]}
                testID={`mbx-tab-${option.tab}`}
              >
                <Text style={[styles.switchLabel, active && styles.switchLabelActive]}>{t(option.i18nKey)}</Text>
              </Pressable>
            );
          })}
        </View>

        {tab === "calendar" ? (
          <CalendarPanel
            {...(route.params?.day !== undefined ? { initialDay: route.params.day } : {})}
            {...(route.params?.eventId !== undefined ? { focusEventId: route.params.eventId } : {})}
          />
        ) : query.isPending ? (
          <View style={styles.skeletonList} testID="mbx-mail-skeleton">
            <Skeleton height={72} />
            <Skeleton height={72} />
            <Skeleton height={72} />
          </View>
        ) : query.isError ? (
          <View style={styles.emptyState} testID="mbx-mail-error">
            <Text style={styles.emptyTitle}>{t("mobile.mbx.list.loadError.title")}</Text>
            <View style={styles.retryButton}>
              <GhostButton label={t("mobile.mbx.list.loadError.retry")} onPress={() => void query.refetch()} testID="mbx-mail-retry" />
            </View>
          </View>
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <View style={styles.emptyState} testID="mbx-mail-empty">
            <Text style={styles.emptyTitle}>{t("mobile.mbx.thread.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.mbx.thread.empty.body")}</Text>
          </View>
        ) : (
          <View style={styles.list} testID="mbx-mail-list">
            {query.data!.items.map((thread) => (
              <ThreadRow
                key={`${thread.accountId}-${thread.threadId}`}
                thread={thread}
                onPress={() => navigation.navigate("ThreadDetail", { threadId: thread.threadId })}
              />
            ))}
          </View>
        )}

        {tab === "mail" && (rejections.data?.total ?? 0) > 0 && (
          <RejectionsRow
            total={rejections.data!.total}
            days={rejections.data!.days}
            onPress={() => navigation.navigate("MailRejections")}
          />
        )}
      </ScrollView>
    </View>
  );
}

/**
 * LE MAIL TENUTE FUORI (25 set 2026, design §5): una riga in fondo alla Posta
 * che dice quante email il cancello ha scartato e porta ai motivi.
 *
 * Compare anche con la lista VUOTA, ed è proprio lì che serve: «non vedo
 * posta — è stata tenuta fuori?». Non compare quando non c'è niente da dire
 * (totale zero) né quando la lettura non riesce: è un'informazione in più,
 * non una parte della Posta, e un suo guasto non deve farsi vedere.
 */
function RejectionsRow({ total, days, onPress }: { total: number; days: number; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.rejectionsRow} testID="mbx-rejections-row">
      <Text style={styles.rejectionsText}>{t("mobile.mbx.rejections.row", { count: total, days })}</Text>
      <Text style={styles.rejectionsChevron}>›</Text>
    </Pressable>
  );
}

/**
 * UNA conversazione nella lista (§4): ultimo mittente, oggetto, quando, e —
 * quando ce ne sono — quanti messaggi contiene e quante proposte aspettano
 * una decisione.
 *
 * «Riproponi» non c'è più su questa riga: era un'azione su UN messaggio, e
 * una conversazione ne ha molti. Resta dove ha senso, sulla card in inbox e
 * sulla pagina Posta del sito.
 */
function ThreadRow({ thread, onPress }: { thread: Reader<MailThreadItem>; onPress: () => void }) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(thread.lastReceivedAt);
  const timeText =
    relative.kind === "now"
      ? t("mobile.mbx.time.now")
      : t(`mobile.mbx.time.${relative.kind}`, { count: relative.count });

  return (
    <Pressable onPress={onPress} style={styles.row} testID={`mbx-thread-row-${thread.threadId}`}>
      <View style={styles.rowTop}>
        <Text style={styles.rowFrom} numberOfLines={1}>
          {thread.lastFrom}
        </Text>
        <Text style={styles.rowTime}>{timeText}</Text>
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {thread.subject ?? t("mobile.mbx.list.noSubject")}
      </Text>
      <View style={styles.rowBottom}>
        {thread.messageCount > 1 && (
          <Text style={styles.rowMeta}>{t("mobile.mbx.thread.messages", { count: thread.messageCount })}</Text>
        )}
        {thread.openProposals > 0 && (
          <PulseIndicator
            tone="signal"
            text={t("mobile.mbx.thread.open", { count: thread.openProposals })}
          />
        )}
        {thread.projectNames.map((name) => (
          <Text key={name} style={styles.rowProject} numberOfLines={1}>
            {name}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  content: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  switchRow: {
    flexDirection: "row",
    gap: 8,
  },
  switchOption: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 8,
  },
  switchOptionActive: {
    borderColor: colors.signalDim,
  },
  switchLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textAlign: "center",
    textTransform: "uppercase",
  },
  switchLabelActive: {
    color: colors.signal,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  emptyTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 16,
  },
  skeletonList: {
    gap: 8,
  },
  list: {
    gap: 8,
  },
  row: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  rowTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  rowFrom: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  rowTime: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  rowTitle: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  rowBottom: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  rowMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  rejectionsRow: {
    alignItems: "center",
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rejectionsText: {
    color: colors.muted,
    flexShrink: 1,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  rejectionsChevron: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 16,
  },
  rowProject: {
    color: colors.faint,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
