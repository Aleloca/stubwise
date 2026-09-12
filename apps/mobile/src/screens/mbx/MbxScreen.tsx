import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { MailItem, Reader } from "@stubwise/shared";
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
import {
  mailDetailSourceFor,
  mailReproposeSourceFor,
  mailStatusLabelKey,
  mailStatusTone,
  useMailList,
  useRepropose,
} from "../../lib/mail-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

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
 * La lista Posta è corta PER COSTRUZIONE (33 messaggi su quattro caselle in
 * produzione, al momento in cui questo screen è stato scritto — solo la
 * posta AMMESSA entra): disegnata per venti righe in un unico `ScrollView`,
 * come `BacklogScreen`/`ProjectsScreen`, non per una lista virtualizzata da
 * client di posta.
 */
export function MbxScreen({ navigation }: NativeStackScreenProps<MbxStackParamList, "List">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const [tab, setTab] = useState<MbxTab>("mail");
  const query = useMailList();

  return (
    <View style={styles.container}>
      <ScrollView
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
          <CalendarPanel />
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
            <Text style={styles.emptyTitle}>{t("mobile.mbx.list.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.mbx.list.empty.body")}</Text>
          </View>
        ) : (
          <View style={styles.list} testID="mbx-mail-list">
            {query.data!.items.map((item) => (
              <MailRow
                key={item.id}
                item={item}
                onPress={() => {
                  const source = mailDetailSourceFor(item);
                  if (source !== null) navigation.navigate("MailDetail", { source, id: item.id });
                }}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function MailRow({ item, onPress }: { item: Reader<MailItem>; onPress: () => void }) {
  const { t } = useTranslation();
  const repropose = useRepropose(mailReproposeSourceFor(item) ?? "email", item.id);
  const relative = relativeTimeCompact(item.date);
  const timeText = relative.kind === "now" ? t("mobile.mbx.time.now") : t(`mobile.mbx.time.${relative.kind}`, { count: relative.count });
  const openable = mailDetailSourceFor(item) !== null;
  const reproposeSource = mailReproposeSourceFor(item);

  const content = (
    <>
      <View style={styles.rowTop}>
        <Text style={styles.rowFrom} numberOfLines={1}>
          {item.from ?? item.accountEmail}
        </Text>
        <Text style={styles.rowTime}>{timeText}</Text>
      </View>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {item.title ?? t("mobile.mbx.list.noSubject")}
      </Text>
      <View style={styles.rowBottom}>
        <PulseIndicator tone={mailStatusTone(item.status)} text={t(mailStatusLabelKey(item.status))} />
        {item.projectName !== null && (
          <Text style={styles.rowProject} numberOfLines={1}>
            {item.projectName}
          </Text>
        )}
      </View>
      {item.reproposable && reproposeSource !== null && (
        <View style={styles.reproposeRow}>
          <GhostButton
            label={t("mobile.mbx.list.repropose")}
            onPress={repropose.mutate}
            disabled={repropose.disabled}
            testID={`mbx-mail-repropose-${item.id}`}
          />
          {repropose.errorMessage !== null && <Text style={styles.reproposeError}>{repropose.errorMessage}</Text>}
        </View>
      )}
    </>
  );

  if (!openable) {
    return (
      <View style={styles.row} testID={`mbx-mail-row-${item.id}`}>
        {content}
      </View>
    );
  }

  return (
    <Pressable onPress={onPress} style={styles.row} testID={`mbx-mail-row-${item.id}`}>
      {content}
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
  rowProject: {
    color: colors.faint,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  reproposeRow: {
    alignItems: "flex-start",
    marginTop: 6,
  },
  reproposeError: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    marginTop: 4,
  },
});
