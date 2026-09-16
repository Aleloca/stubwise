import notifee, { AuthorizationStatus } from "@notifee/react-native";
import { isUnknown } from "@stubwise/shared";
import type { InboxItem, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { InboxStackParamList } from "../../app/navigation";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { InboxCard } from "../../components/inbox/InboxCard";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { inboxKeys } from "../../lib/inbox-mutations";
import type { InboxSections } from "../../lib/inbox-sections";
import { sectionize } from "../../lib/inbox-sections";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Margine di scorrimento in fondo (Task 6, design §"la barra nativa"): oltre
 * al respiro che il layout aveva già, va aggiunta l'altezza VERA della tab
 * bar (`useBottomTabBarHeight`, variabile per piattaforma/OS) — senza,
 * l'ultima riga resta nascosta sotto il vetro. Costante, non letta da
 * `styles.scrollContent` (`StyleSheet.create` può restituire un riferimento
 * opaco, non l'oggetto vero, a seconda della piattaforma — leggerne indietro
 * un campo non è affidabile).
 */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/** Ordine di rendering delle quattro sezioni, come nel canvas (`1b`/`1c`). */
const SECTION_ORDER: { key: keyof InboxSections; labelKey: string; amber: boolean }[] = [
  { key: "blocksYou", labelKey: "mobile.inbox.sections.blocksYou", amber: true },
  { key: "onlyYouMaintainer", labelKey: "mobile.inbox.sections.onlyYouMaintainer", amber: true },
  { key: "waitingOthers", labelKey: "mobile.inbox.sections.waitingOthers", amber: false },
  { key: "fromProjects", labelKey: "mobile.inbox.sections.fromProjects", amber: false },
];

/**
 * LE TRE SCHEDE dell'inbox (16 set 2026, scelta del maintainer, stesso
 * meccanismo dello scambio in MBX).
 *
 * Le sezioni esistevano già tutte e quattro: qui si decide solo QUALI si
 * vedono insieme. Il motivo sono i numeri veri — al 16 set 2026, 33 notifiche
 * chiedono una decisione e 96 non chiedono niente: le prime annegavano nelle
 * seconde in un elenco unico.
 *
 * ⚠️ «In attesa di altri» ha una scheda SUA e non sta con le tue: è lavoro
 * che hai avviato tu e che è fermo da qualcun altro — né azionabile ora, né
 * una notizia di sfondo. Avevo raccomandato due schede (costa due tap in più
 * su una sezione spesso vuota); il maintainer ha scelto tre, per non
 * mescolare «posso agire» con «sto aspettando».
 */
const INBOX_TABS: { tab: InboxTab; i18nKey: string; sections: (keyof InboxSections)[] }[] = [
  { tab: "yours", i18nKey: "mobile.inbox.tabs.yours", sections: ["blocksYou", "onlyYouMaintainer"] },
  { tab: "waiting", i18nKey: "mobile.inbox.tabs.waiting", sections: ["waitingOthers"] },
  { tab: "projects", i18nKey: "mobile.inbox.tabs.projects", sections: ["fromProjects"] },
];

type InboxTab = "yours" | "waiting" | "projects";

/** Nome del progetto della riga: risolto dalla lista progetti, o — solo sul pulse — dal payload dell'evento. */
function resolveProjectName(item: Reader<InboxItem>, projectsById: Map<string, string>): string | undefined {
  if (item.projectId !== null) return projectsById.get(item.projectId);
  return item.pulse?.projectName;
}

/**
 * Schermata Inbox (canvas `1b`/`1c`/`1f`/`1g`/`1h`): quattro sezioni per
 * ruolo, stato vuoto "Tutto gestito.", skeleton al primo caricamento e — non
 * bloccante — l'avviso di notifiche disattivate.
 *
 * Il banner offline (Task 13/14) era qui, ora è GLOBALE (Task 20,
 * `app/providers.tsx`, top bar sopra ogni tab) — vedi il commento lì sul
 * perché: non solo l'Inbox va offline. Niente banner locale, quindi, o
 * comparirebbe due volte.
 */
export function InboxScreen({ navigation }: NativeStackScreenProps<InboxStackParamList, "List">) {
  const [tab, setTab] = useState<InboxTab>("yours");
  const { t } = useTranslation();
  const { client, user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const [notificationsDenied, setNotificationsDenied] = useState(false);

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
    queryFn: () => {
      if (!client) throw new Error("InboxScreen richiede un client autenticato");
      return client.inbox.list();
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

  // Task 7 (App M1+M2, 11 set 2026): un solo `ScrollView` per tutta la
  // schermata — l'header (ora `ScreenHeader`) è il suo PRIMO figlio, non più
  // un fratello fermo sopra di lui, e i tre stati (caricamento/errore/dati)
  // sono contenuto scorrevole, non contenitori alternativi. `paddingBottom`
  // aggiunge l'altezza della tab bar nativa (Task 6, `useBottomTabBarHeight`)
  // a quella già prevista dal design: senza, l'ultima riga resta nascosta
  // sotto il vetro della barra.
  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={colors.signal} />
        }
      >
        <ScreenHeader
          title={t("mobile.tabs.inbox")}
          subtitle={
            query.isPending
              ? t("mobile.inbox.header.loading")
              : query.isError
                ? ""
                : subtitleFor(sectionize(query.data.items, { role: viewerRole }), viewerRole, t)
          }
        />

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
          <>
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

            <InboxTabs
              tab={tab}
              onChange={setTab}
              sections={sectionize(query.data.items, { role: viewerRole })}
            />

            <InboxSectionsList
              sections={sectionize(query.data.items, { role: viewerRole })}
              only={INBOX_TABS.find((option) => option.tab === tab)!.sections}
              projectsById={projectsById}
              onOpenProposal={(id) => navigation.navigate("Proposal", { id })}
            />
          </>
        )}
      </ScrollView>
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
  only,
  projectsById,
  onOpenProposal,
}: {
  sections: InboxSections;
  /** Le sole sezioni della scheda attiva (16 set 2026). */
  only: (keyof InboxSections)[];
  projectsById: Map<string, string>;
  /** Apre la pagina della decisione di una proposta Google (16 set 2026). */
  onOpenProposal: (id: string) => void;
}) {
  const { t } = useTranslation();
  const visible = SECTION_ORDER.filter(({ key }) => only.includes(key));
  const isEmpty = visible.every(({ key }) => sections[key].length === 0);

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
      {visible.map(({ key, labelKey, amber }) => {
        const items = sections[key];
        if (items.length === 0) return null;
        return (
          <View key={key} style={styles.section}>
            <SectionLabel style={amber ? styles.sectionLabelAmber : undefined}>
              {t(labelKey, { count: items.length })}
            </SectionLabel>
            <View style={styles.cardList}>
              {items.map((item) => (
                <InboxCard
                  key={item.id}
                  item={item}
                  projectName={resolveProjectName(item, projectsById)}
                  onOpenProposal={onOpenProposal}
                />
              ))}
            </View>
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  // Stessi stili dello scambio di MBX: due estetiche diverse per lo stesso
  // gesto sarebbero due cose da tenere allineate.
  switchRow: {
    flexDirection: "row",
    gap: 8,
  },
  switchOption: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 8,
  },
  switchOptionActive: {
    borderColor: colors.signalDim,
  },
  switchLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textAlign: "center",
    textTransform: "uppercase",
  },
  switchLabelActive: {
    color: colors.signal,
  },
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  scrollContent: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
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
    fontFamily: fontFamily.sansSemiBold,
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
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 6,
  },
  notifBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
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
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 17,
    fontWeight: "600",
    marginTop: 16,
  },
  emptyBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
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

/** Lo scambio fra le tre schede, con quante voci ha ciascuna. */
function InboxTabs({
  tab,
  onChange,
  sections,
}: {
  tab: InboxTab;
  onChange: (tab: InboxTab) => void;
  sections: InboxSections;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.switchRow} testID="inbox-switch">
      {INBOX_TABS.map((option) => {
        const active = option.tab === tab;
        // Il CONTEGGIO nell'etichetta: è il punto dell'intera divisione —
        // sapere da che parte sta il lavoro senza cambiare scheda.
        const count = option.sections.reduce((sum, key) => sum + sections[key].length, 0);
        return (
          <Pressable
            key={option.tab}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.tab)}
            style={[styles.switchOption, active && styles.switchOptionActive]}
            testID={`inbox-tab-${option.tab}`}
          >
            <Text style={[styles.switchLabel, active && styles.switchLabelActive]}>
              {t(option.i18nKey, { count })}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
