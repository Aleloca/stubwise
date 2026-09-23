import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import type { Reader, ServerDetail } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { CpuSparkline } from "../../components/monitor/CpuSparkline";
import { serverKeys } from "../../lib/query-keys";
import { agoLabel, formatBytes, memoryReading, sampleAge, serverStatusKey, usedPct } from "../../lib/server-health";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { usePullToRefresh } from "../../components/PullToRefresh";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * IL CRUSCOTTO DI UN SERVER (23 set 2026, hub di progetto, tappa 3):
 * decisione del maintainer, «completo, come il web» — CPU con lo storico,
 * memoria, dischi per mount, servizi scoperti, versione dell'agente,
 * controlli su/giù. Il monitor lo guarda chi amministra le macchine, e avere
 * tutto sul telefono evita di aprire il portatile.
 *
 * ⚠️ DUE modi in cui un cruscotto mente, e questa schermata li evita:
 *
 * 1. **Numeri vecchi mostrati come attuali.** `metricsAt` dice quando è stato
 *    preso l'ultimo campione; oltre 2× l'intervallo di campionamento (la
 *    stessa soglia del web) la schermata lo DICE, in cima e in ambra.
 * 2. **Zeri inventati.** Un server che non ha mai mandato campioni ha liste
 *    vuote e `null` ovunque: è `never_connected`, e si dice così — niente
 *    sezioni con «0% di CPU» o «0 GB di memoria».
 *
 * **Sola lettura**: soglie, controlli e chiave dell'agente si configurano dal
 * web.
 */
export function ServerScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "Server">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { serverId, projectName } = route.params;

  const query = useQuery({
    queryKey: serverKeys.detail(serverId),
    queryFn: () => {
      if (!client) throw new Error("ServerScreen richiede un client autenticato");
      return client.servers.get(serverId);
    },
    enabled: client !== null,
    staleTime: 30_000,
  });

  const server = query.data;

  const refreshControl = usePullToRefresh([serverKeys.detail(serverId)], "server-refresh");

  return (
    <View style={styles.container}>
      <ScrollView
        refreshControl={refreshControl}
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={server?.name ?? t("mobile.projects.server.titleFallback")}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
          titleNumberOfLines={2}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="server-skeleton">
            <Skeleton height={60} />
            <Skeleton height={120} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="server-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.server.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.server.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="server-retry"
            />
          </View>
        ) : server === undefined ? null : (
          <Dashboard server={server} />
        )}
      </ScrollView>
    </View>
  );
}

function Dashboard({ server }: { server: Reader<ServerDetail> }) {
  const { t } = useTranslation();
  const now = Date.now();
  const age = sampleAge(server.metricsAt, server.sampleIntervalSeconds, now);
  const memory = memoryReading(server);
  const lastCpu = server.recentCpu.at(-1);

  return (
    <>
      <SectionLabel>{t("mobile.projects.server.sections.state")}</SectionLabel>
      {/*
        Griglia 2×2 e non quattro righe (23 set 2026, richiesta del
        maintainer): sono quattro valori corti, e in colonna occupavano mezzo
        schermo prima di arrivare ai numeri. Le celle dicono da sole dove
        stanno (`left`/`top`) perché i bordi vanno SOLO fra le celle — una
        griglia con il bordo anche sul contorno esterno raddoppierebbe quello
        della card.
      */}
      <View style={[styles.card, styles.grid]}>
        <Field
          label={t("mobile.projects.server.fields.status")}
          value={t(serverStatusKey(server.status))}
          danger={server.status === "offline"}
          testID="server-status"
          left
          top
        />
        <Field
          label={t("mobile.projects.server.fields.hostname")}
          value={server.hostname ?? t("mobile.projects.server.fields.notYet")}
          top
        />
        <Field
          label={t("mobile.projects.server.fields.agentVersion")}
          value={server.agentVersion ?? t("mobile.projects.server.fields.notYet")}
          testID="server-agent-version"
          left
        />
        <Field
          label={t("mobile.projects.server.fields.sample")}
          value={
            age.kind === "none"
              ? t("mobile.projects.server.sample.none")
              : t("mobile.projects.server.sample.at", { ago: agoLabel(age.at, t, now) })
          }
          warn={age.kind === "stale"}
          testID="server-sample"
        />
      </View>

      {/*
        ⚠️ Il campione è VECCHIO: i numeri qui sotto potrebbero non essere più
        veri. Si dice PRIMA dei numeri, non in fondo — chi guarda deve saperlo
        prima di leggerli.
      */}
      {age.kind === "stale" && (
        <Text style={styles.staleWarning} testID="server-stale-warning">
          {t("mobile.projects.server.staleWarning", { ago: agoLabel(age.at, t, now) })}
        </Text>
      )}

      {age.kind === "none" ? (
        <Text style={styles.neverBody} testID="server-never-connected">
          {t("mobile.projects.server.neverConnectedBody")}
        </Text>
      ) : (
        <>
          <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.server.sections.cpu")}</SectionLabel>
          <View style={[styles.card, styles.cardPadded]}>
            <Text style={styles.bigValue} testID="server-cpu-now">
              {lastCpu === undefined ? t("mobile.projects.server.noValue") : `${Math.round(lastCpu)}%`}
            </Text>
            <CpuSparkline values={server.recentCpu} testID="server-cpu-sparkline" />
          </View>

          <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.server.sections.memory")}</SectionLabel>
          <View style={[styles.card, styles.cardPadded]}>
            {memory.kind === "known" ? (
              <>
                <Text style={styles.bigValue} testID="server-memory">
                  {t("mobile.projects.server.usage", {
                    used: formatBytes(memory.usedBytes),
                    total: formatBytes(memory.totalBytes),
                  })}
                </Text>
                {memory.pct !== null && <UsageBar pct={memory.pct} />}
              </>
            ) : (
              // `unavailable`: il server che risponde è più vecchio di questa
              // app e il campo non lo manda. Si dice, mai «0 GB».
              <Text style={styles.muted} testID="server-memory-unavailable">
                {t("mobile.projects.server.memoryUnavailable")}
              </Text>
            )}
          </View>

          <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.server.sections.disks")}</SectionLabel>
          <View style={styles.card}>
            {server.disks.length === 0 ? (
              <Text style={[styles.muted, styles.cardPadded]}>{t("mobile.projects.server.noDisks")}</Text>
            ) : (
              server.disks.map((disk, index) => {
                const pct = usedPct(disk.usedBytes, disk.totalBytes);
                return (
                  <View
                    key={disk.mount}
                    style={[styles.diskRow, index < server.disks.length - 1 && styles.rowBorder]}
                    testID={`server-disk-${disk.mount}`}
                  >
                    <View style={styles.diskTop}>
                      <Text style={styles.mono}>{disk.mount}</Text>
                      <Text style={styles.monoFaint}>
                        {t("mobile.projects.server.usage", {
                          used: formatBytes(disk.usedBytes),
                          total: formatBytes(disk.totalBytes),
                        })}
                      </Text>
                    </View>
                    {pct !== null && <UsageBar pct={pct} />}
                  </View>
                );
              })
            )}
          </View>
        </>
      )}

      <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.server.sections.checks")}</SectionLabel>
      <View style={[styles.card, styles.cardPadded]}>
        <Text
          style={[styles.mono, server.checksDown > 0 && styles.danger]}
          testID="server-checks"
        >
          {t("mobile.projects.monitor.checks", { up: server.checksUp, down: server.checksDown })}
        </Text>
      </View>

      {age.kind !== "none" && (
        <>
          <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.server.sections.services")}</SectionLabel>
          <View style={styles.card}>
            {server.services.length === 0 ? (
              <Text style={[styles.muted, styles.cardPadded]}>{t("mobile.projects.server.noServices")}</Text>
            ) : (
              server.services.map((service, index) => (
                <View
                  key={`${isUnknown(service.source) ? "?" : service.source}-${service.name}`}
                  style={[styles.serviceRow, index < server.services.length - 1 && styles.rowBorder]}
                  testID={`server-service-${service.name}`}
                >
                  <View style={styles.diskTop}>
                    <Text style={styles.serviceName} numberOfLines={1}>
                      {service.name}
                    </Text>
                    <Text style={styles.monoFaint}>{service.state}</Text>
                  </View>
                  <Text style={styles.monoFaint}>
                    {[
                      isUnknown(service.source) ? null : service.source,
                      service.cpuPct === null ? null : `CPU ${Math.round(service.cpuPct * 10) / 10}%`,
                      service.memBytes === null ? null : formatBytes(service.memBytes),
                      service.restarts === null
                        ? null
                        : t("mobile.projects.server.restarts", { count: service.restarts }),
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </Text>
                </View>
              ))
            )}
          </View>
        </>
      )}

      <Text style={styles.readOnlyHint}>{t("mobile.projects.server.readOnlyHint")}</Text>
    </>
  );
}

function UsageBar({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <View style={styles.bar}>
      <View style={[styles.barFill, { width: `${clamped}%` }]} />
    </View>
  );
}

/**
 * Una cella della griglia 2×2 dello stato. `left` = colonna di sinistra
 * (bordo a destra), `top` = riga di sopra (bordo sotto): i bordi stanno solo
 * FRA le celle.
 *
 * `numberOfLines={2}` sul valore: un hostname vero può essere lungo
 * (`srv-prod-01.azienda.internal`) e in mezza larghezza deve andare a capo
 * una volta, non allargare la cella né sparire del tutto.
 */
function Field({
  label,
  value,
  left = false,
  top = false,
  danger = false,
  warn = false,
  testID,
}: {
  label: string;
  value: string;
  left?: boolean;
  top?: boolean;
  danger?: boolean;
  warn?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.field, left && styles.cellRight, top && styles.rowBorder]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text
        style={[styles.fieldValue, danger && styles.danger, warn && styles.warn]}
        numberOfLines={2}
        testID={testID}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  sectionLabel: {
    marginTop: 8,
  },
  skeletonList: {
    gap: 12,
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
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  cardPadded: {
    gap: 8,
    padding: 14,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  field: {
    gap: 3,
    paddingHorizontal: 16,
    paddingVertical: 10,
    width: "50%",
  },
  cellRight: {
    borderRightColor: colors.line,
    borderRightWidth: 1,
  },
  rowBorder: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  fieldLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  fieldValue: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  bigValue: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 18,
  },
  muted: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  mono: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  monoFaint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  diskRow: {
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  diskTop: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  serviceRow: {
    gap: 3,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  serviceName: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  bar: {
    backgroundColor: colors.ink800,
    borderRadius: 2,
    height: 4,
    overflow: "hidden",
  },
  barFill: {
    backgroundColor: colors.signal,
    height: 4,
  },
  staleWarning: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    lineHeight: 17,
  },
  neverBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  danger: {
    color: colors.danger,
  },
  warn: {
    color: colors.signal,
  },
  readOnlyHint: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
});
