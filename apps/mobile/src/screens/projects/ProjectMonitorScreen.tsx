import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Reader, ServerView } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { serverKeys } from "../../lib/query-keys";
import { agoLabel, serverIsBroken, serverStatusKey } from "../../lib/server-health";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * IL MONITOR DI UN PROGETTO (23 set 2026, hub di progetto, tappa 3): i server
 * associati al progetto, una card ciascuno, e il tap apre il cruscotto.
 *
 * **Sola lettura, anche per un maintainer**: registrare un server, cambiarne
 * soglie e controlli, rigenerare la chiave si fa da un computer.
 */
export function ProjectMonitorScreen({
  navigation,
  route,
}: NativeStackScreenProps<ProjectsStackParamList, "ProjectMonitor">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { projectId, projectName } = route.params;

  const query = useQuery({
    queryKey: serverKeys.forProject(projectId),
    queryFn: () => {
      if (!client) throw new Error("ProjectMonitorScreen richiede un client autenticato");
      return client.servers.list(projectId);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });

  const servers = query.data ?? [];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.projects.monitor.title")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="project-monitor-skeleton">
            <Skeleton height={80} />
            <Skeleton height={80} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="project-monitor-error">
            <Text style={styles.title}>{t("mobile.projects.monitor.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.monitor.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="project-monitor-retry"
            />
          </View>
        ) : servers.length === 0 ? (
          <View style={styles.centered} testID="project-monitor-empty">
            <Text style={styles.title}>{t("mobile.projects.monitor.empty.title")}</Text>
            <Text style={styles.emptyBody}>{t("mobile.projects.monitor.empty.body")}</Text>
          </View>
        ) : (
          servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              onPress={() => navigation.navigate("Server", { serverId: server.id, projectName })}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function ServerCard({ server, onPress }: { server: Reader<ServerView>; onPress: () => void }) {
  const { t } = useTranslation();
  const broken = serverIsBroken(server);
  const neverConnected = server.status === "never_connected";
  const lastCpu = server.recentCpu.at(-1);

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.card} testID={`server-card-${server.id}`}>
      <View style={styles.cardTop}>
        <Text style={styles.cardName} numberOfLines={1}>
          {server.name}
        </Text>
        <Text
          style={[styles.cardStatus, server.status === "offline" && styles.danger]}
          testID={`server-card-status-${server.id}`}
        >
          {t(serverStatusKey(server.status))}
        </Text>
      </View>
      {server.hostname !== null && <Text style={styles.cardMeta}>{server.hostname}</Text>}
      {/*
        ⚠️ Un server mai connesso non ha NUMERI: niente «CPU 0%», che sarebbe
        un valore falso. Lo stato qui sopra dice già tutto.
      */}
      {!neverConnected && (
        <Text style={[styles.cardMeta, broken && server.checksDown > 0 && styles.danger]} testID={`server-card-summary-${server.id}`}>
          {[
            lastCpu !== undefined ? t("mobile.projects.monitor.cpuNow", { pct: Math.round(lastCpu) }) : null,
            t("mobile.projects.monitor.checks", { up: server.checksUp, down: server.checksDown }),
            server.lastSeenAt !== null ? t("mobile.projects.monitor.lastSeen", { ago: agoLabel(server.lastSeenAt, t) }) : null,
          ]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 10,
    padding: 16,
    paddingBottom: 40,
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
  title: {
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
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 4,
    padding: 14,
  },
  cardTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  cardName: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  cardStatus: {
    color: colors.muted,
    flexShrink: 0,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardMeta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  danger: {
    color: colors.danger,
  },
});
