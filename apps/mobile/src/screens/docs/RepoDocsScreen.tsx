import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { DocPageKind, DocTreeNode, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { usePullToRefresh } from "../../components/PullToRefresh";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys } from "../../lib/docs-mutations";
import {
  buildDocForest,
  type DocForestNode,
  mergeDocSearchHits,
  releaseCommitFromSlug,
  repoDocTabs,
  type RepoDocsTab,
} from "../../lib/docs-structure";
import { shortDate } from "../../lib/format";
import { getLastRepoDocsTab, setLastRepoDocsTab } from "../../lib/storage";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;
/** Il debounce del campo di ricerca, come la ricerca globale. */
const SEARCH_DEBOUNCE_MS = 300;

type Props = NativeStackScreenProps<ProjectsStackParamList, "RepoDocs">;
type OpenPage = (slug: string) => void;

/** Prima pagina di una categoria nell'ordine della sidebar del web (position, poi titolo). */
function firstOfKind(nodes: readonly Reader<DocTreeNode>[], kind: DocPageKind): Reader<DocTreeNode> | undefined {
  return nodes
    .filter((node) => node.kind === kind)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))[0];
}

/**
 * LA DOCUMENTAZIONE DI UN REPOSITORY, a tab come sul web («la documentazione
 * nell'app, come sul web», 25 set 2026, design §4): Overview · Technical ·
 * Functional · Product · Manual · Releases, solo le categorie che hanno
 * pagine. Sola lettura: generazione, grafo, pagine manuali ed export restano
 * sul web.
 *
 * L'albero si carica UNA volta (`docs.tree`) e ogni tab lo filtra, come fa il
 * web. È l'unica lettura che regge la schermata: il brief e gli highlights
 * sono ACCESSORI, fuori dai gate — se falliscono la loro sezione sparisce e la
 * pagina resta intera («Start here» e le categorie vengono dall'albero).
 *
 * L'ultima tab si ricorda PER repository (`lib/storage.ts`, mai bloccante);
 * una tab ricordata che non esiste più (nessuna pagina) apre Overview.
 *
 * ⚠️ La ricerca nel repository è un CAMPO in testa, sempre visibile, e non
 * un'icona nell'intestazione come diceva il design: `ScreenHeader` ha già la
 * lente della ricerca GLOBALE, e due lenti una accanto all'altra con due
 * significati diversi confondono. Mentre si cerca, i risultati coprono le tab.
 */
export function RepoDocsScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { repositoryId, repositoryName } = route.params;

  const tree = useQuery({
    queryKey: docsKeys.tree(repositoryId),
    queryFn: () => {
      if (!client) throw new Error("RepoDocsScreen richiede un client autenticato");
      return client.docs.tree(repositoryId);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });
  const nodes = tree.data ?? [];
  const tabs = repoDocTabs(nodes);

  const [tab, setTab] = useState<RepoDocsTab | null>(null);
  // La tab si decide quando l'albero c'è: prima non si sa quali esistono.
  useEffect(() => {
    if (!tree.data || tab !== null) return;
    let alive = true;
    void getLastRepoDocsTab(repositoryId).then((stored) => {
      if (!alive) return;
      const available = repoDocTabs(tree.data);
      setTab(stored !== null && (available as string[]).includes(stored) ? (stored as RepoDocsTab) : "overview");
    });
    return () => {
      alive = false;
    };
  }, [repositoryId, tab, tree.data]);

  function select(next: RepoDocsTab) {
    setTab(next);
    void setLastRepoDocsTab(repositoryId, next);
  }

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const openPage: OpenPage = (slug) => navigation.navigate("Page", { repositoryId, slug });
  const refreshControl = usePullToRefresh([docsKeys.all], "repo-docs-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader
          title={repositoryName}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.docs.repo.back")}
        />

        <TextInput
          accessibilityLabel={t("mobile.docs.repo.searchPlaceholder")}
          value={draft}
          onChangeText={setDraft}
          placeholder={t("mobile.docs.repo.searchPlaceholder")}
          placeholderTextColor={colors.faint}
          style={styles.search}
          testID="repo-docs-search-input"
        />

        {query.length > 0 ? (
          <RepoSearchResults repositoryId={repositoryId} query={query} onOpenPage={openPage} />
        ) : tree.isPending ? (
          <View style={styles.list} testID="repo-docs-skeleton">
            <Skeleton height={36} />
            <Skeleton height={90} />
            <Skeleton height={90} />
          </View>
        ) : tree.isError ? (
          <View style={styles.centered} testID="repo-docs-error">
            <Text style={styles.stateTitle}>{t("mobile.docs.repo.loadError")}</Text>
            <GhostButton label={t("mobile.docs.repo.retry")} onPress={() => void tree.refetch()} testID="repo-docs-retry" />
          </View>
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {tabs.map((option) => {
                const active = tab === option;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => select(option)}
                    style={[styles.tab, active && styles.tabActive]}
                    testID={`repo-docs-tab-${option}`}
                  >
                    <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                      {t(`mobile.docs.repo.tabs.${option}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {tab === "overview" ? (
              <Overview
                repositoryId={repositoryId}
                nodes={nodes}
                tabs={tabs}
                onOpenPage={openPage}
                onSelectTab={select}
                onOpenBrief={() => navigation.navigate("RepoBrief", { repositoryId, repositoryName })}
              />
            ) : tab === "releases" ? (
              <Releases nodes={nodes} onOpenPage={openPage} />
            ) : tab !== null ? (
              <CategoryForest nodes={nodes.filter((node) => node.kind === tab)} onOpenPage={openPage} />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * La panoramica di un repository, come `DocsRepoOverview` del web: il brief in
 * testa, «Start here», le categorie col conteggio e le novità.
 */
function Overview({
  repositoryId,
  nodes,
  tabs,
  onOpenPage,
  onSelectTab,
  onOpenBrief,
}: {
  repositoryId: string;
  nodes: readonly Reader<DocTreeNode>[];
  tabs: RepoDocsTab[];
  onOpenPage: OpenPage;
  onSelectTab: (tab: RepoDocsTab) => void;
  onOpenBrief: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();

  // ACCESSORI: fuori dai gate, un loro guasto toglie solo la loro sezione.
  const brief = useQuery({
    queryKey: docsKeys.brief(repositoryId),
    queryFn: () => client!.docs.brief(repositoryId),
    enabled: client !== null,
    staleTime: 5 * 60_000,
  });
  const highlights = useQuery({
    queryKey: docsKeys.repoHighlights(repositoryId),
    queryFn: () => client!.docs.repoHighlights(repositoryId),
    enabled: client !== null,
    staleTime: 60_000,
  });

  const firstTechnical = firstOfKind(nodes, "technical");
  const firstProduct = firstOfKind(nodes, "product");
  const latestRelease = [...nodes]
    .filter((node) => node.kind === "releases")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const categories = tabs.filter((tab): tab is DocPageKind => tab !== "overview");
  const whatsNew = highlights.data;
  const hasNews =
    whatsNew !== undefined &&
    whatsNew.latestReleases.length + whatsNew.recentlyUpdated.length + whatsNew.topViewed.length > 0;

  return (
    <View style={styles.list} testID="repo-docs-overview">
      {brief.data ? (
        <View style={styles.card}>
          <Text style={styles.identity}>{brief.data.brief.identity}</Text>
          <Pressable accessibilityRole="button" onPress={onOpenBrief} testID="repo-docs-brief-link">
            <Text style={styles.link}>{t("mobile.docs.repo.briefLink")}</Text>
          </Pressable>
        </View>
      ) : brief.isError ? (
        <Text style={styles.muted}>{t("mobile.docs.repo.noBrief")}</Text>
      ) : null}

      {(firstTechnical || firstProduct || latestRelease) && (
        <View style={styles.section}>
          <SectionLabel>{t("mobile.docs.repo.startHere")}</SectionLabel>
          {firstTechnical && (
            <EntryRow
              title={firstTechnical.title}
              meta={t("mobile.docs.repo.tabs.technical")}
              onPress={() => onOpenPage(firstTechnical.slug)}
              testID="repo-docs-start-technical"
            />
          )}
          {firstProduct && (
            <EntryRow
              title={firstProduct.title}
              meta={t("mobile.docs.repo.tabs.product")}
              onPress={() => onOpenPage(firstProduct.slug)}
              testID="repo-docs-start-product"
            />
          )}
          {latestRelease && (
            <EntryRow
              title={latestRelease.title}
              meta={shortDate(latestRelease.createdAt)}
              onPress={() => onOpenPage(latestRelease.slug)}
              testID="repo-docs-start-release"
            />
          )}
        </View>
      )}

      {categories.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>{t("mobile.docs.repo.categories")}</SectionLabel>
          <View style={styles.tiles}>
            {categories.map((kind) => (
              <Pressable
                key={kind}
                accessibilityRole="button"
                onPress={() => onSelectTab(kind)}
                style={styles.tile}
                testID={`repo-docs-category-${kind}`}
              >
                <Text style={styles.tileTitle}>{t(`mobile.docs.repo.tabs.${kind}`)}</Text>
                <Text style={styles.tileMeta}>
                  {t("mobile.docs.browse.pageCount", { count: nodes.filter((node) => node.kind === kind).length })}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {hasNews && (
        <View style={styles.section} testID="repo-docs-whats-new">
          <SectionLabel>{t("mobile.docs.repo.whatsNew")}</SectionLabel>
          {whatsNew.latestReleases.slice(0, 3).map((release) => (
            <EntryRow
              key={`r-${release.slug}`}
              title={release.title}
              meta={shortDate(release.createdAt)}
              onPress={() => onOpenPage(release.slug)}
              testID={`repo-docs-latest-${release.slug}`}
            />
          ))}
          {whatsNew.recentlyUpdated.slice(0, 4).map((page) => (
            <EntryRow
              key={`u-${page.slug}`}
              title={page.title}
              meta={t("mobile.docs.repo.recentlyUpdated")}
              onPress={() => onOpenPage(page.slug)}
              testID={`repo-docs-recent-${page.slug}`}
            />
          ))}
          {whatsNew.topViewed.slice(0, 4).map((page) => (
            <EntryRow
              key={`v-${page.slug}`}
              title={page.title}
              meta={t("mobile.docs.repo.topViewed")}
              onPress={() => onOpenPage(page.slug)}
              testID={`repo-docs-viewed-${page.slug}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Una riga premibile: titolo, e sotto una riga mono di contesto. */
function EntryRow({ title, meta, onPress, testID }: { title: string; meta: string; onPress: () => void; testID: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row} testID={testID}>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.rowMeta}>{meta}</Text>
    </Pressable>
  );
}

/**
 * L'albero di una categoria, da `parentId` come `buildForest` del web. Un nodo
 * con figli si apre col chevron; il titolo apre sempre la pagina.
 */
function CategoryForest({ nodes, onOpenPage }: { nodes: readonly Reader<DocTreeNode>[]; onOpenPage: OpenPage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const forest = buildDocForest(nodes);

  function toggle(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (forest.length === 0) return <Text style={styles.muted}>{t("mobile.docs.repo.empty")}</Text>;

  function renderNode(node: DocForestNode, depth: number) {
    const expanded = open.has(node.id);
    return (
      <View key={node.id}>
        <View style={[styles.nodeRow, { paddingLeft: 12 + depth * 16 }]}>
          {node.children.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(expanded ? "mobile.docs.repo.collapse" : "mobile.docs.repo.expand")}
              accessibilityState={{ expanded }}
              hitSlop={8}
              onPress={() => toggle(node.id)}
              testID={`repo-docs-toggle-${node.slug}`}
            >
              <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
            </Pressable>
          ) : (
            <View style={styles.chevronSpacer} />
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenPage(node.slug)}
            style={styles.nodeTitle}
            testID={`repo-docs-node-${node.slug}`}
          >
            <Text style={styles.rowTitle}>{node.title}</Text>
          </Pressable>
        </View>
        {expanded && node.children.map((child) => renderNode(child, depth + 1))}
      </View>
    );
  }

  return (
    <View style={styles.forest} testID="repo-docs-forest">
      {forest.map((node) => renderNode(node, 0))}
    </View>
  );
}

/**
 * Il changelog, come `DocsReleases` del web: in ordine di `position`, con la
 * data, il commit ricavato dallo slug e il badge «minor». «Solo
 * significative» nasconde le minori (`significant === false`); quelle vecchie,
 * senza il dato (`null`), restano.
 */
function Releases({ nodes, onOpenPage }: { nodes: readonly Reader<DocTreeNode>[]; onOpenPage: OpenPage }) {
  const { t } = useTranslation();
  const [onlySignificant, setOnlySignificant] = useState(false);
  const releases = nodes
    .filter((node) => node.kind === "releases")
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .filter((node) => !onlySignificant || node.significant !== false);

  return (
    <View style={styles.list} testID="repo-docs-releases">
      <View style={styles.switchRow}>
        <Text style={styles.rowMeta}>{t("mobile.docs.repo.onlySignificant")}</Text>
        <Switch
          accessibilityLabel={t("mobile.docs.repo.onlySignificant")}
          value={onlySignificant}
          onValueChange={setOnlySignificant}
          testID="repo-docs-only-significant"
        />
      </View>
      {releases.length === 0 && <Text style={styles.muted}>{t("mobile.docs.repo.noSignificant")}</Text>}
      {releases.map((release) => {
        const commit = releaseCommitFromSlug(release.slug);
        return (
          <Pressable
            key={release.id}
            accessibilityRole="button"
            onPress={() => onOpenPage(release.slug)}
            style={styles.row}
            testID={`repo-docs-release-${release.slug}`}
          >
            <View style={styles.releaseMeta}>
              <Text style={styles.rowMeta}>{shortDate(release.createdAt)}</Text>
              {commit && <Text style={styles.rowMeta}>{commit}</Text>}
              {release.significant === false && (
                <Text style={styles.badge} testID={`repo-docs-minor-${release.slug}`}>
                  {t("mobile.docs.repo.minor")}
                </Text>
              )}
            </View>
            <Text style={styles.rowTitle}>{release.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * La ricerca nel repository, come il web: la corsia full-text
 * (`search.global` filtrata sul repository) più quella semantica, fuse senza
 * doppioni con la semantica prima (`mergeDocSearchHits`). Le due corsie sono
 * indipendenti: se una fallisce, si mostra l'altra.
 */
function RepoSearchResults({
  repositoryId,
  query,
  onOpenPage,
}: {
  repositoryId: string;
  query: string;
  onOpenPage: OpenPage;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const fullText = useQuery({
    queryKey: docsKeys.repoSearch(repositoryId, query),
    queryFn: () => client!.search.global(query, repositoryId),
    enabled: client !== null,
  });
  const semantic = useQuery({
    queryKey: docsKeys.repoSemantic(repositoryId, query),
    queryFn: () => client!.search.docsSemantic(query, repositoryId),
    enabled: client !== null,
  });

  if (fullText.isPending && semantic.isPending) {
    return (
      <View style={styles.list} testID="repo-docs-search-loading">
        <Skeleton height={56} />
        <Skeleton height={56} />
      </View>
    );
  }
  if (fullText.isError && semantic.isError) {
    return <Text style={styles.muted}>{t("mobile.docs.repo.searchError")}</Text>;
  }
  const hits = mergeDocSearchHits(fullText.data?.docs.items ?? [], semantic.data ?? []);
  if (hits.length === 0) return <Text style={styles.muted}>{t("mobile.docs.repo.searchEmpty")}</Text>;

  return (
    <View style={styles.list} testID="repo-docs-search-results">
      {hits.map((hit) => (
        <Pressable
          key={`${hit.repositoryId}:${hit.slug}`}
          accessibilityRole="button"
          onPress={() => onOpenPage(hit.slug)}
          style={styles.row}
          testID={`repo-docs-hit-${hit.slug}`}
        >
          <Text style={styles.rowTitle}>{hit.title}</Text>
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
  tabs: {
    gap: 8,
  },
  tab: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  tabActive: {
    borderColor: colors.signalDim,
  },
  tabLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  tabLabelActive: {
    color: colors.signal,
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
  muted: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 19,
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
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  tile: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    gap: 2,
    minWidth: "47%",
    padding: 12,
  },
  tileTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  tileMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  forest: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingVertical: 4,
  },
  nodeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingRight: 12,
    paddingVertical: 9,
  },
  nodeTitle: {
    flex: 1,
  },
  chevron: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    width: 14,
  },
  chevronSpacer: {
    width: 14,
  },
  switchRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  releaseMeta: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  badge: {
    borderColor: colors.line,
    borderRadius: 3,
    borderWidth: 1,
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    paddingHorizontal: 5,
    textTransform: "uppercase",
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
