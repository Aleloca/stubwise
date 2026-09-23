import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ProjectRowsCard, type ProjectGroupRowProps } from "../../components/projects/ProjectRowsCard";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { projectKeys } from "../../lib/query-keys";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.list.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * I REPOSITORY DI UN PROGETTO (22 set 2026, hub di progetto, tappa 2).
 *
 * L'elenco non costa una richiesta sua: la proiezione sintetica (`id`,
 * `name`, `slug`, `provider`) arriva già dentro `projects.get`, che è la
 * stessa query della sezione dell'hub — quindi entrando qui dalla sezione i
 * dati ci sono già.
 *
 * **Sola lettura**: si legge di cosa è fatto il progetto, non lo si
 * configura. Aggiungere un repository o cambiarne le credenziali resta sul
 * web (design §8).
 */
export function ProjectRepositoriesScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProjectsStackParamList, "ProjectRepositories">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  const query = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectRepositoriesScreen richiede un client autenticato");
      return client.projects.get(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const repositories = query.data?.repositories ?? [];
  const rows: ProjectGroupRowProps[] = repositories.map((repository) => ({
    rowKey: repository.id,
    title: repository.name,
    trailing: repository.slug,
    trailingTone: "muted",
    onPress: () => navigation.navigate("Repository", { slug: repository.slug, projectName }),
    testID: `project-repository-${repository.id}`,
  }));

  const refreshControl = usePullToRefresh([projectKeys.detail(projectId)], "project-repositories-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.list, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.repositories.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-repositories-skeleton">
            <Skeleton height={60} />
            <Skeleton height={60} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-repositories-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.repositories.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.repositories.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-repositories-retry"
            />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.centered} testID="project-repositories-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.repositories.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.repositories.empty.body")}</Text>
          </View>
        ) : (
          <ProjectRowsCard rows={rows} />
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
});
