import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ProjectRowsCard, type ProjectGroupRowProps } from "../../components/projects/ProjectRowsCard";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { IN_PROGRESS_TICKET_STATUSES, OPEN_TICKET_STATUSES } from "../../lib/project-tickets";
import { ticketKeys } from "../../lib/query-keys";
import { ticketHeading, ticketStatusLabel } from "../../lib/ticket-labels";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.list.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * I tre filtri in cima (design §5). «APERTI» è il DEFAULT ed è lo stesso
 * insieme che conta la sezione dell'hub — vedi `OPEN_TICKET_STATUSES`: chi
 * tocca «vedi» sul numero deve trovare quel numero, non un altro.
 * «TUTTI» non filtra affatto, quindi include anche chiusi e conclusi.
 */
const FILTERS = [
  { key: "open", i18nKey: "mobile.projects.tickets.filters.open" },
  { key: "inProgress", i18nKey: "mobile.projects.tickets.filters.inProgress" },
  { key: "all", i18nKey: "mobile.projects.tickets.filters.all" },
] as const;

type TicketFilterKey = (typeof FILTERS)[number]["key"];

/**
 * L'ELENCO DEI TICKET DI UN PROGETTO (22 set 2026, hub di progetto, design
 * §5).
 *
 * **È l'unica delle tre aree del lavoro senza niente da riusare**: un elenco
 * ticket non esisteva in nessun punto dell'app — lo stack Projects aveva solo
 * la lista, il dettaglio e il Lavoro di UN ticket. Backlog e inbox montano
 * invece i componenti dei loro tab, che esistevano già.
 *
 * Le righe riusano `ticketHeading` (`lib/ticket-labels.ts`) — `#numero ·
 * priorità · tipo · aperto …` — così questo elenco e la sezione dell'hub
 * dicono la stessa cosa nello stesso modo.
 */
export function ProjectTicketsScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "Tickets">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;
  const [filter, setFilter] = useState<TicketFilterKey>("open");

  const query = useQuery({
    // Sotto il prefisso `["tickets"]`: vedi il docblock di `ticketKeys`.
    queryKey: ticketKeys.list(projectId, filter),
    queryFn: () => {
      if (!client) throw new Error("ProjectTicketsScreen richiede un client autenticato");
      // `all` non manda nessuno stato: il server senza filtro torna TUTTO,
      // chiusi compresi — che è ciò che quella parola promette.
      const statuses =
        filter === "open" ? OPEN_TICKET_STATUSES : filter === "inProgress" ? IN_PROGRESS_TICKET_STATUSES : undefined;
      return client.tickets.list({ projectId, ...(statuses !== undefined ? { statuses } : {}) });
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  // L'ORA della lettura, una sola per tutta la schermata: l'età dei ticket si
  // conta da qui, come nel dettaglio progetto.
  const now = Date.now();
  const items = query.data?.items ?? [];

  const rows: ProjectGroupRowProps[] = items.map((item) => ({
    rowKey: item.id,
    heading: ticketHeading({ ticketNumber: item.number, priority: item.priority, type: item.type, createdAt: item.createdAt }, t, now),
    title: item.title,
    trailing: ticketStatusLabel(item.status, t),
    trailingTone: "muted",
    onPress: () => navigation.navigate("Ticket", { id: item.id, backLabel: projectName }),
    testID: `project-ticket-${item.id}`,
  }));

  const refreshControl = usePullToRefresh([ticketKeys.list(projectId, filter)], "project-tickets-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.list, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.tickets.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        <View style={styles.chipsRow}>
          {FILTERS.map((option) => {
            const active = filter === option.key;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(option.key)}
                style={[styles.chip, active && styles.chipActive]}
                testID={`project-tickets-filter-${option.key}`}
              >
                <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{t(option.i18nKey)}</Text>
              </Pressable>
            );
          })}
        </View>

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-tickets-skeleton">
            <Skeleton height={60} />
            <Skeleton height={60} />
            <Skeleton height={60} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-tickets-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.tickets.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.tickets.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-tickets-retry"
            />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.centered} testID="project-tickets-empty">
            <Text style={styles.emptyTitle}>{t("mobile.projects.tickets.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.tickets.empty.body")}</Text>
          </View>
        ) : (
          <ProjectRowsCard rows={rows} />
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
  chipsRow: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    borderColor: colors.lineStrong,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: {
    borderColor: colors.signalDim,
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  chipLabelActive: {
    color: colors.signal,
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
