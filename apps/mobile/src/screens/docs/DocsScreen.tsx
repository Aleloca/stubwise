import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DocTreeNode, Reader, SearchResults } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { DocsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys, groupTreeByKind, mainDocSpace } from "../../lib/docs-mutations";
import { getLastDocsProjectId, setLastDocsProjectId } from "../../lib/storage";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Quanto attendere dopo l'ultimo tocco prima di lanciare la ricerca (canvas: "Cerca nella documentazione…"). */
const SEARCH_DEBOUNCE_MS = 300;

type BrowseGroupKey = "functional" | "technical" | "releases";

/**
 * Hub Docs (canvas `3f`): ricerca, «Oppure sfoglia» nei tre gruppi
 * (Guida funzionale / Note di rilascio / Pagine tecniche — dai `kind`
 * `functional`/`releases`/`technical`, vedi `groupTreeByKind` in
 * `lib/docs-mutations.ts`) ed entrata di «Chiedi al progetto».
 *
 * SCOPING: un solo switcher progetto ("Portale B2B ▾" nel canvas — il
 * fixture `PROJECT` di `BacklogScreen.test.tsx` conferma che è un nome di
 * PROGETTO, non di repository). Sfoglia e cerca restano scopati allo spazio
 * doc PRINCIPALE del progetto ({@link mainDocSpace}, stessa euristica del
 * `mainSpace` web) — nessun secondo picker "repository" su questo screen: il
 * canvas non ne mostra uno, e introdurne uno sarebbe andare oltre quanto
 * disegnato. «Chiedi al progetto» invece resta cross-repo per costruzione
 * (vedi `AskProjectScreen.tsx`) — l'unico posto dove "progetto" e "spazio
 * doc" divergono davvero.
 */
export function DocsScreen({ navigation }: NativeStackScreenProps<DocsStackParamList, "List">) {
  const { t } = useTranslation();
  const { client } = useAuth();

  const [projectId, setProjectId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedGroup, setExpandedGroup] = useState<BrowseGroupKey | null>(null);
  const projectInitialized = useRef(false);

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("DocsScreen richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
  const projects = projectsQuery.data ?? [];

  // Preseleziona l'ultimo progetto usato (AsyncStorage, stesso pattern di
  // `CaptureSheet`), o il primo della lista se non c'è uno storico o quello
  // salvato non esiste più fra i progetti visibili.
  useEffect(() => {
    if (projectInitialized.current || projects.length === 0) return;
    projectInitialized.current = true;
    void (async () => {
      const last = await getLastDocsProjectId();
      setProjectId(last !== null && projects.some((project) => project.id === last) ? last : (projects[0]?.id ?? ""));
    })();
  }, [projects]);

  // Debounce della ricerca: il timer riparte a ogni tocco (`rawQuery`
  // cambia), quindi più tocchi ravvicinati collassano in UNA sola ricerca,
  // con l'ULTIMO testo digitato — non una ricerca per tocco.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const spacesQuery = useQuery({
    queryKey: docsKeys.spaces(projectId),
    queryFn: () => {
      if (!client) throw new Error("DocsScreen richiede un client autenticato");
      return client.docs.projectSpaces(projectId);
    },
    enabled: client !== null && projectId !== "",
    staleTime: 10_000,
  });

  const mainSpace = mainDocSpace(spacesQuery.data ?? []);
  const repositoryId = mainSpace?.repositoryId;

  const treeQuery = useQuery({
    queryKey: docsKeys.tree(repositoryId ?? ""),
    queryFn: () => {
      if (!client) throw new Error("DocsScreen richiede un client autenticato");
      return client.docs.tree(repositoryId!);
    },
    enabled: client !== null && repositoryId !== undefined,
    staleTime: 10_000,
  });

  const trimmedQuery = debouncedQuery.trim();
  const searchQuery = useQuery({
    queryKey: docsKeys.search(repositoryId ?? "", trimmedQuery),
    queryFn: () => {
      if (!client) throw new Error("DocsScreen richiede un client autenticato");
      return client.search.global(trimmedQuery, repositoryId);
    },
    enabled: client !== null && repositoryId !== undefined && trimmedQuery.length > 0,
    staleTime: 10_000,
  });
  const isSearching = trimmedQuery.length > 0;

  const selectedProject = projects.find((project) => project.id === projectId);
  const groups = groupTreeByKind(treeQuery.data ?? []);

  function openAskProject(): void {
    if (!selectedProject) return;
    navigation.navigate("Ask", { projectId: selectedProject.id, projectName: selectedProject.name });
  }

  function openPage(slug: string): void {
    if (!repositoryId) return;
    navigation.navigate("Page", { repositoryId, slug });
  }

  function pickProject(id: string): void {
    setProjectId(id);
    setPickerOpen(false);
    setExpandedGroup(null);
    void setLastDocsProjectId(id);
  }

  // "Caricamento" copre l'INTERA catena di query dipendenti (progetti → spazi
  // → albero), non solo la prima: fra "i progetti sono arrivati" e "l'effetto
  // ha scelto un projectId" c'è un render in cui `projectId` è ancora "" — SENZA
  // la seconda clausola qui sotto, in quel render `spacesQuery` risulterebbe
  // `enabled: false` (quindi `isPending: true` per sempre, ma la clausola
  // `projectId !== ""` la escluderebbe comunque) e la UI mostrerebbe per un
  // istante «Oppure sfoglia» con conteggi a zero prima dei dati veri.
  const loading =
    projectsQuery.isPending ||
    (projects.length > 0 && projectId === "") ||
    (projectId !== "" && spacesQuery.isPending) ||
    (repositoryId !== undefined && treeQuery.isPending);
  const noSpaces = !loading && spacesQuery.isSuccess && (spacesQuery.data ?? []).length === 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("mobile.docs.title")}</Text>
          {projects.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("mobile.docs.project.pickerLabel")}
              onPress={() => setPickerOpen((open) => !open)}
              style={styles.projectPill}
              testID="docs-project-toggle"
            >
              <Text style={styles.projectPillLabel}>{selectedProject ? `${selectedProject.name} ▾` : "— ▾"}</Text>
            </Pressable>
          )}
        </View>

        {pickerOpen && (
          <View style={styles.projectList} testID="docs-project-list">
            {projects.map((project) => (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                onPress={() => pickProject(project.id)}
                style={styles.projectOption}
                testID={`docs-project-${project.id}`}
              >
                <Text style={styles.projectOptionLabel}>{project.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {repositoryId && (
          <View style={styles.searchBox}>
            <TextInput
              accessibilityLabel={t("mobile.docs.searchPlaceholder")}
              value={rawQuery}
              onChangeText={setRawQuery}
              placeholder={t("mobile.docs.searchPlaceholder")}
              placeholderTextColor={colors.faint}
              style={styles.searchInput}
              testID="docs-search-input"
            />
          </View>
        )}
      </View>

      {projects.length === 0 && !projectsQuery.isPending ? (
        <View style={styles.centered} testID="docs-empty">
          <Text style={styles.emptyTitle}>{t("mobile.docs.empty.title")}</Text>
          <Text style={styles.emptyBody}>{t("mobile.docs.project.none")}</Text>
        </View>
      ) : loading ? (
        <View style={styles.skeletonList} testID="docs-skeleton">
          <Skeleton height={44} />
          <Skeleton height={90} />
          <Skeleton height={90} />
        </View>
      ) : noSpaces ? (
        <View style={styles.centered} testID="docs-empty">
          <Text style={styles.emptyTitle}>{t("mobile.docs.empty.title")}</Text>
          <Text style={styles.emptyBody}>{t("mobile.docs.empty.body")}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {isSearching ? (
            <SearchResultsSection query={searchQuery} onOpenPage={openPage} />
          ) : (
            <>
              <Pressable onPress={openAskProject} style={styles.askEntry} testID="docs-ask-entry">
                <SectionLabel>{t("mobile.docs.ask.sectionLabel")}</SectionLabel>
                <Text style={styles.askHint}>{t("mobile.docs.ask.entryHint")}</Text>
              </Pressable>

              <SectionLabel style={styles.browseLabel}>{t("mobile.docs.browse.label")}</SectionLabel>
              <View style={styles.browseCard}>
                <BrowseRow
                  labelKey="mobile.docs.browse.functional"
                  countText={pageCountText(groups.functional.count, t)}
                  count={groups.functional.count}
                  expanded={expandedGroup === "functional"}
                  onPress={() => setExpandedGroup((current) => (current === "functional" ? null : "functional"))}
                  nodes={groups.functional.nodes}
                  onOpenPage={openPage}
                  testID="docs-browse-functional"
                />
                <BrowseRow
                  labelKey="mobile.docs.browse.releases"
                  countText={
                    groups.releases.latest ? t("mobile.docs.browse.latestRelease", { title: groups.releases.latest.title }) : t("mobile.docs.browse.noReleases")
                  }
                  count={groups.releases.count}
                  expanded={expandedGroup === "releases"}
                  onPress={() => setExpandedGroup((current) => (current === "releases" ? null : "releases"))}
                  nodes={groups.releases.nodes}
                  onOpenPage={openPage}
                  testID="docs-browse-releases"
                  last
                />
                <BrowseRow
                  labelKey="mobile.docs.browse.technical"
                  countText={pageCountText(groups.technical.count, t)}
                  count={groups.technical.count}
                  expanded={expandedGroup === "technical"}
                  onPress={() => setExpandedGroup((current) => (current === "technical" ? null : "technical"))}
                  nodes={groups.technical.nodes}
                  onOpenPage={openPage}
                  testID="docs-browse-technical"
                  last
                />
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function pageCountText(count: number, t: ReturnType<typeof useTranslation>["t"]): string {
  return t("mobile.docs.browse.pageCount", { count });
}

function BrowseRow({
  labelKey,
  countText,
  count,
  expanded,
  onPress,
  nodes,
  onOpenPage,
  testID,
  last = false,
}: {
  labelKey: string;
  countText: string;
  count: number;
  expanded: boolean;
  onPress: () => void;
  nodes: Reader<DocTreeNode>[];
  onOpenPage: (slug: string) => void;
  testID: string;
  last?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={!last ? styles.browseRowBorder : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: count === 0 }}
        disabled={count === 0}
        onPress={onPress}
        style={styles.browseRow}
        testID={testID}
      >
        <Text style={styles.browseRowLabel}>{t(labelKey)}</Text>
        <Text style={styles.browseRowMeta}>{countText} ›</Text>
      </Pressable>
      {expanded && (
        <View style={styles.browseExpanded} testID={`${testID}-expanded`}>
          {nodes.length === 0 ? (
            <Text style={styles.browseEmpty}>{t("mobile.docs.browse.groupEmpty")}</Text>
          ) : (
            nodes.map((n) => (
              <Pressable key={n.id} onPress={() => onOpenPage(n.slug)} style={styles.browsePageRow} testID={`docs-page-row-${n.id}`}>
                <Text style={styles.browsePageTitle} numberOfLines={1}>
                  {n.title}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      )}
    </View>
  );
}

function SearchResultsSection({
  query,
  onOpenPage,
}: {
  query: UseQueryResult<Reader<SearchResults>>;
  onOpenPage: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const items = query.data?.docs.items ?? [];

  if (query.isPending) {
    return (
      <View style={styles.skeletonList} testID="docs-search-skeleton">
        <Skeleton height={64} />
        <Skeleton height={64} />
      </View>
    );
  }
  if (query.isError) {
    return <Text style={styles.emptyBody}>{t("mobile.docs.loadError.title")}</Text>;
  }
  if (items.length === 0) {
    return <Text style={styles.emptyBody}>{t("mobile.docs.search.empty")}</Text>;
  }
  return (
    <View style={styles.searchResults} testID="docs-search-results">
      {items.map((hit) => (
        <Pressable
          key={`${hit.repositoryId}-${hit.slug}`}
          onPress={() => onOpenPage(hit.slug)}
          style={styles.searchResultRow}
          testID={`docs-search-result-${hit.slug}`}
        >
          <Text style={styles.searchResultTitle} numberOfLines={1}>
            {hit.title}
          </Text>
          <Text style={styles.searchResultSnippet} numberOfLines={2}>
            {hit.snippet}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  projectPill: {
    borderColor: "#2c3641",
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  projectPillLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  projectList: {
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 8,
    overflow: "hidden",
  },
  projectOption: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  projectOptionLabel: {
    color: colors.fg,
    fontSize: 14,
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: "#2c3641",
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: {
    color: colors.fg,
    flex: 1,
    fontSize: fontSize.input,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  skeletonList: {
    gap: 8,
    padding: 16,
  },
  body: {
    gap: 4,
    padding: 16,
    paddingBottom: 40,
  },
  askEntry: {
    backgroundColor: colors.ink900,
    borderColor: "#b97d1a",
    borderRadius: radii.card,
    borderWidth: 1,
    marginBottom: 16,
    padding: 14,
  },
  askHint: {
    color: colors.fg,
    fontSize: 14,
    marginTop: 6,
  },
  browseLabel: {
    marginBottom: 8,
  },
  browseCard: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  browseRowBorder: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  browseRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  browseRowLabel: {
    color: colors.fg,
    flex: 1,
    fontSize: 14,
  },
  browseRowMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  browseExpanded: {
    backgroundColor: colors.ink950,
    paddingBottom: 8,
  },
  browseEmpty: {
    color: colors.faint,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  browsePageRow: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 6,
  },
  browsePageTitle: {
    color: colors.muted,
    fontSize: 13,
  },
  searchResults: {
    gap: 8,
  },
  searchResultRow: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 12,
  },
  searchResultTitle: {
    color: colors.fg,
    fontSize: 14,
    fontWeight: "600",
  },
  searchResultSnippet: {
    color: colors.faint,
    fontSize: 12,
    marginTop: 4,
  },
});
