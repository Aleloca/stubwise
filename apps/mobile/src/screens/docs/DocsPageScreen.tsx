import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import type { DocsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys, docsKindLabelKey } from "../../lib/docs-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Una pagina di documentazione in markdown (canvas: nessun mockup dedicato —
 * `3f` copre solo l'hub Docs, non la pagina; stessa situazione di
 * `BacklogItemScreen`, che documenta la stessa assenza). Raggiunta da
 * `DocsScreen` (ricerca o «Oppure sfoglia») e dalle "Fonti" cliccabili di
 * `AskProjectScreen` — sempre con `repositoryId`+`slug`, mai un id di pagina:
 * è la stessa coppia che porta una fonte della chat.
 *
 * Rendering: `react-native-markdown-display`, stessa configurazione di
 * `PlanSection.tsx` (sanitizzato per costruzione — `html: false` di default
 * in markdown-it, un tag HTML nel corpo appare come testo letterale).
 */
export function DocsPageScreen({ navigation, route }: NativeStackScreenProps<DocsStackParamList, "Page">) {
  const { t } = useTranslation();
  const { client } = useAuth();
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

  const notFound = pageQuery.isError && pageQuery.error instanceof ApiError && pageQuery.error.status === 404;

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.goBack()} testID="docs-page-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.docs.page.back")}</Text>
      </Pressable>

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
        <ScrollView contentContainerStyle={styles.body}>
          <SectionLabel>{t(docsKindLabelKey(pageQuery.data!.kind))}</SectionLabel>
          <Text style={styles.title}>{pageQuery.data!.title}</Text>
          <Markdown style={MARKDOWN_STYLE}>{pageQuery.data!.body}</Markdown>
        </ScrollView>
      )}
    </View>
  );
}

const MARKDOWN_STYLE = {
  body: { color: colors.fg, fontSize: fontSize.body },
  heading1: { color: colors.fg },
  heading2: { color: colors.fg },
  heading3: { color: colors.fg },
  strong: { color: colors.fg },
  bullet_list: { marginTop: 4 },
  code_inline: { backgroundColor: colors.ink800, color: colors.fg },
  fence: { backgroundColor: colors.ink800, borderColor: colors.line },
  code_block: { backgroundColor: colors.ink800, borderColor: colors.line },
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  backRow: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
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
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    marginBottom: 8,
    marginTop: 4,
  },
});
