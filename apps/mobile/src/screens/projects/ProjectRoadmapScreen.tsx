import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { MilestoneWithCounts, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { shortDate } from "../../lib/format";
import { milestoneKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * LA ROADMAP DI UN PROGETTO (22 set 2026, hub di progetto, tappa 2): le
 * milestone con la loro scadenza e il loro avanzamento.
 *
 * L'ordine è quello del SERVER (aperte prima, poi per scadenza, senza
 * scadenza in fondo, poi per nome) e non si riordina qui: è parte del
 * significato della risposta, non una comodità.
 *
 * I conteggi arrivano già calcolati (`counts`) e non si ricalcolano dai
 * ticket: sarebbero una seconda verità, e quella sbagliata starebbe
 * nell'app — dalla parte che si aggiorna dagli store.
 *
 * **Sola lettura**: creare o chiudere una milestone resta sul web. Una
 * milestone la si guarda per sapere dove si è, non la si amministra dal
 * telefono.
 */
export function ProjectRoadmapScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProjectsStackParamList, "ProjectRoadmap">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  const query = useQuery({
    queryKey: milestoneKeys.forProject(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectRoadmapScreen richiede un client autenticato");
      return client.projects.milestones(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const milestones = query.data ?? [];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.roadmap.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-roadmap-skeleton">
            <Skeleton height={70} />
            <Skeleton height={70} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-roadmap-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.roadmap.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.roadmap.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-roadmap-retry"
            />
          </View>
        ) : milestones.length === 0 ? (
          <View style={styles.centered} testID="project-roadmap-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.roadmap.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.roadmap.empty.body")}</Text>
          </View>
        ) : (
          milestones.map((milestone) => <MilestoneCard key={milestone.id} milestone={milestone} />)
        )}
      </ScrollView>
    </View>
  );
}

function MilestoneCard({ milestone }: { milestone: Reader<MilestoneWithCounts> }) {
  const { t } = useTranslation();
  const closed = !isUnknown(milestone.status) && milestone.status === "closed";

  return (
    <View style={styles.card} testID={`milestone-card-${milestone.id}`}>
      <View style={styles.cardTop}>
        <Text style={styles.cardName} numberOfLines={2}>
          {milestone.name}
        </Text>
        <Text style={[styles.cardStatus, closed && styles.cardStatusClosed]}>
          {closed ? t("mobile.projects.roadmap.status.closed") : t("mobile.projects.roadmap.status.open")}
        </Text>
      </View>
      {/*
        ⚠️ Una milestone può non avere scadenza (`dueDate` nullable):
        l'assenza si mostra COME assenza. Mai «scaduta» — che sarebbe falso —
        né una data inventata.
      */}
      <Text style={styles.cardDue} testID={`milestone-due-${milestone.id}`}>
        {milestone.dueDate === null
          ? t("mobile.projects.roadmap.noDueDate")
          : t("mobile.projects.roadmap.dueDate", { date: shortDate(milestone.dueDate) })}
      </Text>
      <Text style={styles.cardProgress} testID={`milestone-progress-${milestone.id}`}>
        {t("mobile.projects.roadmap.progress", {
          completed: milestone.counts.completed,
          total: milestone.counts.total,
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 10,
    padding: 16,
    paddingBottom: 40,
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
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  cardTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  cardName: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  cardStatus: {
    color: colors.signal,
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardStatusClosed: {
    color: colors.faint,
  },
  cardDue: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    marginTop: 6,
  },
  cardProgress: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    marginTop: 4,
  },
});
