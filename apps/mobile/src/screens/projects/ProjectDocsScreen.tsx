import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DocSpace, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { DocSpaceBrowser } from "../../components/docs/DocSpaceBrowser";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys } from "../../lib/docs-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * LA DOCUMENTAZIONE DI UN PROGETTO (22 set 2026, hub di progetto, tappa 2):
 * gli spazi documentali — uno per repository documentato — e, dentro
 * ognuno, i suoi gruppi di pagine.
 *
 * ⚠️ **Tutti gli spazi, non solo il principale.** Il tab DOC ne sceglie UNO
 * (`mainDocSpace`, quello con più pagine) perché ha un solo switcher, di
 * progetto; qui la domanda è «di cosa è fatto QUESTO progetto», e un
 * progetto con tre repository documentati ne ha tre — nasconderne due
 * risponderebbe a un'altra domanda.
 *
 * ⚠️ **La chat «Chiedi al progetto» resta nel tab DOC**: è una
 * conversazione, non un pezzo di anagrafica, e questa tappa non la sposta.
 *
 * L'albero di uno spazio si carica SOLO quando lo si apre: sono N richieste
 * potenziali, una per repository, e chiederle tutte all'ingresso per
 * mostrarne una sarebbe il conto che l'hub evita altrove.
 */
export function ProjectDocsScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "ProjectDocs">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;
  const [openSpaceId, setOpenSpaceId] = useState<string | null>(null);

  // STESSA chiave della sezione dell'hub (`docsKeys.spaces`): entrando da lì
  // gli spazi sono già in cache, e non c'è una seconda richiesta.
  const query = useQuery({
    queryKey: docsKeys.spaces(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectDocsScreen richiede un client autenticato");
      return client.docs.projectSpaces(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const spaces = query.data ?? [];

  const refreshControl = usePullToRefresh([docsKeys.all], "project-docs-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.docs.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-docs-skeleton">
            <Skeleton height={60} />
            <Skeleton height={60} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-docs-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.docs.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.docs.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-docs-retry"
            />
          </View>
        ) : spaces.length === 0 ? (
          <View style={styles.centered} testID="project-docs-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.docs.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.docs.empty.body")}</Text>
          </View>
        ) : (
          spaces.map((space) => (
            <SpaceBlock
              key={space.repositoryId}
              space={space}
              open={openSpaceId === space.repositoryId}
              onToggle={() =>
                setOpenSpaceId((current) => (current === space.repositoryId ? null : space.repositoryId))
              }
              onOpenPage={(slug) => navigation.navigate("Page", { repositoryId: space.repositoryId, slug })}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

/**
 * UNO spazio: la riga col nome del repository e il numero di pagine, e — se
 * aperto — i suoi gruppi. L'albero si chiede solo da aperto (`enabled`).
 */
function SpaceBlock({
  space,
  open,
  onToggle,
  onOpenPage,
}: {
  space: Reader<DocSpace>;
  open: boolean;
  onToggle: () => void;
  onOpenPage: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const treeQuery = useQuery({
    queryKey: docsKeys.tree(space.repositoryId),
    queryFn: () => {
      if (!client) throw new Error("ProjectDocsScreen richiede un client autenticato");
      return client.docs.tree(space.repositoryId);
    },
    enabled: open && client !== null,
    staleTime: 60_000,
  });

  return (
    <View style={styles.spaceBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.spaceRow}
        testID={`project-docs-space-${space.repositoryId}`}
      >
        <Text style={styles.spaceName} numberOfLines={1}>
          {space.name}
        </Text>
        <Text style={styles.spaceMeta}>{t("mobile.docs.browse.pageCount", { count: space.pageCount })} ›</Text>
      </Pressable>
      {open &&
        (treeQuery.isPending ? (
          <View style={styles.spaceLoading} testID={`project-docs-tree-loading-${space.repositoryId}`}>
            <Skeleton height={44} />
          </View>
        ) : treeQuery.isError ? (
          <Text style={styles.spaceError} testID={`project-docs-tree-error-${space.repositoryId}`}>
            {t("mobile.projects.docs.treeError")}
          </Text>
        ) : (
          <DocSpaceBrowser
            nodes={treeQuery.data ?? []}
            onOpenPage={onOpenPage}
            testIDPrefix={`project-docs-browse-${space.repositoryId}`}
          />
        ))}
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
  spaceBlock: {
    gap: 8,
  },
  spaceRow: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  spaceName: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  spaceMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  spaceLoading: {
    paddingHorizontal: 4,
  },
  spaceError: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    paddingHorizontal: 4,
  },
});
