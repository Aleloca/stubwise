import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { DocsPageParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { SectionLabel } from "../../components/SectionLabel";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import type { DocPageLink, Reader } from "@stubwise/shared";
import { docsKeys, docsKindLabelKey } from "../../lib/docs-mutations";
import { shortDate } from "../../lib/format";
import { usePageViewPing } from "../../lib/view-ping";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Una pagina di documentazione in markdown (canvas: nessun mockup dedicato —
 * `3f` copre solo l'hub Docs, non la pagina; stessa situazione di
 * `BacklogItemScreen`, che documenta la stessa assenza). Raggiunta dalla
 * documentazione del progetto, dalla ricerca globale e dalle "Fonti"
 * cliccabili di `AskProjectScreen` (il tab DOC, che era la quarta strada, non
 * c'è più dal 25 set 2026) — sempre con `repositoryId`+`slug`, mai un id di pagina:
 * è la stessa coppia che porta una fonte della chat.
 *
 * Rendering: `react-native-markdown-display`, stile condiviso con
 * `PlanSection.tsx` (Task 16) in `theme/markdown.ts` — sanitizzato per
 * costruzione (`html: false` di default in markdown-it, un tag HTML nel
 * corpo appare come testo letterale).
 *
 * Dal 25 set 2026 («la documentazione nell'app, come sul web» §5), come sul
 * web: i badge (categoria, data di aggiornamento, commit), le PAGINE
 * COLLEGATE raggruppate e premibili, e il conteggio delle visite — un ping
 * fire-and-forget deduplicato per pagina (`lib/view-ping.ts`), che non fa
 * mai fallire la pagina.
 */

/** L'ordine dei gruppi di pagine collegate, come sul web. */
const LINK_GROUPS: { type: Reader<DocPageLink>["type"]; labelKey: string }[] = [
  { type: "implemented_by", labelKey: "mobile.docs.page.implementedBy" },
  { type: "implements", labelKey: "mobile.docs.page.implements" },
  { type: "related", labelKey: "mobile.docs.page.related" },
];
export function DocsPageScreen({ navigation, route }: NativeStackScreenProps<DocsPageParamList, "Page">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { repositoryId, slug } = route.params;

  const pageQuery = useQuery({
    queryKey: docsKeys.page(repositoryId, slug),
    queryFn: () => {
      if (!client) throw new Error("DocsPageScreen richiede un client autenticato");
      return client.docs.page(repositoryId, slug);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  usePageViewPing(client, repositoryId, slug);

  const notFound = pageQuery.isError && pageQuery.error instanceof ApiError && pageQuery.error.status === 404;

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView`, il link
  // "indietro" come primo figlio — stesso schema di `InboxScreen.tsx`.
  // Fix di review (Task 2, 11 set 2026): l'avatar, mancante del tutto su
  // questo screen, ora c'è sulla stessa riga — ancorata
  // (`stickyHeaderIndices`, vedi `ScreenHeader.tsx`).
  const refreshControl = usePullToRefresh([docsKeys.page(repositoryId, slug)], "docs-page-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={pageQuery.data?.title ?? t("mobile.docs.page.fallbackTitle")}
          onBack={() => navigation.goBack()}
          backLabel={t("mobile.docs.page.back")}
          titleNumberOfLines={3}
        />

        {pageQuery.isPending ? (
          <View style={styles.skeletonList} testID="docs-page-skeleton">
            <Skeleton height={24} width="60%" />
            <Skeleton height={100} />
            <Skeleton height={140} />
          </View>
        ) : notFound ? (
          <View style={styles.centered} testID="docs-page-not-found">
            <Text style={styles.errorTitle}>{t("mobile.docs.page.notFound.title")}</Text>
            <Text style={styles.errorBody}>{t("mobile.docs.page.notFound.body")}</Text>
          </View>
        ) : pageQuery.isError ? (
          <View style={styles.centered} testID="docs-page-error">
            <Text style={styles.errorTitle}>{t("mobile.docs.page.loadError.title")}</Text>
            <GhostButton label={t("mobile.docs.page.loadError.retry")} onPress={() => void pageQuery.refetch()} testID="docs-page-retry" />
          </View>
        ) : (
          // `testID` sul corpo: è il segnale che questa schermata è montata
          // E ha finito di caricare, e serve ai test che navigano nell'albero
          // vero (`app/navigation.test.tsx`) — il titolo da solo non basta,
          // compare anche nella riga dell'albero da cui si è partiti.
          <View testID="docs-page-body">
            <View style={styles.badges} testID="docs-page-badges">
              <SectionLabel>{t(docsKindLabelKey(pageQuery.data!.kind))}</SectionLabel>
              <Text style={styles.badge}>{shortDate(pageQuery.data!.updatedAt)}</Text>
              {pageQuery.data!.commitSha && <Text style={styles.badge}>{pageQuery.data!.commitSha.slice(0, 7)}</Text>}
            </View>
            <SafeMarkdown>{pageQuery.data!.body}</SafeMarkdown>
            <RelatedPages
              links={pageQuery.data!.links ?? []}
              onOpen={(linkSlug) => navigation.push("Page", { repositoryId, slug: linkSlug })}
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Le pagine collegate, raggruppate come sul web (implementata da · implementa
 * · correlate). Una pagina nuova si IMPILA sopra quella corrente (`push`):
 * l'indietro riporta qui, non alla lista da cui si era partiti.
 */
function RelatedPages({ links, onOpen }: { links: readonly Reader<DocPageLink>[]; onOpen: (slug: string) => void }) {
  const { t } = useTranslation();
  const groups = LINK_GROUPS.map((group) => ({ ...group, links: links.filter((link) => link.type === group.type) })).filter(
    (group) => group.links.length > 0,
  );
  if (groups.length === 0) return null;
  return (
    <View style={styles.related} testID="docs-page-related">
      <SectionLabel>{t("mobile.docs.page.relatedTitle")}</SectionLabel>
      {groups.map((group) => (
        <View key={group.type} style={styles.relatedGroup}>
          <Text style={styles.badge}>{t(group.labelKey)}</Text>
          {group.links.map((link) => (
            <Pressable
              key={link.slug}
              accessibilityRole="button"
              onPress={() => onOpen(link.slug)}
              style={styles.relatedLink}
              testID={`docs-page-link-${link.slug}`}
            >
              <Text style={styles.relatedTitle}>{link.title}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  badges: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  badge: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  related: {
    gap: 10,
    marginTop: 24,
  },
  relatedGroup: {
    gap: 6,
  },
  relatedLink: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    padding: 12,
  },
  relatedTitle: {
    color: colors.signal,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  // Fix di review (Task 2, 11 set 2026): `headerRow` è ora ANCORATA
  // (`stickyHeaderIndices` sullo `ScrollView` sopra) e porta anche
  // l'avatar — `backgroundColor` opaco necessario, o il contenuto sotto
  // l'attraverserebbe scorrendo.
  headerRow: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingTop: 56,
  },
  backRow: {},
  back: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  skeletonList: {
    gap: 12,
    padding: 20,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    textAlign: "center",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  // Solo gli scarti dal preset condiviso (`textStyles.screenTitle` copre
  // colore/font/peso/dimensione) — vedi il commento su `ScreenHeader.tsx`.
  title: {
    marginBottom: 8,
    marginTop: 4,
  },
});
