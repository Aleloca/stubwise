import notifee, { AuthorizationStatus } from "@notifee/react-native";
import { isUnknown } from "@stubwise/shared";
import type { InboxItem, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { InboxCard } from "../../components/inbox/InboxCard";
import { OfflineBanner } from "../../components/OfflineBanner";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { inboxKeys, useIsOnline } from "../../lib/inbox-mutations";
import type { InboxSections } from "../../lib/inbox-sections";
import { sectionize } from "../../lib/inbox-sections";
import { getLastSyncAt, setLastSyncAt } from "../../lib/storage";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Ordine di rendering delle quattro sezioni, come nel canvas (`1b`/`1c`). */
const SECTION_ORDER: { key: keyof InboxSections; labelKey: string; amber: boolean }[] = [
  { key: "blocksYou", labelKey: "mobile.inbox.sections.blocksYou", amber: true },
  { key: "onlyYouMaintainer", labelKey: "mobile.inbox.sections.onlyYouMaintainer", amber: true },
  { key: "waitingOthers", labelKey: "mobile.inbox.sections.waitingOthers", amber: false },
  { key: "fromProjects", labelKey: "mobile.inbox.sections.fromProjects", amber: false },
];

/** Nome del progetto della riga: risolto dalla lista progetti, o — solo sul pulse — dal payload dell'evento. */
function resolveProjectName(item: Reader<InboxItem>, projectsById: Map<string, string>): string | undefined {
  if (item.projectId !== null) return projectsById.get(item.projectId);
  return item.pulse?.projectName;
}

/**
 * Schermata Inbox (canvas `1b`/`1c`/`1f`/`1g`/`1h`): quattro sezioni per
 * ruolo, stato vuoto "Tutto gestito.", skeleton al primo caricamento, banner
 * offline persistente e — non bloccante — l'avviso di notifiche disattivate.
 */
export function InboxScreen() {
  const { t } = useTranslation();
  const { client, user } = useAuth();
  const online = useIsOnline();
  const [lastSyncAt, setLastSyncAtState] = useState<string | null>(null);
  const [notificationsDenied, setNotificationsDenied] = useState(false);

  useEffect(() => {
    void getLastSyncAt().then(setLastSyncAtState);
  }, []);

  useEffect(() => {
    void notifee.getNotificationSettings().then((settings) => {
      setNotificationsDenied(settings.authorizationStatus === AuthorizationStatus.DENIED);
    });
  }, []);

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("InboxScreen richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const query = useQuery({
    queryKey: inboxKeys.list(),
    queryFn: async () => {
      if (!client) throw new Error("InboxScreen richiede un client autenticato");
      const page = await client.inbox.list();
      const now = new Date().toISOString();
      void setLastSyncAt(now);
      setLastSyncAtState(now);
      return page;
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  // Ruolo di chi guarda, dalla sessione — `UNKNOWN` (server più nuovo con un
  // ruolo che questa build non conosce) degrada a `member`: il meno
  // privilegiato dei due, mai il contrario.
  const viewerRole: "admin" | "member" =
    user !== null && !isUnknown(user.role) && user.role === "admin" ? "admin" : "member";

  const projectsById = new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name]));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("mobile.tabs.inbox")}</Text>
        <Text style={styles.subtitle}>
          {query.isPending
            ? t("mobile.inbox.header.loading")
            : query.isError
              ? ""
              : subtitleFor(sectionize(query.data.items, { role: viewerRole }), viewerRole, t)}
        </Text>
      </View>

      {query.isPending ? (
        <View style={styles.skeletonList} testID="inbox-skeleton">
          <Skeleton height={90} width="35%" />
          <Skeleton height={150} />
          <Skeleton height={150} />
          <Skeleton height={150} />
        </View>
      ) : query.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("mobile.inbox.loadError.title")}</Text>
          <GhostButton label={t("mobile.inbox.loadError.retry")} onPress={() => void query.refetch()} testID="inbox-retry" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={colors.signal} />
          }
        >
          {!online && (
            <View style={styles.bannerWrap}>
              <OfflineBanner lastSyncAt={lastSyncAt} />
            </View>
          )}

          {notificationsDenied && (
            <View style={styles.notifCard} testID="inbox-notifications-denied">
              <Text style={styles.notifBadge}>{t("mobile.inbox.notifications.badgeLabel")}</Text>
              <Text style={styles.notifTitle}>{t("mobile.inbox.notifications.title")}</Text>
              <Text style={styles.notifBody}>{t("mobile.inbox.notifications.body")}</Text>
              <View style={styles.notifButton}>
                <GhostButton
                  label={t("mobile.inbox.notifications.settingsButton")}
                  onPress={() => void Linking.openSettings()}
                  testID="inbox-notifications-settings"
                />
              </View>
            </View>
          )}

          <InboxSectionsList
            sections={sectionize(query.data.items, { role: viewerRole })}
            projectsById={projectsById}
          />
        </ScrollView>
      )}
    </View>
  );
}

function subtitleFor(
  sections: InboxSections,
  viewerRole: "admin" | "member",
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const isEmpty = SECTION_ORDER.every(({ key }) => sections[key].length === 0);
  if (isEmpty) return t("mobile.inbox.header.empty");
  const total = sections.blocksYou.length + sections.onlyYouMaintainer.length;
  if (viewerRole === "admin") {
    return t("mobile.inbox.header.subtitleMaintainer", { count: total, onlyYours: sections.onlyYouMaintainer.length });
  }
  return t("mobile.inbox.header.subtitle", { count: total });
}

function InboxSectionsList({
  sections,
  projectsById,
}: {
  sections: InboxSections;
  projectsById: Map<string, string>;
}) {
  const { t } = useTranslation();
  const isEmpty = SECTION_ORDER.every(({ key }) => sections[key].length === 0);

  if (isEmpty) {
    return (
      <View style={styles.emptyState} testID="inbox-empty">
        <View style={styles.emptyMark} />
        <Text style={styles.emptyTitle}>{t("mobile.inbox.empty.title")}</Text>
        <Text style={styles.emptyBody}>{t("mobile.inbox.empty.body")}</Text>
      </View>
    );
  }

  return (
    <>
      {SECTION_ORDER.map(({ key, labelKey, amber }) => {
        const items = sections[key];
        if (items.length === 0) return null;
        return (
          <View key={key} style={styles.section}>
            <SectionLabel style={amber ? styles.sectionLabelAmber : undefined}>
              {t(labelKey, { count: items.length })}
            </SectionLabel>
            <View style={styles.cardList}>
              {items.map((item) => (
                <InboxCard key={item.id} item={item} projectName={resolveProjectName(item, projectsById)} />
              ))}
            </View>
          </View>
        );
      })}
    </>
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
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    marginTop: 2,
  },
  scrollContent: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  bannerWrap: {
    marginBottom: 4,
  },
  skeletonList: {
    gap: 8,
    padding: 16,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  notifCard: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 4,
    padding: 14,
  },
  notifBadge: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  notifTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 6,
  },
  notifBody: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  notifButton: {
    marginTop: 10,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 64,
  },
  emptyMark: {
    backgroundColor: colors.signal,
    height: 14,
    width: 14,
  },
  emptyTitle: {
    color: colors.fg,
    fontSize: 17,
    fontWeight: "600",
    marginTop: 16,
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    marginTop: 6,
    textAlign: "center",
  },
  section: {
    gap: 8,
  },
  sectionLabelAmber: {
    color: colors.signal,
  },
  cardList: {
    gap: 8,
  },
});
