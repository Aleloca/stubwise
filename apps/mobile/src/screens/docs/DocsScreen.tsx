import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Reader, SearchResults } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { DocsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { DocSpaceBrowser } from "../../components/docs/DocSpaceBrowser";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys, mainDocSpace } from "../../lib/docs-mutations";
import { getLastDocsProjectId, setLastDocsProjectId } from "../../lib/storage";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/** Quanto attendere dopo l'ultimo tocco prima di lanciare la ricerca (canvas: "Cerca nella documentazione…"). */
const SEARCH_DEBOUNCE_MS = 300;

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
  const tabBarHeight = useBottomTabBarHeight();

  const [projectId, setProjectId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
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

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView`, header (ora
  // `ScreenHeader`) come primo figlio — stesso schema di `InboxScreen.tsx`.
  // Lo switcher progetto e la ricerca erano sulla riga del titolo/dentro
  // l'header fisso: restano un blocco subito sotto `ScreenHeader`, la stessa
  // sistemazione del bottone "+" in `BacklogScreen.tsx`.
  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader title={t("mobile.docs.title")} />

        <View style={styles.toolbar}>
          {projects.length > 0 && (
            <View style={styles.toolbarRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("mobile.docs.project.pickerLabel")}
                onPress={() => setPickerOpen((open) => !open)}
                style={styles.projectPill}
                testID="docs-project-toggle"
              >
                <Text style={styles.projectPillLabel}>{selectedProject ? `${selectedProject.name} ▾` : "— ▾"}</Text>
              </Pressable>
            </View>
          )}

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
        ) : isSearching ? (
          <SearchResultsSection query={searchQuery} onOpenPage={openPage} />
        ) : (
          <>
            <Pressable onPress={openAskProject} style={styles.askEntry} testID="docs-ask-entry">
              <SectionLabel>{t("mobile.docs.ask.sectionLabel")}</SectionLabel>
              <Text style={styles.askHint}>{t("mobile.docs.ask.entryHint")}</Text>
            </Pressable>

            <SectionLabel style={styles.browseLabel}>{t("mobile.docs.browse.label")}</SectionLabel>
            {/*
              I tre gruppi vivono in `components/docs/DocSpaceBrowser.tsx` dal
              22 set 2026: li monta anche la documentazione di un progetto
              nell'hub, e due copie dello stesso raggruppamento divergono.
            */}
            {/*
              ⚠️ `key` sullo SPAZIO: lo stato «quale gruppo è aperto» vive
              ora dentro il componente, e cambiando progetto non si
              azzererebbe da sé — prima lo faceva `pickProject` a mano. È la
              regola già scritta in questo repo: un componente con stato
              locale seminato da un'identità va keyato su quell'identità, o
              resta stantio quando il chiamante la cambia senza smontarlo.
            */}
            <DocSpaceBrowser key={repositoryId} nodes={treeQuery.data ?? []} onOpenPage={openPage} />
          </>
        )}
      </ScrollView>
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
  toolbar: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  toolbarRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  projectPill: {
    borderColor: colors.lineStrong,
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
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  searchBox: {
    alignItems: "center",
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.lineStrong,
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
    fontFamily: fontFamily.sans,
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
    borderColor: colors.signalDim,
    borderRadius: radii.card,
    borderWidth: 1,
    marginBottom: 16,
    padding: 14,
  },
  askHint: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    marginTop: 6,
  },
  browseLabel: {
    marginBottom: 8,
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
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  searchResultSnippet: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 12,
    marginTop: 4,
  },
});
