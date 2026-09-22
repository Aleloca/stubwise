import type { DocTreeNode, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { groupTreeByKind } from "../../lib/docs-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** I tre gruppi in cui `groupTreeByKind` ripartisce le pagine di uno spazio. */
export type BrowseGroupKey = "functional" | "technical" | "releases";

/**
 * «Oppure sfoglia»: i tre gruppi di pagine di UNO spazio documentale
 * (funzionale, release, tecnico), ognuno apribile sull'elenco delle sue
 * pagine.
 *
 * Viveva dentro `screens/docs/DocsScreen.tsx`; estratto qui il 22 set 2026
 * (hub di progetto, tappa 2) perché da allora lo montano in DUE — il tab DOC
 * e la documentazione DI UN PROGETTO. **Estratto, non copiato**: due alberi
 * che raggruppano le stesse pagine in due posti divergono, ed è il difetto
 * che questo repo insegue ovunque.
 *
 * Prende i NODI già caricati e non un `repositoryId`: chi lo monta ha già la
 * sua query dell'albero e la usa anche per decidere cosa mostrare mentre
 * carica — `DocsScreen` ne fa parte del proprio stato «caricamento», e
 * spostare la richiesta qui dentro gliela toglierebbe di mano.
 *
 * Lo stato di apertura è LOCALE e uno solo: si apre un gruppo alla volta, e
 * aprirne un altro chiude il precedente — com'era, e come serve su uno
 * schermo alto quanto un telefono.
 */
export function DocSpaceBrowser({
  nodes,
  onOpenPage,
  testIDPrefix = "docs-browse",
}: {
  nodes: Reader<DocTreeNode>[];
  onOpenPage: (slug: string) => void;
  /** Prefisso dei `testID`, per distinguere due browser montati nella stessa schermata. */
  testIDPrefix?: string;
}) {
  const { t } = useTranslation();
  const [expandedGroup, setExpandedGroup] = useState<BrowseGroupKey | null>(null);
  const groups = groupTreeByKind(nodes);

  const toggle = (key: BrowseGroupKey) => () =>
    setExpandedGroup((current) => (current === key ? null : key));

  return (
    <View style={styles.browseCard}>
      <BrowseRow
        labelKey="mobile.docs.browse.functional"
        countText={t("mobile.docs.browse.pageCount", { count: groups.functional.count })}
        count={groups.functional.count}
        expanded={expandedGroup === "functional"}
        onPress={toggle("functional")}
        nodes={groups.functional.nodes}
        onOpenPage={onOpenPage}
        testID={`${testIDPrefix}-functional`}
      />
      <BrowseRow
        labelKey="mobile.docs.browse.releases"
        countText={
          groups.releases.latest
            ? t("mobile.docs.browse.latestRelease", { title: groups.releases.latest.title })
            : t("mobile.docs.browse.noReleases")
        }
        count={groups.releases.count}
        expanded={expandedGroup === "releases"}
        onPress={toggle("releases")}
        nodes={groups.releases.nodes}
        onOpenPage={onOpenPage}
        testID={`${testIDPrefix}-releases`}
        last
      />
      <BrowseRow
        labelKey="mobile.docs.browse.technical"
        countText={t("mobile.docs.browse.pageCount", { count: groups.technical.count })}
        count={groups.technical.count}
        expanded={expandedGroup === "technical"}
        onPress={toggle("technical")}
        nodes={groups.technical.nodes}
        onOpenPage={onOpenPage}
        testID={`${testIDPrefix}-technical`}
        last
      />
    </View>
  );
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

const styles = StyleSheet.create({
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
    fontFamily: fontFamily.sans,
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
    fontFamily: fontFamily.sans,
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
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
});
