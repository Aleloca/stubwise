import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { BacklogListCard } from "../../components/backlog/BacklogListCard";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { navigateToTicketWork, useBacklogList, useConvertBacklogItem, type BacklogChip } from "../../lib/backlog-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.list.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

const CHIPS: { chip: BacklogChip; i18nKey: string }[] = [
  { chip: "active", i18nKey: "mobile.backlog.chips.active" },
  { chip: "ready", i18nKey: "mobile.backlog.chips.ready" },
  { chip: "all", i18nKey: "mobile.backlog.chips.all" },
];

/**
 * IL BACKLOG DI UN PROGETTO (22 set 2026, hub di progetto, design §5).
 *
 * ⚠️ **La lista non è riscritta**: monta `BacklogListCard`, lo STESSO
 * componente del tab BLG — estratto da `BacklogScreen.tsx` per questo lavoro
 * proprio per non averne due copie che divergono. E il filtro per progetto
 * non è nuovo: `useBacklogList(chip, projectId)` lo accetta da sempre, la
 * chiave di query lo include, e il server lo espone.
 *
 * Il dettaglio di una voce è la STESSA `BacklogItemScreen` del tab BLG,
 * registrata anche nello stack `Projects` (22 set 2026): aprirla non esce da
 * qui, quindi l'indietro riporta a questo elenco — con il progetto ancora
 * addosso — e non alla lista generale del backlog.
 *
 * Quello che questa schermata NON ha, rispetto al tab: la cattura rapida
 * («+»), che chiede un progetto ed è quindi una domanda già risposta qui —
 * ma che vive nel tab, dove la si fa oggi. Aggiungerla sarebbe un'altra
 * decisione, non un pezzo mancante di questa.
 *
 * Il nome del progetto NON si passa alle card: è lo stesso per tutte, e sta
 * già nel sottotitolo dell'intestazione. Ripeterlo su ogni riga occuperebbe
 * la riga d'identità della card con l'unica informazione che qui è scontata.
 */
export function ProjectBacklogScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProjectsStackParamList, "ProjectBacklog">) {
  const { t } = useTranslation();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;
  const [chip, setChip] = useState<BacklogChip>("active");

  const query = useBacklogList(chip, projectId);
  const convert = useConvertBacklogItem();
  const items = query.data ?? [];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.list, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.backlog.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        <View style={styles.chipsRow}>
          {CHIPS.map((option) => {
            const active = chip === option.chip;
            return (
              <Pressable
                key={option.chip}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setChip(option.chip)}
                style={[styles.chip, active && styles.chipActive]}
                testID={`project-backlog-chip-${option.chip}`}
              >
                <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{t(option.i18nKey)}</Text>
              </Pressable>
            );
          })}
        </View>

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-backlog-skeleton">
            <Skeleton height={90} />
            <Skeleton height={90} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-backlog-error">
            <Text style={styles.errorTitle}>{t("mobile.backlog.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.backlog.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-backlog-retry"
            />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centered} testID="project-backlog-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.backlog.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.backlog.empty.body")}</Text>
          </View>
        ) : (
          <View style={styles.cards}>
            {items.map((item) => (
              <BacklogListCard
                key={item.id}
                item={item}
                proceedPending={convert.isPending}
                // La conversione porta al LAVORO del ticket appena creato,
                // come nel tab: `navigateToTicketWork` sale al root stack e
                // scende su `Projects/Ticket` — da qui è lo stesso stack in
                // cui siamo, e l'azione resta quella.
                onProceed={() =>
                  convert.mutate(item.id, { onSuccess: (result) => navigateToTicketWork(navigation, result.ticketId) })
                }
                // DENTRO lo stack `Projects`, non verso il tab BLG: è la
                // stessa `BacklogItemScreen`, registrata anche qui (22 set
                // 2026), quindi l'indietro riporta a QUESTO elenco e la
                // scheda in basso non si muove.
                onOpenDetail={() => navigation.navigate("Item", { id: item.id })}
              />
            ))}
          </View>
        )}

        {convert.errorMessage !== null && (
          <Text accessibilityLiveRegion="polite" style={styles.convertError} testID="project-backlog-convert-error">
            {convert.errorMessage}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  list: {
    gap: 12,
    padding: 16,
    paddingBottom: 40,
  },
  cards: {
    gap: 10,
  },
  chipsRow: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    borderColor: colors.lineStrong,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: {
    borderColor: colors.signalDim,
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  chipLabelActive: {
    color: colors.signal,
  },
  skeletonList: {
    gap: 8,
  },
  centered: {
    alignItems: "center",
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  convertError: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
});
