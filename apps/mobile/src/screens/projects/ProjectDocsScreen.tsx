import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown, type DocSpace, type ProjectHighlights, type Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys } from "../../lib/docs-mutations";
import { mainDocSpace } from "../../lib/docs-structure";
import { shortDate } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;
/** Il debounce del campo di ricerca, come la ricerca globale. */
const SEARCH_DEBOUNCE_MS = 300;

type Props = NativeStackScreenProps<ProjectsStackParamList, "ProjectDocs">;

/**
 * LA DOCUMENTAZIONE DI UN PROGETTO, come la home Docs di progetto del web
 * («la documentazione nell'app, come sul web», 25 set 2026, design §3).
 * Dall'alto: la ricerca del progetto, «Ask this project», «Start here», i
 * repository e le novità. Le decisioni non ci sono: nell'app hanno già la
 * loro sezione nell'hub del progetto.
 *
 * Gli spazi (`docs.projectSpaces`) sono l'unica lettura che regge la pagina.
 * Gli highlights di progetto e il brief del repository principale sono
 * ACCESSORI, fuori dai gate: se falliscono la loro parte sparisce e il resto
 * resta.
 *
 * Il repository «principale» è quello con più pagine (`mainDocSpace`), la
 * stessa euristica del web: da lui vengono il brief e la panoramica di «Start
 * here».
 *
 * «Ask this project» sta in testa, fuori dai gate: c'è anche mentre carica,
 * in errore o senza documentazione (la chat viveva nel tab DOC, uscito con
 * Wisey).
 */
export function ProjectDocsScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  // STESSA chiave della sezione dell'hub (`docsKeys.spaces`): entrando da lì
  // gli spazi sono già in cache.
  const spacesQuery = useQuery({
    queryKey: docsKeys.spaces(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectDocsScreen richiede un client autenticato");
      return client.docs.projectSpaces(projectId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });
  const spaces = spacesQuery.data ?? [];

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const openPage = (repositoryId: string, slug: string) => navigation.navigate("Page", { repositoryId, slug });
  const openRepo = (space: Reader<DocSpace>) =>
    navigation.navigate("RepoDocs", { repositoryId: space.repositoryId, repositoryName: space.name });

  const refreshControl = usePullToRefresh([docsKeys.all], "project-docs-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          title={t("mobile.projects.docs.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        <TextInput
          accessibilityLabel={t("mobile.projects.docs.searchPlaceholder")}
          value={draft}
          onChangeText={setDraft}
          placeholder={t("mobile.projects.docs.searchPlaceholder")}
          placeholderTextColor={colors.faint}
          style={styles.search}
          testID="project-docs-search-input"
        />

        {query.length > 0 ? (
          <ProjectSearchResults projectId={projectId} query={query} onOpenPage={openPage} />
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("Ask", { projectId, projectName })}
              style={styles.askEntry}
              testID="project-docs-ask"
            >
              <Text style={styles.askLabel}>{t("mobile.projects.docs.ask")}</Text>
            </Pressable>

            {spacesQuery.isPending ? (
              <View style={styles.list} testID="project-docs-skeleton">
                <Skeleton height={60} />
                <Skeleton height={60} />
              </View>
            ) : spacesQuery.isError ? (
              <View style={styles.centered} testID="project-docs-error">
                <Text style={styles.stateTitle}>{t("mobile.projects.docs.loadError.title")}</Text>
                <GhostButton
                  label={t("mobile.projects.docs.loadError.retry")}
                  onPress={() => void spacesQuery.refetch()}
                  testID="project-docs-retry"
                />
              </View>
            ) : spaces.length === 0 ? (
              <View style={styles.centered} testID="project-docs-empty">
                <Text style={styles.stateTitle}>{t("mobile.projects.docs.empty.title")}</Text>
                <Text style={styles.muted}>{t("mobile.projects.docs.empty.body")}</Text>
              </View>
            ) : (
              <ProjectDocsHome
                projectId={projectId}
                spaces={spaces}
                onOpenPage={openPage}
                onOpenRepo={openRepo}
                onOpenBrief={(space) =>
                  navigation.navigate("RepoBrief", { repositoryId: space.repositoryId, repositoryName: space.name })
                }
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ProjectDocsHome({
  projectId,
  spaces,
  onOpenPage,
  onOpenRepo,
  onOpenBrief,
}: {
  projectId: string;
  spaces: readonly Reader<DocSpace>[];
  onOpenPage: (repositoryId: string, slug: string) => void;
  onOpenRepo: (space: Reader<DocSpace>) => void;
  onOpenBrief: (space: Reader<DocSpace>) => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const main = mainDocSpace(spaces)!;

  // ACCESSORI: fuori dai gate, un loro guasto toglie solo la loro parte.
  const highlights = useQuery({
    queryKey: docsKeys.projectHighlights(projectId),
    queryFn: () => client!.docs.projectHighlights(projectId),
    enabled: client !== null,
    staleTime: 60_000,
  });
  const brief = useQuery({
    queryKey: docsKeys.brief(main.repositoryId),
    queryFn: () => client!.docs.brief(main.repositoryId),
    enabled: client !== null,
    staleTime: 5 * 60_000,
  });

  const news: Reader<ProjectHighlights> | undefined = highlights.data;
  const latestRelease = news?.latestReleases[0];
  const hasNews = news !== undefined && news.latestReleases.length + news.topViewed.length > 0;

  return (
    <View style={styles.list}>
      <View style={styles.section}>
        <SectionLabel>{t("mobile.projects.docs.startHere")}</SectionLabel>
        {brief.data && (
          <Pressable accessibilityRole="button" onPress={() => onOpenBrief(main)} style={styles.card} testID="project-docs-start-brief">
            <Text style={styles.identity}>{brief.data.brief.identity}</Text>
            <Text style={styles.link}>{t("mobile.projects.docs.briefLink")}</Text>
          </Pressable>
        )}
        <Row
          title={t("mobile.projects.docs.overviewLink", { name: main.name })}
          meta={t("mobile.docs.browse.pageCount", { count: main.pageCount })}
          onPress={() => onOpenRepo(main)}
          testID="project-docs-start-overview"
        />
        {latestRelease && (
          <Row
            title={latestRelease.title}
            meta={`${t("mobile.projects.docs.latestRelease")} · ${latestRelease.repositoryName} · ${shortDate(latestRelease.createdAt)}`}
            onPress={() => onOpenPage(latestRelease.repositoryId, latestRelease.slug)}
            testID="project-docs-start-release"
          />
        )}
      </View>

      <View style={styles.section}>
        <SectionLabel>{t("mobile.projects.docs.repositories")}</SectionLabel>
        {spaces.map((space) => {
          const release = news?.latestReleases.find((entry) => entry.repositoryId === space.repositoryId);
          const extra = release
            ? t("mobile.projects.docs.releaseMeta", { title: release.title })
            : space.lastGenerationAt
              ? t("mobile.projects.docs.generatedAt", { date: shortDate(space.lastGenerationAt) })
              : null;
          return (
            <Row
              key={space.repositoryId}
              title={space.name}
              meta={[t("mobile.docs.browse.pageCount", { count: space.pageCount }), extra].filter(Boolean).join(" · ")}
              onPress={() => onOpenRepo(space)}
              testID={`project-docs-repo-${space.repositoryId}`}
            />
          );
        })}
      </View>

      {hasNews && (
        <View style={styles.section} testID="project-docs-whats-new">
          <SectionLabel>{t("mobile.projects.docs.whatsNew")}</SectionLabel>
          {news.latestReleases.map((entry) => (
            <Row
              key={`r-${entry.repositoryId}-${entry.slug}`}
              title={entry.title}
              meta={`${entry.repositoryName} · ${shortDate(entry.createdAt)}`}
              onPress={() => onOpenPage(entry.repositoryId, entry.slug)}
              testID={`project-docs-new-release-${entry.slug}`}
            />
          ))}
          {news.topViewed.map((entry) => (
            <Row
              key={`v-${entry.repositoryId}-${entry.slug}`}
              title={entry.title}
              meta={`${entry.repositoryName} · ${t("mobile.projects.docs.topViewed")}`}
              onPress={() => onOpenPage(entry.repositoryId, entry.slug)}
              testID={`project-docs-new-viewed-${entry.slug}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * La ricerca IBRIDA nella documentazione del progetto (`docs.projectSearch`,
 * lo stesso retrieval della chat): ogni risultato dice da quale repository e
 * da quale categoria viene.
 */
function ProjectSearchResults({
  projectId,
  query,
  onOpenPage,
}: {
  projectId: string;
  query: string;
  onOpenPage: (repositoryId: string, slug: string) => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const search = useQuery({
    queryKey: docsKeys.projectSearch(projectId, query),
    queryFn: () => client!.docs.projectSearch(projectId, query),
    enabled: client !== null,
  });

  if (search.isPending) {
    return (
      <View style={styles.list} testID="project-docs-search-loading">
        <Skeleton height={56} />
        <Skeleton height={56} />
      </View>
    );
  }
  if (search.isError) return <Text style={styles.muted}>{t("mobile.projects.docs.searchError")}</Text>;
  if (search.data.length === 0) return <Text style={styles.muted}>{t("mobile.projects.docs.searchEmpty")}</Text>;

  return (
    <View style={styles.list} testID="project-docs-search-results">
      {search.data.map((hit) => (
        <Pressable
          key={`${hit.repositoryId}:${hit.slug}`}
          accessibilityRole="button"
          onPress={() => onOpenPage(hit.repositoryId, hit.slug)}
          style={styles.row}
          testID={`project-docs-hit-${hit.slug}`}
        >
          <Text style={styles.rowTitle}>{hit.title}</Text>
          <Text style={styles.rowMeta}>
            {isUnknown(hit.kind) ? hit.repositoryName : `${hit.repositoryName} · ${t(`mobile.docs.repo.tabs.${hit.kind}`)}`}
          </Text>
          {hit.snippet.length > 0 && (
            <Text style={styles.snippet} numberOfLines={2}>
              {hit.snippet}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function Row({ title, meta, onPress, testID }: { title: string; meta: string; onPress: () => void; testID: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row} testID={testID}>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {title}
      </Text>
      {meta.length > 0 && <Text style={styles.rowMeta}>{meta}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 12,
    padding: 16,
    paddingBottom: 40,
  },
  search: {
    backgroundColor: colors.ink900,
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  askEntry: {
    backgroundColor: colors.ink900,
    borderColor: colors.signalDim,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  askLabel: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  list: {
    gap: 8,
  },
  section: {
    gap: 8,
    marginTop: 8,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  identity: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  link: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  row: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  rowTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  rowMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  snippet: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  muted: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  centered: {
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  stateTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});
