import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { InboxCard } from "../../components/inbox/InboxCard";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { inboxKeys } from "../../lib/query-keys";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.list.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * Chiave di query delle notifiche APERTE del viewer su un progetto.
 *
 * Costruita DA `inboxKeys.all` e non scritta a mano: è ciò che la fa
 * invalidare da ogni decisione d'inbox, senza che quelle mutazioni debbano
 * conoscerla. Vedi il docblock di `ticketKeys` per il perché questa è la
 * forma giusta e un namespace proprio no.
 */
export const projectInboxKey = (projectId: string) => [...inboxKeys.all, "list", "project", projectId] as const;

/**
 * LE NOTIFICHE DEL VIEWER SU UN PROGETTO (22 set 2026, hub di progetto,
 * design §5).
 *
 * ⚠️ **L'inbox è PER UTENTE, e il titolo lo dice.** Il filtro di progetto non
 * allarga niente: mostra le notifiche di CHI GUARDA su quel progetto, mai
 * quelle dei colleghi. Chiamarla «le notifiche del progetto» suggerirebbe il
 * contrario, e sarebbe una promessa che il server non mantiene (né deve).
 *
 * ⚠️ **La lista non è riscritta**: monta `InboxCard`, lo STESSO componente
 * del tab INB — era già un componente a sé, quindi qui non c'è stato niente
 * da estrarre.
 *
 * La pagina della decisione è la STESSA `GoogleProposalScreen` del tab INB,
 * registrata anche nello stack `Projects` (22 set 2026): deciderla non esce
 * da qui, quindi l'indietro riporta a questo elenco.
 *
 * Quello che questa schermata NON ha, rispetto al tab: le tre schede
 * (tue / in attesa di altri / dai progetti) e la sezionatura per ruolo. Una
 * sola area di un solo progetto è un elenco corto, e le schede esistono per
 * separare 33 decisioni da 96 notizie — un problema che qui non si pone. Se
 * si porrà, `sectionize` è già lì.
 */
export function ProjectInboxScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "ProjectInbox">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  const query = useQuery({
    queryKey: projectInboxKey(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectInboxScreen richiede un client autenticato");
      return client.inbox.list({ projectId });
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const items = query.data?.items ?? [];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.list, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={colors.signal} />
        }
      >
        <ScreenHeader
          title={t("mobile.projects.inbox.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-inbox-skeleton">
            <Skeleton height={150} />
            <Skeleton height={150} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-inbox-error">
            <Text style={styles.errorTitle}>{t("mobile.inbox.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.inbox.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-inbox-retry"
            />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.centered} testID="project-inbox-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.inbox.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.inbox.empty.body")}</Text>
          </View>
        ) : (
          <View style={styles.cards}>
            {items.map((item) => (
              <InboxCard
                key={item.id}
                item={item}
                projectName={projectName}
                // DENTRO lo stack `Projects`: vedi il gemello in
                // `ProjectBacklogScreen`.
                onOpenProposal={(id) => navigation.navigate("Proposal", { id })}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  list: {
    gap: 12,
    padding: 16,
    paddingBottom: 40,
  },
  cards: {
    gap: 10,
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
});
